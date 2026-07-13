import type { Filter, Gain, LFO, Noise } from "tone";
import type { AmbientLayerModule, LayerContext } from "./base";

const LOW_LEVEL = 0.05; // sub / low rumble
const HIGH_LEVEL = 0.02; // airy hiss
const FADE_S = 10;

interface Bed {
  noise: Noise;
  filter: Filter;
  vca: Gain; // driven by the slow volume LFO
  fade: Gain; // start/stop fade
  lfo: LFO;
}

/**
 * Continuous unpitched "air": a low rumble (below the voice band) and a faint
 * airy hiss (well above it), each breathing on its own very slow volume LFO.
 * Unpitched, so it never participates in harmony validation — it just fills
 * the space around the tuned layers, staying clear of the speech midrange.
 */
export class AtmosphereLayer implements AmbientLayerModule {
  readonly id = "atmosphere";

  private readonly low: Bed;
  private readonly high: Bed;
  private running = false;
  private booted = false;

  constructor(private readonly ctx: LayerContext) {
    this.low = this.buildBed("brown", 320, "lowpass", LOW_LEVEL, 1 / 70);
    this.high = this.buildBed("white", 5000, "highpass", HIGH_LEVEL, 1 / 95);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Boot the free-running sources once; pause/resume only fades the bed.
    if (!this.booted) {
      for (const bed of [this.low, this.high]) {
        bed.noise.start();
        bed.lfo.start();
      }
      this.booted = true;
    }
    for (const bed of [this.low, this.high]) {
      bed.fade.gain.rampTo(1, FADE_S);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const bed of [this.low, this.high]) {
      bed.fade.gain.rampTo(0, 2);
    }
  }

  dispose(): void {
    for (const bed of [this.low, this.high]) {
      bed.lfo.dispose();
      bed.noise.dispose();
      bed.filter.dispose();
      bed.vca.dispose();
      bed.fade.dispose();
    }
  }

  private buildBed(
    type: "brown" | "white",
    frequency: number,
    filterType: "lowpass" | "highpass",
    level: number,
    lfoHz: number,
  ): Bed {
    const { tone } = this.ctx;
    const noise = new tone.Noise(type);
    const filter = new tone.Filter({ type: filterType, frequency, rolloff: -24 });
    // Intrinsic 0: the LFO is the sole driver (Web Audio sums param inputs).
    const vca = new tone.Gain(0);
    const fade = new tone.Gain(0);
    const lfo = new tone.LFO({ frequency: lfoHz, min: level * 0.55, max: level });
    noise.chain(filter, vca, fade, this.ctx.bus.input);
    lfo.connect(vca.gain);
    return { noise, filter, vca, fade, lfo };
  }
}
