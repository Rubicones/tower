import { ATC_CONFIG } from "./config";

/**
 * How thoroughly a candidate tape position is auditioned before playback:
 *
 * - `none` — accept wherever the random seek landed.
 * - `avoid-silence` — re-seek only away from dead air (below the silence floor).
 * - `require-voice` — re-seek until the spot sounds like an actual transmission
 *   (speech energy, not carrier hiss / static). Used for the very first tape so
 *   the listener hears talking as soon as they hit play.
 */
export type PrerollMode = "none" | "avoid-silence" | "require-voice";

/** Per-frame features sampled during the muted pre-roll listen. */
export interface FrameFeatures {
  /** Pre-gain RMS level, dBFS. */
  db: number;
  /** Share of energy sitting in the speech band (0–1). */
  speechRatio: number;
  /** Spectral flatness of the frame (0–1); ~1 is white-noise-like. */
  flatness: number;
}

/** The outcome of auditioning a spot. */
export interface Verdict {
  /** Any signal at all above the silence floor. */
  hasSignal: boolean;
  /** A real transmission (speech-like), not hiss / static / dead air. */
  isVoice: boolean;
  /** Voice-likeness, higher is better; used to keep the best of N attempts. */
  score: number;
}

const EPS = 1e-10;

/** dBFS magnitude -> linear power. `-Infinity` (empty bin) maps to 0. */
function dbToPower(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 10) : 0;
}

/**
 * Reduce one FFT frame (dB magnitudes + a bin→Hz mapper) to the two spectral
 * features the classifier needs: how concentrated the energy is in the speech
 * band, and how flat (noise-like) the spectrum is.
 */
export function spectralFeatures(
  db: number,
  spectrum: Float32Array,
  freqOfBin: (index: number) => number,
): FrameFeatures {
  const v = ATC_CONFIG.voice;
  let speechPower = 0;
  let totalPower = 0;

  // Spectral flatness accumulators (geometric vs arithmetic mean of power).
  let logSum = 0;
  let linSum = 0;
  let flatBins = 0;

  for (let i = 0; i < spectrum.length; i++) {
    const freq = freqOfBin(i);
    if (freq < v.totalLowHz || freq > v.totalHighHz) continue;
    const power = dbToPower(spectrum[i]);
    totalPower += power;
    if (freq >= v.bandLowHz && freq <= v.bandHighHz) speechPower += power;
    if (freq >= v.flatnessLowHz && freq <= v.flatnessHighHz) {
      logSum += Math.log(power + EPS);
      linSum += power + EPS;
      flatBins += 1;
    }
  }

  const speechRatio = totalPower > 0 ? speechPower / totalPower : 0;
  const flatness =
    flatBins > 0
      ? Math.exp(logSum / flatBins) / (linSum / flatBins)
      : 1;

  return { db, speechRatio, flatness };
}

/**
 * Aggregate a listen (several frames) into a verdict. A spot is "voice" when it
 * clears the silence floor, its energy is concentrated in the speech band, and
 * its spectrum isn't noise-flat. The score ranks spots so the caller can fall
 * back to the most voice-like one if none clears the bar.
 */
export function classifyListen(frames: FrameFeatures[]): Verdict {
  if (frames.length === 0) {
    return { hasSignal: false, isVoice: false, score: -Infinity };
  }

  let peakDb = -Infinity;
  for (const f of frames) peakDb = Math.max(peakDb, f.db);
  const hasSignal = peakDb >= ATC_CONFIG.silence.thresholdDb;

  // Weight each frame's features by how loud it is, so quiet inter-word gaps
  // don't drag the speech-band ratio down toward the noise floor.
  let weightSum = 0;
  let speechSum = 0;
  let flatSum = 0;
  for (const f of frames) {
    const weight = dbToPower(f.db);
    weightSum += weight;
    speechSum += f.speechRatio * weight;
    flatSum += f.flatness * weight;
  }
  const avgSpeechRatio = weightSum > 0 ? speechSum / weightSum : 0;
  const avgFlatness = weightSum > 0 ? flatSum / weightSum : 1;

  const v = ATC_CONFIG.voice;
  const isVoice =
    hasSignal &&
    avgSpeechRatio >= v.minSpeechBandRatio &&
    avgFlatness <= v.maxFlatness;

  // Higher when energy is in-band and non-flat; -Infinity for true silence so
  // dead air never wins the "best candidate" tie-break.
  const score = hasSignal ? avgSpeechRatio - avgFlatness : -Infinity;

  return { hasSignal, isVoice, score };
}
