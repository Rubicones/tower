/**
 * Device-aware audio quality profile.
 *
 * The DSP graph (three convolution reverbs, feedback + ping-pong delays, a
 * waveshaper, a bank of biquad filters, a compressor, two limiters and a full
 * generative synth stack) is comfortable on a laptop but overloads the Web
 * Audio render thread on weak phones. When the render thread misses its
 * 128-sample deadline the output underruns and you hear clicks/crackle — the
 * exact symptom this profile exists to remove.
 *
 * We therefore detect low-power devices once and hand every subsystem a set of
 * tunables that trims the heaviest work (shorter reverb impulse responses, one
 * fewer reverb, no ping-pong, lower polyphony, slower control-rate polling) and
 * — crucially — asks the browser for a larger audio buffer via the "playback"
 * latency hint. None of this is toggled at runtime: topology is fixed at build
 * time, because changing the graph while audio flows is itself a source of
 * clicks.
 */

export interface AudioQuality {
  /** Human-readable tier, handy for debugging / the dev meter page. */
  tier: "high" | "low";
  /**
   * AudioContext latency hint. "playback" trades responsiveness for a larger
   * buffer and far more render-thread headroom — the right call for an ambient
   * player and the single biggest win against underrun clicks on mobile.
   */
  latencyHint: AudioContextLatencyCategory;

  /** Global "air" reverb send in the master chain; skipped entirely on low. */
  masterReverbEnabled: boolean;
  masterReverbDecay: number;
  /** ATC radio-atmosphere reverb impulse length (seconds). */
  atcReverbDecay: number;
  /** Ambient bed reverb impulse length (seconds). */
  ambientReverbDecay: number;

  /** Extra stereo ping-pong echo on the ATC bus; dropped on low. */
  pingPongEnabled: boolean;

  /** Global voice cap across every ambient layer. */
  maxPolyphony: number;
  /** Hard voice ceiling on the pad PolySynth. */
  padMaxVoices: number;

  /** How often the ambient ducker samples the ATC level (ms). */
  sidechainPollMs: number;
  /** How often the ATC silence watchdog samples its meter (ms). */
  watchdogMeterMs: number;
}

const HIGH: AudioQuality = {
  tier: "high",
  latencyHint: "interactive",
  masterReverbEnabled: true,
  masterReverbDecay: 5,
  atcReverbDecay: 7,
  ambientReverbDecay: 6,
  pingPongEnabled: true,
  maxPolyphony: 18,
  padMaxVoices: 10,
  sidechainPollMs: 50,
  watchdogMeterMs: 100,
};

const LOW: AudioQuality = {
  tier: "low",
  latencyHint: "playback",
  masterReverbEnabled: false,
  masterReverbDecay: 3,
  atcReverbDecay: 4,
  ambientReverbDecay: 3.5,
  pingPongEnabled: false,
  maxPolyphony: 10,
  padMaxVoices: 6,
  sidechainPollMs: 90,
  watchdogMeterMs: 120,
};

let cached: AudioQuality | null = null;

/**
 * True for phones and other constrained devices: few logical cores, little
 * RAM, or a coarse (touch) pointer. Any one of these is enough — a powerful
 * tablet only loses the extra ping-pong tail, while genuinely weak hardware
 * gets the full lightweight profile.
 */
function isLowPowerDevice(): boolean {
  if (typeof navigator === "undefined") return false;

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0 && cores <= 4) return true;

  const memory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  if (typeof memory === "number" && memory > 0 && memory <= 4) return true;

  if (
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches
  ) {
    return true;
  }

  return false;
}

/** The audio quality profile for this device (computed once, then cached). */
export function detectQuality(): AudioQuality {
  if (cached) return cached;
  cached = isLowPowerDevice() ? LOW : HIGH;
  return cached;
}
