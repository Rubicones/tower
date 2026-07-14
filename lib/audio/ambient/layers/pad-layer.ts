import type { Gain, PolySynth } from "tone";
import { randRange } from "../../random";
import { midiToFrequency, type Register } from "../harmony-engine";
import { ScheduledLayer, type LayerContext } from "./base";

const REGISTER: Register = { low: 52, high: 76 };
const PERIOD_MIN_S = 40;
const PERIOD_MAX_S = 54; // centred near the ~47 s coprime target
const CHORD_MIN = 2;
const CHORD_MAX = 4;

/**
 * Slow-attack / long-release pad chords. On each (roughly 47 s) tick it grows
 * a 2–4 note cluster, each note validated consonant against everything already
 * sounding via the HarmonyEngine, with smooth voice-leading between chords.
 */
export class PadLayer extends ScheduledLayer {
  readonly id = "pad";

  private readonly synth: PolySynth;
  private readonly reverbSend: Gain;
  private readonly delaySend: Gain;

  constructor(ctx: LayerContext) {
    super(ctx);
    const { tone } = ctx;
    this.synth = new tone.PolySynth(tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 3.5, decay: 2, sustain: 0.7, release: 9 },
      volume: -15,
    });
    this.synth.maxPolyphony = ctx.quality.padMaxVoices;
    this.synth.connect(ctx.bus.input);

    this.reverbSend = new tone.Gain(0.35);
    this.synth.connect(this.reverbSend);
    this.reverbSend.connect(ctx.bus.reverbInput);

    this.delaySend = new tone.Gain(0.12);
    this.synth.connect(this.delaySend);
    this.delaySend.connect(ctx.bus.delayInput);
  }

  protected firstDelay(): number {
    return randRange(0.4, 3);
  }

  protected nextPeriod(): number {
    return randRange(PERIOD_MIN_S, PERIOD_MAX_S);
  }

  protected tick(time: number): void {
    const now = this.ctx.tone.now();
    // Favour smaller clusters; bias by 1 toward the low end.
    const desired =
      CHORD_MIN + Math.floor(Math.random() * (CHORD_MAX - CHORD_MIN + 1));
    const size = Math.min(desired, this.ctx.maxPolyphony - this.ctx.registry.count(now));
    if (size <= 0) return;

    const chord: number[] = [];
    for (let voice = 0; voice < size; voice++) {
      const active = [...this.ctx.registry.snapshot(now), ...chord];
      const note = this.ctx.harmony.getNextNote(this.id, active, REGISTER);
      if (note === null) break;
      chord.push(note);
    }
    if (chord.length === 0) return;

    const duration = randRange(6, 12);
    const until = now + duration + 9; // include the long release tail
    const velocity = this.humanVelocity(0.28);
    for (const midi of chord) {
      this.ctx.registry.add(midi, until);
    }
    this.synth.triggerAttackRelease(
      chord.map(midiToFrequency),
      duration,
      time,
      velocity,
    );
  }

  protected onStop(): void {
    this.synth.releaseAll();
  }

  dispose(): void {
    this.synth.dispose();
    this.reverbSend.dispose();
    this.delaySend.dispose();
  }
}
