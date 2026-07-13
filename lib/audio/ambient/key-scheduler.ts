import { Note } from "tonal";
import { randRange } from "../random";
import type { Transport } from "../types";
import {
  MAJOR_FLAVORS,
  MINOR_FLAVORS,
  commonChromas,
  tonicChroma,
  type HarmonyEngine,
  type KeyState,
  type ScaleName,
} from "./harmony-engine";

/** How a layer set is asked to drift from the current key to a new one. */
export interface Modulator {
  /**
   * Begin a smooth, staggered modulation into `target`, holding `pivotChroma`
   * (a common tone) through the transition and ramping over `rampSeconds`.
   */
  beginModulation(
    target: KeyState,
    pivotChroma: number | null,
    rampSeconds: number,
  ): void;
}

const PITCH_CLASSES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

/** Minimum / maximum seconds between modulations. */
const INTERVAL_MIN_S = 60;
const INTERVAL_MAX_S = 120;
/** Frequency ramp length for the drift (smooth, never a hard cut). */
const RAMP_MIN_S = 10;
const RAMP_MAX_S = 20;

type Family = "major" | "minor";

interface Candidate {
  key: KeyState;
  weight: number;
}

function familyOf(scale: ScaleName): Family {
  return (MAJOR_FLAVORS as readonly ScaleName[]).includes(scale)
    ? "major"
    : "minor";
}

function flavorFrom(family: Family): ScaleName {
  const pool = family === "major" ? MAJOR_FLAVORS : MINOR_FLAVORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Transpose a pitch-class name by `semitones`, staying a pitch class. */
function transposePc(tonic: string, semitones: number): string {
  const chroma = Note.chroma(tonic) ?? 0;
  return PITCH_CLASSES[(((chroma + semitones) % 12) + 12) % 12];
}

/**
 * Drives tonal drift. Every 60–120 s it picks a related key from a weighted
 * graph — parallel major/minor weighted highest, then relative major/minor and
 * circle-of-fifths neighbours; distant keys never appear — and asks the
 * `Modulator` to glide there via a shared pivot tone. Runs entirely on
 * `Tone.Transport`, so pausing the transport pauses the drift.
 */
export class KeyScheduler {
  private eventId: number | null = null;
  private running = false;

  constructor(
    private readonly transport: Transport,
    private readonly harmony: HarmonyEngine,
    private readonly modulator: Modulator,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(randRange(INTERVAL_MIN_S, INTERVAL_MAX_S));
  }

  stop(): void {
    this.running = false;
    if (this.eventId !== null) {
      this.transport.clear(this.eventId);
      this.eventId = null;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    this.eventId = this.transport.scheduleOnce(() => {
      this.eventId = null;
      if (!this.running) return;
      this.modulate();
      this.scheduleNext(randRange(INTERVAL_MIN_S, INTERVAL_MAX_S));
    }, `+${delaySeconds}`);
  }

  private modulate(): void {
    const current = this.harmony.key;
    const target = this.chooseNextKey(current);
    if (target.tonic === current.tonic && target.scale === current.scale) {
      return; // no-op draw; try again next interval
    }
    const pivots = commonChromas(current, target);
    const preferred = tonicChroma(current);
    const pivot = pivots.includes(preferred)
      ? preferred
      : (pivots[0] ?? null);
    this.modulator.beginModulation(target, pivot, randRange(RAMP_MIN_S, RAMP_MAX_S));
  }

  /** Weighted pick from the related-key graph around `current`. */
  private chooseNextKey(current: KeyState): KeyState {
    const family = familyOf(current.scale);
    const otherFamily: Family = family === "major" ? "minor" : "major";
    const relativeShift = family === "major" ? -3 : 3;

    const candidates: Candidate[] = [
      // Parallel major/minor: same tonic, opposite quality — closest relation.
      { key: { tonic: current.tonic, scale: flavorFrom(otherFamily) }, weight: 5 },
      // Relative major/minor.
      {
        key: {
          tonic: transposePc(current.tonic, relativeShift),
          scale: flavorFrom(otherFamily),
        },
        weight: 3,
      },
      // Circle-of-fifths neighbours (dominant / subdominant), same quality.
      {
        key: { tonic: transposePc(current.tonic, 7), scale: flavorFrom(family) },
        weight: 2,
      },
      {
        key: { tonic: transposePc(current.tonic, 5), scale: flavorFrom(family) },
        weight: 2,
      },
    ];

    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll <= 0) return candidate.key;
    }
    return candidates[0].key;
  }
}
