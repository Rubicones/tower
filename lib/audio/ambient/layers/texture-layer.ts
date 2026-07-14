import type { FMSynth, Gain } from "tone";
import { randRange } from "../../random";
import { midiToFrequency, type Register } from "../harmony-engine";
import { ScheduledLayer, type LayerContext } from "./base";

const REGISTER: Register = { low: 76, high: 99 };
const PERIOD_MIN_S = 52;
const PERIOD_MAX_S = 68; // near ~60 s — a touch more high sparkle, still rare
const NOTE_DURATION_S = 2;

/**
 * Rare, scale-locked high bell hits — the sparkle. Short and quiet, thrown far
 * into the shared reverb so each one blooms into a long tail. Live FM synthesis
 * (variability matters more than fidelity here).
 */
export class TextureLayer extends ScheduledLayer {
  readonly id = "texture";

  private readonly bell: FMSynth;
  private readonly reverbSend: Gain;

  constructor(ctx: LayerContext) {
    super(ctx);
    const { tone } = ctx;
    this.bell = new tone.FMSynth({
      harmonicity: 2.5,
      modulationIndex: 6,
      oscillator: { type: "sine" },
      envelope: { attack: 0.02, decay: 1.8, sustain: 0, release: 3 },
      modulation: { type: "sine" },
      modulationEnvelope: { attack: 0.02, decay: 0.4, sustain: 0, release: 1 },
      volume: -22,
    });
    // Mostly reverb — the sparkle lives in its tail, not the dry hit.
    this.reverbSend = new tone.Gain(0.8);
    this.bell.connect(ctx.bus.input);
    this.bell.connect(this.reverbSend);
    this.reverbSend.connect(ctx.bus.reverbInput);
  }

  protected firstDelay(): number {
    return randRange(PERIOD_MIN_S / 2, PERIOD_MAX_S / 2);
  }

  protected nextPeriod(): number {
    return randRange(PERIOD_MIN_S, PERIOD_MAX_S);
  }

  protected tick(time: number): void {
    const now = this.ctx.tone.now();
    if (!this.polyphonyAvailable(now, 1)) return;
    const note = this.ctx.harmony.getNextNote(
      this.id,
      this.ctx.registry.snapshot(now),
      REGISTER,
    );
    if (note === null) return;
    this.ctx.registry.add(note, now + NOTE_DURATION_S);
    const velocity = this.humanVelocity(0.1);
    this.bell.triggerAttackRelease(
      midiToFrequency(note),
      NOTE_DURATION_S,
      time,
      velocity,
    );
  }

  dispose(): void {
    this.bell.dispose();
    this.reverbSend.dispose();
  }
}
