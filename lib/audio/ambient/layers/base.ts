import { randRange } from "../../random";
import type { ToneModule, Transport } from "../../types";
import type { EffectsBus } from "../effects-bus";
import type { HarmonyEngine } from "../harmony-engine";
import type { NoteRegistry } from "../note-registry";

/** ±ms micro-timing offset applied to every scheduled event. */
const HUMANIZE_S = 0.08;
/** ±fraction of velocity/gain randomisation applied per event. */
const VELOCITY_JITTER = 0.15;

/** Shared services every layer needs. */
export interface LayerContext {
  tone: ToneModule;
  transport: Transport;
  harmony: HarmonyEngine;
  registry: NoteRegistry;
  bus: EffectsBus;
  /** Global voice cap across all layers. */
  maxPolyphony: number;
}

/** The lifecycle every ambient layer exposes to the LayerManager. */
export interface AmbientLayerModule {
  readonly id: string;
  init?(): Promise<void>;
  start(): void;
  stop(): void;
  dispose(): void;
}

/**
 * Base class for layers driven by a self-rescheduling Transport event on an
 * independent period. Subclasses supply the period and the per-tick musical
 * action; this class handles Transport bookkeeping, micro-timing
 * humanisation, velocity jitter and the global polyphony check.
 */
export abstract class ScheduledLayer implements AmbientLayerModule {
  abstract readonly id: string;

  protected running = false;
  private eventId: number | null = null;

  constructor(protected readonly ctx: LayerContext) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(this.firstDelay());
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.eventId !== null) {
      this.ctx.transport.clear(this.eventId);
      this.eventId = null;
    }
    this.onStop();
  }

  abstract dispose(): void;

  private scheduleNext(delaySeconds: number): void {
    this.eventId = this.ctx.transport.scheduleOnce((time) => {
      this.eventId = null;
      if (!this.running) return;
      this.tick(this.humanize(time));
      if (this.running) this.scheduleNext(this.nextPeriod());
    }, `+${delaySeconds}`);
  }

  /** Nudge an event time by ±HUMANIZE_S, never scheduling in the past. */
  protected humanize(time: number): number {
    const jitter = randRange(-HUMANIZE_S, HUMANIZE_S);
    return Math.max(time + jitter, this.ctx.tone.now() + 0.005);
  }

  protected humanVelocity(base: number): number {
    return base * randRange(1 - VELOCITY_JITTER, 1 + VELOCITY_JITTER);
  }

  /** True if `need` more voices fit under the global polyphony cap. */
  protected polyphonyAvailable(now: number, need: number): boolean {
    return this.ctx.registry.count(now) + need <= this.ctx.maxPolyphony;
  }

  /** Seconds before the first event after start. */
  protected abstract firstDelay(): number;
  /** Seconds until the next event (randomised, layer-specific period). */
  protected abstract nextPeriod(): number;
  /** The musical action, at audio-clock `time`. */
  protected abstract tick(time: number): void;
  /** Optional cleanup on stop (e.g. release voices). */
  protected onStop(): void {}
}
