import type { Gain, Limiter, Reverb } from "tone";
import { AmbientEngine } from "./ambient/ambient-engine";
import { AtcStreamingLayer } from "./atc-streaming-layer";
import type { AtcStatus, ToneModule } from "./types";

/** Ceiling gains per layer; the ambient layer sits well under the radio. */
const RADIO_MAX_GAIN = 0.6;
const MUSIC_MAX_GAIN = 0.5;

const KEEP_ALIVE_URL = "/audio/silence.mp3";

/** Perceptual-ish volume curve: slider 0–100 -> gain 0–max. */
function sliderToGain(value: number, max: number): number {
  const normalized = Math.min(100, Math.max(0, value)) / 100;
  return normalized * normalized * max;
}

/**
 * The single audio engine behind the app. Owns the shared Tone.js context
 * and the master chain:
 *
 *   ATC streaming layer ─▶ radioGain ─┐
 *                                      ├─▶ fadeGain ─┬─▶ limiter ─▶ destination
 *   ambient synthesis   ─▶ musicGain ──┘             └─▶ send ─▶ master reverb ─▶ limiter
 *
 * The radio layer streams NASA air-to-ground tapes from archive.org through
 * a triple-buffered `<audio>` deck (see `AtcStreamingLayer`); the ambient
 * layer is pure Tone.js synthesis. Tone.js is imported dynamically and the
 * AudioContext is started only inside `start()`, which must run from a user
 * gesture (browser autoplay policy, required on iOS Safari).
 */
export class AudioEngine {
  /** Notified whenever the ATC failover rung changes. */
  onStatus: ((status: AtcStatus) => void) | null = null;

  private tone: ToneModule | null = null;
  private building: Promise<void> | null = null;
  private disposed = false;
  private running = false;

  private limiter: Limiter | null = null;
  private fadeGain: Gain | null = null;
  private reverbSend: Gain | null = null;
  private masterReverb: Reverb | null = null;
  private radioGain: Gain | null = null;
  private musicGain: Gain | null = null;

  private atc: AtcStreamingLayer | null = null;
  private ambient: AmbientEngine | null = null;

  private keepAlive: HTMLAudioElement | null = null;

  private radioLevel = 70;
  private musicLevel = 45;
  private status: AtcStatus = "streaming";

  get isRunning(): boolean {
    return this.running;
  }

  get atcStatus(): AtcStatus {
    return this.status;
  }

  /** Start (or resume) playback. Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.disposed || this.running) return;
    const tone = (this.tone ??= await import("tone"));
    await tone.start();
    await (this.building ??= this.build(tone));
    if (this.disposed) return;
    this.cancelFade();
    this.running = true;
    // Keep-alive must be blessed inside the gesture (iOS).
    this.startKeepAlive();
    this.atc?.start();
    this.ambient?.start();
  }

  /** Stop both layers. The graph stays warm for the next `start()`. */
  pause(): void {
    this.running = false;
    this.atc?.stop();
    this.ambient?.stop();
    this.cancelFade();
    this.keepAlive?.pause();
  }

  setRadioVolume(value: number): void {
    this.radioLevel = value;
    this.radioGain?.gain.rampTo(sliderToGain(value, RADIO_MAX_GAIN), 0.08);
  }

  setMusicVolume(value: number): void {
    this.musicLevel = value;
    this.musicGain?.gain.rampTo(sliderToGain(value, MUSIC_MAX_GAIN), 0.08);
  }

  /** Sleep timer fired: fade everything to silence over `seconds`. */
  beginFade(seconds: number): void {
    this.fadeGain?.gain.rampTo(0, seconds);
  }

  /** Abort an in-progress fade and restore full level. */
  cancelFade(): void {
    if (!this.fadeGain || !this.tone) return;
    this.fadeGain.gain.cancelScheduledValues(this.tone.now());
    this.fadeGain.gain.rampTo(1, 0.3);
  }

  /** Tear down every node. The engine cannot be restarted afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.atc?.dispose();
    this.ambient?.dispose();
    this.radioGain?.dispose();
    this.musicGain?.dispose();
    this.reverbSend?.dispose();
    this.masterReverb?.dispose();
    this.fadeGain?.dispose();
    this.limiter?.dispose();
    if (this.keepAlive) {
      this.keepAlive.pause();
      this.keepAlive.removeAttribute("src");
      this.keepAlive = null;
    }
  }

  private async build(tone: ToneModule): Promise<void> {
    this.limiter = new tone.Limiter(-3).toDestination();
    this.fadeGain = new tone.Gain(1).connect(this.limiter);

    // Master reverb as a send off the summed layers, for shared "air".
    this.masterReverb = new tone.Reverb({ decay: 5, wet: 1 });
    this.reverbSend = new tone.Gain(0.15).connect(this.masterReverb);
    this.masterReverb.connect(this.limiter);
    this.fadeGain.connect(this.reverbSend);

    this.radioGain = new tone.Gain(
      sliderToGain(this.radioLevel, RADIO_MAX_GAIN),
    ).connect(this.fadeGain);
    this.musicGain = new tone.Gain(
      sliderToGain(this.musicLevel, MUSIC_MAX_GAIN),
    ).connect(this.fadeGain);

    this.atc = new AtcStreamingLayer(tone, this.radioGain);
    this.atc.onStatus = (status) => {
      this.status = status;
      this.onStatus?.(status);
    };
    // The ambient engine ducks against the live ATC signal, so hand it the
    // radio output node as its sidechain source.
    this.ambient = new AmbientEngine(tone, this.musicGain, this.radioGain);

    await Promise.all([
      this.atc.init(),
      this.ambient.init(),
      this.masterReverb.ready,
    ]);
  }

  /**
   * A silent, looping <audio> element keeps the iOS audio session alive in
   * the background / behind the lock screen and gives the media session a
   * real playback target.
   */
  private startKeepAlive(): void {
    if (!this.keepAlive) {
      const el = document.createElement("audio");
      el.src = KEEP_ALIVE_URL;
      el.loop = true;
      el.preload = "auto";
      el.setAttribute("playsinline", "");
      this.keepAlive = el;
    }
    void this.keepAlive.play().catch(() => {
      // Non-fatal: audio still plays in the foreground without it.
    });
  }
}
