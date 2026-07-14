import type { AudioQuality } from "../perf";
import type { Transport } from "../types";
import type { EffectsBus } from "./effects-bus";
import type { HarmonyEngine, KeyState } from "./harmony-engine";
import type { Modulator } from "./key-scheduler";
import type { NoteRegistry } from "./note-registry";
import { AtmosphereLayer } from "./layers/atmosphere-layer";
import type { AmbientLayerModule, LayerContext } from "./layers/base";
import { DroneLayer } from "./layers/drone-layer";
import { PadLayer } from "./layers/pad-layer";
import { TextureLayer } from "./layers/texture-layer";

/** Staggered entry of each layer into the new key — the drift reads as gradual. */
const PAD_STAGGER_S = 4;
const TEXTURE_STAGGER_S = 8;

/**
 * Owns the four layers and drives their shared lifecycle. Also implements the
 * `Modulator` contract the KeyScheduler calls: a modulation is staggered —
 * drone glides first, then the pad and texture adopt the new key a few seconds
 * apart — and finalised once the ramp completes. Throughout, the per-note
 * interval-class filter (validated against the live NoteRegistry) keeps the two
 * momentarily-overlapping keys clash-free.
 */
export class LayerManager implements Modulator {
  private readonly drone: DroneLayer;
  private readonly pad: PadLayer;
  private readonly texture: TextureLayer;
  private readonly atmosphere: AtmosphereLayer;
  private readonly layers: AmbientLayerModule[];

  private modulationEvents: number[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly harmony: HarmonyEngine,
    ctxParts: {
      tone: LayerContext["tone"];
      registry: NoteRegistry;
      bus: EffectsBus;
      quality: AudioQuality;
    },
  ) {
    const ctx: LayerContext = {
      tone: ctxParts.tone,
      transport,
      harmony,
      registry: ctxParts.registry,
      bus: ctxParts.bus,
      maxPolyphony: ctxParts.quality.maxPolyphony,
      quality: ctxParts.quality,
    };
    this.drone = new DroneLayer(ctx);
    this.pad = new PadLayer(ctx);
    this.texture = new TextureLayer(ctx);
    this.atmosphere = new AtmosphereLayer(ctx);
    this.layers = [this.drone, this.pad, this.texture, this.atmosphere];
  }

  start(): void {
    for (const layer of this.layers) layer.start();
  }

  stop(): void {
    this.clearModulationEvents();
    for (const layer of this.layers) layer.stop();
  }

  dispose(): void {
    this.clearModulationEvents();
    for (const layer of this.layers) layer.dispose();
  }

  beginModulation(
    target: KeyState,
    pivotChroma: number | null,
    rampSeconds: number,
  ): void {
    this.clearModulationEvents();

    // Drone leads, gliding immediately and holding the pivot tone.
    this.harmony.setLayerKey(this.drone.id, target);
    this.drone.glideToKey(target, pivotChroma, rampSeconds);

    // Pad and texture adopt the new key a few seconds apart.
    this.modulationEvents.push(
      this.transport.scheduleOnce(() => {
        this.harmony.setLayerKey(this.pad.id, target);
      }, `+${PAD_STAGGER_S}`),
    );
    this.modulationEvents.push(
      this.transport.scheduleOnce(() => {
        this.harmony.setLayerKey(this.texture.id, target);
      }, `+${TEXTURE_STAGGER_S}`),
    );

    // Once the glide completes, everyone is on the new key; clear overrides.
    this.modulationEvents.push(
      this.transport.scheduleOnce(() => {
        this.harmony.setKey(target);
        this.modulationEvents = [];
      }, `+${rampSeconds}`),
    );
  }

  private clearModulationEvents(): void {
    for (const id of this.modulationEvents) this.transport.clear(id);
    this.modulationEvents = [];
  }
}
