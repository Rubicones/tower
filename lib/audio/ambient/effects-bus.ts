import type {
  Compressor,
  FeedbackDelay,
  Filter,
  Gain,
  Limiter,
  Meter,
  Mono,
  Reverb,
  ToneAudioNode,
} from "tone";
import type { AudioQuality } from "../perf";
import type { ToneModule } from "../types";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Static bell cut carving out the speech band so ATC stays intelligible. */
const CARVE_FREQ_HZ = 1500; // geometric centre of ~800 Hz–2.5 kHz
const CARVE_Q = 1.1; // wide bell
const CARVE_GAIN_DB = -5;

/** Reverb / delay returns are band-limited to stay out of the vocal band. */
const RETURN_HP_HZ = 300;
const RETURN_LP_HZ = 7500;

/** Sidechain envelope follower (reads the ATC output, in dBFS). */
const SIDECHAIN_ATTACK_MS = 80; // fast: duck quickly when speech starts
const SIDECHAIN_RELEASE_MS = 600; // slow: recover gently after speech
const DUCK_START_DB = -45; // below this the radio is treated as silent
const DUCK_FULL_DB = -18; // at/above this the duck is fully applied
const DUCK_MIN_GAIN = 0.5; // ≈ -6 dB; a gentle duck, never a hard mute
const DB_FLOOR = -60;

/**
 * The ambient master bus. Everything the layers produce sums here, gets its
 * speech band carved out, is ducked against the live ATC signal, then glued
 * with a slow compressor and caught by a limiter.
 *
 *   layers ─▶ input ─┐
 *   layers ─▶ reverbInput ─▶ reverb ─▶ HP300 ─▶ LP7.5k ─┤
 *   layers ─▶ delayInput  ─▶ delay  ─▶ HP300 ─▶ LP7.5k ─┼▶ mix ─▶ carve ─▶ duck ─▶ comp ─▶ limiter ─▶ out
 *                                                        ┘
 *   ATC output ─▶ meter ─▶ (JS envelope follower) ─▶ duck.gain
 *
 * The carve is static (always leaves room for voice); the duck is dynamic
 * (only pulls the bed down while the radio is actually talking).
 */
export class EffectsBus {
  /** Dry layer sum. */
  readonly input: Gain;
  /** Shared reverb send target for layers. */
  readonly reverbInput: Gain;
  /** Shared delay send target for layers. */
  readonly delayInput: Gain;

  private readonly reverb: Reverb;
  private readonly reverbHp: Filter;
  private readonly reverbLp: Filter;
  private readonly delay: FeedbackDelay;
  private readonly delayHp: Filter;
  private readonly delayLp: Filter;
  private readonly mix: Gain;
  private readonly carve: Filter;
  private readonly duck: Gain;
  private readonly comp: Compressor;
  private readonly limiter: Limiter;
  private readonly mono: Mono;

  private sidechainMeter: Meter | null = null;
  private sidechainTimer: ReturnType<typeof setInterval> | null = null;
  private envDb = DB_FLOOR;

  constructor(
    private readonly tone: ToneModule,
    private readonly quality: AudioQuality,
  ) {
    this.limiter = new tone.Limiter(-2);
    this.comp = new tone.Compressor({
      threshold: -18,
      ratio: 2.5,
      attack: 0.03,
      release: 0.25,
      knee: 6,
    });
    this.duck = new tone.Gain(1);
    this.carve = new tone.Filter({
      type: "peaking",
      frequency: CARVE_FREQ_HZ,
      Q: CARVE_Q,
      gain: CARVE_GAIN_DB,
    });
    this.mix = new tone.Gain(1);
    this.mix.chain(this.carve, this.duck, this.comp, this.limiter);

    // Sum the whole ambient bed to mono at the very end of the bus.
    this.mono = new tone.Mono();
    this.limiter.connect(this.mono);

    this.input = new tone.Gain(1).connect(this.mix);

    // Shared reverb return, high/low-passed so tails never muddy the voice.
    this.reverb = new tone.Reverb({ decay: quality.ambientReverbDecay, wet: 1 });
    this.reverbHp = new tone.Filter({ type: "highpass", frequency: RETURN_HP_HZ });
    this.reverbLp = new tone.Filter({ type: "lowpass", frequency: RETURN_LP_HZ });
    this.reverbInput = new tone.Gain(1).connect(this.reverb);
    this.reverb.chain(this.reverbHp, this.reverbLp, this.mix);

    // Shared delay return, band-limited the same way.
    this.delay = new tone.FeedbackDelay({ delayTime: 0.5, feedback: 0.4, wet: 1 });
    this.delayHp = new tone.Filter({ type: "highpass", frequency: RETURN_HP_HZ });
    this.delayLp = new tone.Filter({ type: "lowpass", frequency: RETURN_LP_HZ });
    this.delayInput = new tone.Gain(1).connect(this.delay);
    this.delay.chain(this.delayHp, this.delayLp, this.mix);
  }

  /** Wait for the reverb impulse responses to render. */
  async ready(): Promise<void> {
    await this.reverb.ready;
  }

  /** Route the bus output (summed to mono) into the master chain. */
  connect(destination: ToneAudioNode | Gain): void {
    this.mono.connect(destination);
  }

  /**
   * Attach the sidechain to the ATC output. A meter reads its level and a
   * control-rate envelope follower (fast attack, slow release) modulates the
   * duck gain by up to ~-6 dB while the radio is talking.
   */
  attachSidechain(atcOutput: Gain): void {
    this.detachSidechain();
    const meter = new this.tone.Meter({ smoothing: 0 });
    atcOutput.connect(meter);
    this.sidechainMeter = meter;
    this.envDb = DB_FLOOR;

    const pollMs = this.quality.sidechainPollMs;
    const dt = pollMs / 1000;
    const attackCoef = Math.exp(-dt / (SIDECHAIN_ATTACK_MS / 1000));
    const releaseCoef = Math.exp(-dt / (SIDECHAIN_RELEASE_MS / 1000));

    this.sidechainTimer = setInterval(() => {
      const raw = meter.getValue();
      const level = typeof raw === "number" ? raw : Math.max(...raw);
      const db = Number.isFinite(level) ? Math.max(level, DB_FLOOR) : DB_FLOOR;

      // Fast rise, slow fall — classic broadcast-style ducker.
      const coef = db > this.envDb ? attackCoef : releaseCoef;
      this.envDb = coef * this.envDb + (1 - coef) * db;

      const amount = Math.min(
        1,
        Math.max(0, (this.envDb - DUCK_START_DB) / (DUCK_FULL_DB - DUCK_START_DB)),
      );
      const target = 1 - amount * (1 - DUCK_MIN_GAIN);
      // Ramp over the poll period so consecutive updates join seamlessly.
      this.duck.gain.rampTo(target, dt);
    }, pollMs);
  }

  private detachSidechain(): void {
    if (this.sidechainTimer !== null) {
      clearInterval(this.sidechainTimer);
      this.sidechainTimer = null;
    }
    if (this.sidechainMeter) {
      this.sidechainMeter.dispose();
      this.sidechainMeter = null;
    }
  }

  dispose(): void {
    this.detachSidechain();
    this.input.dispose();
    this.reverbInput.dispose();
    this.delayInput.dispose();
    this.reverb.dispose();
    this.reverbHp.dispose();
    this.reverbLp.dispose();
    this.delay.dispose();
    this.delayHp.dispose();
    this.delayLp.dispose();
    this.mix.dispose();
    this.carve.dispose();
    this.duck.dispose();
    this.comp.dispose();
    this.limiter.dispose();
    this.mono.dispose();
  }
}
