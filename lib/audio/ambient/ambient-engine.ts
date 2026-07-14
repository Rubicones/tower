import type { Gain } from "tone";
import type { AudioQuality } from "../perf";
import type { ToneModule, Transport } from "../types";
import { EffectsBus } from "./effects-bus";
import { HarmonyEngine, type KeyState } from "./harmony-engine";
import { KeyScheduler } from "./key-scheduler";
import { LayerManager } from "./layer-manager";
import { NoteRegistry } from "./note-registry";

/** Where the drift begins each session. */
const INITIAL_KEY: KeyState = { tonic: "D", scale: "minor pentatonic" };

/**
 * The generative ambient engine. Four independent layers (drone / pad /
 * texture / atmosphere) evolve continuously on `Tone.Transport`; a HarmonyEngine
 * keeps every note consonant against the live acoustic state; a KeyScheduler
 * drifts the tonality between related keys every 60–120 s via smooth, staggered
 * modulations; and an EffectsBus carves out the speech band and ducks the whole
 * bed against the live ATC signal.
 *
 * Mirrors the tiny surface the AudioEngine expects of an ambient source
 * (`init` / `start` / `stop` / `dispose`), so it drops in where the old
 * AmbientLayer sat.
 */
export class AmbientEngine {
  private readonly transport: Transport;
  private readonly harmony: HarmonyEngine;
  private readonly registry: NoteRegistry;
  private readonly bus: EffectsBus;
  private readonly layers: LayerManager;
  private readonly keyScheduler: KeyScheduler;

  private running = false;
  private disposed = false;

  /**
   * @param output          the ambient master volume node (music fader)
   * @param sidechainSource the ATC output, tapped for the ducking follower
   */
  constructor(
    tone: ToneModule,
    output: Gain,
    sidechainSource: Gain,
    quality: AudioQuality,
  ) {
    this.transport = tone.getTransport();
    this.harmony = new HarmonyEngine(INITIAL_KEY);
    this.registry = new NoteRegistry();

    this.bus = new EffectsBus(tone, quality);
    this.bus.connect(output);
    this.bus.attachSidechain(sidechainSource);

    this.layers = new LayerManager(this.transport, this.harmony, {
      tone,
      registry: this.registry,
      bus: this.bus,
      quality,
    });
    this.keyScheduler = new KeyScheduler(this.transport, this.harmony, this.layers);
  }

  /** Wait for the reverb impulse responses to render. */
  async init(): Promise<void> {
    await this.bus.ready();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    if (this.transport.state !== "started") this.transport.start();
    this.layers.start();
    this.keyScheduler.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.keyScheduler.stop();
    this.layers.stop();
    this.registry.clearTransient();
    this.transport.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.layers.dispose();
    this.bus.dispose();
    if (this.transport.state !== "stopped") this.transport.stop();
  }
}
