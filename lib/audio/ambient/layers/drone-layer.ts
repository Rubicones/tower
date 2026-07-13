import type { Gain, LFO, Oscillator } from "tone";
import { randRange } from "../../random";
import {
  midiForChroma,
  midiToFrequency,
  tonicChroma,
  type KeyState,
  type Register,
} from "../harmony-engine";
import { ScheduledLayer, type LayerContext } from "./base";

const REGISTER: Register = { low: 38, high: 57 };
/** Slow in-key re-voice period; long and coprime with the other layers. */
const REVOICE_MIN_S = 110;
const REVOICE_MAX_S = 150;
const VOICE_LEVEL = 0.14;
const FADE_S = 8;
const REVOICE_GLIDE_S = 6;

interface Voice {
  osc: Oscillator;
  gain: Gain;
  lfo: LFO;
  reverbSend: Gain;
}

/**
 * Two long sustained sine tones (root + a fifth above) with a slow detune LFO
 * on each for gentle movement, carrying the sub-bass weight of the bed. Pitch
 * only ever changes by smooth glide — on key modulation, or on a rare in-key
 * re-voice of the upper tone.
 */
export class DroneLayer extends ScheduledLayer {
  readonly id = "drone";

  private readonly voices: Voice[];
  private notes: number[];
  private booted = false;

  constructor(ctx: LayerContext) {
    super(ctx);
    const { tone } = ctx;
    this.notes = this.rootAndFifth(ctx.harmony.key);

    this.voices = this.notes.map((midi, i) => {
      const osc = new tone.Oscillator({
        type: "sine",
        frequency: midiToFrequency(midi),
      });
      const gain = new tone.Gain(0);
      const reverbSend = new tone.Gain(0.12);
      osc.connect(gain);
      gain.connect(ctx.bus.input);
      gain.connect(reverbSend);
      reverbSend.connect(ctx.bus.reverbInput);
      // A very slow, slightly different LFO per voice keeps them alive.
      const lfo = new tone.LFO({
        frequency: 0.03 + i * 0.017,
        min: -7,
        max: 7,
      });
      lfo.connect(osc.detune);
      return { osc, gain, reverbSend, lfo };
    });
  }

  start(): void {
    if (this.running) return;
    // Boot the free-running oscillators once; pause/resume only fades them.
    if (!this.booted) {
      for (const voice of this.voices) {
        voice.osc.start();
        voice.lfo.start();
      }
      this.booted = true;
    }
    for (const voice of this.voices) {
      voice.gain.gain.rampTo(VOICE_LEVEL, FADE_S);
    }
    this.ctx.registry.setSustained(this.id, this.notes);
    super.start();
  }

  /** Smoothly glide both voices into `target`, holding the pivot tone. */
  glideToKey(target: KeyState, pivotChroma: number | null, rampSeconds: number): void {
    const targets = this.assignTargets(this.rootAndFifth(target), pivotChroma);
    this.notes = targets;
    targets.forEach((midi, i) => {
      this.voices[i]?.osc.frequency.rampTo(midiToFrequency(midi), rampSeconds);
    });
    this.ctx.registry.setSustained(this.id, this.notes);
  }

  protected firstDelay(): number {
    return randRange(REVOICE_MIN_S, REVOICE_MAX_S);
  }

  protected nextPeriod(): number {
    return randRange(REVOICE_MIN_S, REVOICE_MAX_S);
  }

  /** Rare in-key re-voice: glide the upper tone to another consonant tone. */
  protected tick(): void {
    const [root] = this.notes;
    const upper = this.ctx.harmony.getNextNote(this.id, [root], REGISTER);
    if (upper === null || upper === this.notes[1]) return;
    this.notes = [root, upper];
    this.voices[1]?.osc.frequency.rampTo(
      midiToFrequency(upper),
      REVOICE_GLIDE_S,
    );
    this.ctx.registry.setSustained(this.id, this.notes);
  }

  protected onStop(): void {
    // Fade out but leave the oscillators free-running for a clean resume.
    for (const voice of this.voices) {
      voice.gain.gain.rampTo(0, 2);
    }
    this.ctx.registry.setSustained(this.id, []);
  }

  dispose(): void {
    for (const voice of this.voices) {
      voice.lfo.dispose();
      voice.osc.dispose();
      voice.reverbSend.dispose();
      voice.gain.dispose();
    }
  }

  private rootAndFifth(key: KeyState): number[] {
    const root = midiForChroma(tonicChroma(key), REGISTER.low);
    return [root, root + 7];
  }

  /**
   * Map current voices onto the new [root, fifth] with least movement, so a
   * common tone naturally holds (zero glide) through the transition.
   */
  private assignTargets(targets: number[], pivotChroma: number | null): number[] {
    const assigned = [...targets];
    // If a current voice already sits on the pivot chroma, keep it in place.
    if (pivotChroma !== null) {
      const holdIndex = this.notes.findIndex(
        (midi) => ((midi % 12) + 12) % 12 === pivotChroma,
      );
      if (holdIndex !== -1) {
        assigned[holdIndex] = this.notes[holdIndex];
        const otherIndex = holdIndex === 0 ? 1 : 0;
        assigned[otherIndex] = targets[otherIndex];
      }
    }
    return assigned;
  }
}
