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
 * tunables that trims the heaviest work on low tiers (shorter reverb impulse
 * responses, one fewer reverb, no ping-pong, lower polyphony, slower
 * control-rate polling). None of this is toggled at runtime: topology is fixed
 * at build time, because changing the graph while audio flows is itself a
 * source of clicks.
 *
 * The "playback" latency hint — a far larger audio buffer in exchange for
 * ~150-200ms of extra output latency — is requested on *every* tier, not just
 * low-power ones. This app never needs interactive response time (it's an
 * ambient background player, nothing is played in reaction to a tap), and a
 * mobile CPU gets deprioritized the moment the screen locks or the tab is
 * backgrounded regardless of how many cores it has on paper. A small
 * "interactive" buffer that was comfortable in the foreground is exactly what
 * underruns (and clicks) the moment that throttling kicks in, which is the
 * main background-playback failure mode this profile exists to remove.
 */

export interface AudioQuality {
  /** Human-readable tier, handy for debugging / the dev meter page. */
  tier: "high" | "low";
  /**
   * AudioContext latency hint. A category ("playback") lets the browser pick a
   * large buffer; a *number* (seconds) requests a specific, even larger output
   * buffer. On mobile we pass an explicit ~0.5s: when the screen turns off the
   * whole SoC downclocks and the render thread gets starved in bursts, and a
   * big buffer is the only thing that lets it fall behind for a fraction of a
   * second and catch back up without underrunning — the continuous-crackle
   * failure mode. The cost is added output latency this ambient player (nothing
   * is played in reaction to a tap) never notices.
   */
  latencyHint: AudioContextLatencyCategory | number;

  /**
   * Tone.Transport scheduling look-ahead (seconds). Every ambient event is
   * scheduled this far in advance of the audio clock, so the worker/timer that
   * drains the Transport can fall this many seconds behind — exactly what
   * mobile browsers do to background timers — without any event landing late.
   * A late event is a gap; a burst of catch-up events is a click. A generous
   * look-ahead is the cheapest defense against both while the screen is off.
   * Larger on weak devices, whose timers are throttled hardest.
   */
  lookAhead: number;
  /** How often the Transport clock wakes to schedule ahead (seconds). */
  updateInterval: number;

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
  latencyHint: "playback",
  lookAhead: 0.3,
  updateInterval: 0.05,
  masterReverbEnabled: true,
  masterReverbDecay: 5,
  atcReverbDecay: 7,
  ambientReverbDecay: 6,
  pingPongEnabled: true,
  maxPolyphony: 16,
  padMaxVoices: 12,
  sidechainPollMs: 50,
  watchdogMeterMs: 100,
};

const LOW: AudioQuality = {
  tier: "low",
  // Explicit ~0.5s output buffer: the strongest defense against the render
  // thread underrunning while a screen-off phone downclocks in bursts.
  latencyHint: 0.5,
  lookAhead: 0.5,
  updateInterval: 0.1,
  masterReverbEnabled: false,
  masterReverbDecay: 3,
  // The two convolution reverbs are the heaviest nodes in the graph. Shorter
  // impulse responses cut their per-block render cost proportionally, which is
  // what keeps the whole graph inside a throttled screen-off CPU budget. The
  // shorter tails are barely perceptible under the radio and ambient bed.
  atcReverbDecay: 2.5,
  ambientReverbDecay: 2.5,
  pingPongEnabled: false,
  // Total voice ceiling stays at the original mobile budget (10) so render
  // cost is unchanged; the pad may use up to 8 of it, which — with the drone's
  // 2 sustained voices — lets a chord and the previous chord's release tail
  // overlap (the "travelling" motion) without Tone ever hitting the limit and
  // dropping notes from a chord.
  maxPolyphony: 10,
  padMaxVoices: 8,
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
