import type { Gain, Limiter, Reverb } from "tone";
import { AmbientEngine } from "./ambient/ambient-engine";
import { AtcStreamingLayer } from "./atc-streaming-layer";
import { ContextResumer } from "./context-resume";
import { type AudioQuality, detectQuality } from "./perf";
import type { AtcStatus, DebugEvent, DebugSnapshot, ToneModule } from "./types";

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
  /** Dev-only telemetry stream, proxied straight through from the ATC layer. */
  onDebugEvent: ((event: DebugEvent) => void) | null = null;

  private tone: ToneModule | null = null;
  private building: Promise<void> | null = null;
  private disposed = false;
  private running = false;
  private contextReady = false;

  private readonly quality: AudioQuality = detectQuality();

  private limiter: Limiter | null = null;
  private fadeGain: Gain | null = null;
  private reverbSend: Gain | null = null;
  private masterReverb: Reverb | null = null;
  private radioGain: Gain | null = null;
  private musicGain: Gain | null = null;

  private atc: AtcStreamingLayer | null = null;
  private ambient: AmbientEngine | null = null;

  private keepAlive: HTMLAudioElement | null = null;
  private resumer: ContextResumer | null = null;

  private radioLevel = 70;
  private musicLevel = 45;
  private status: AtcStatus = "streaming";
  private debugEnabled = false;
  /** What the fade gain should be resting at; a resume-recovery fade targets this, not always 1. */
  private fadeTarget: 0 | 1 = 1;

  get isRunning(): boolean {
    return this.running;
  }

  get atcStatus(): AtcStatus {
    return this.status;
  }

  /* ------------------------------------------------------------------ */
  /* Debug telemetry (dev-only overlay)                                  */
  /* ------------------------------------------------------------------ */

  /** Enable the waveform tap; a no-op once the ATC layer already has one. */
  enableDebug(): void {
    this.debugEnabled = true;
    this.atc?.enableDebugWaveform();
  }

  getDebugSnapshot(): DebugSnapshot | null {
    return this.atc?.getDebugSnapshot() ?? null;
  }

  getDebugWaveform(): Float32Array | null {
    return this.atc?.getDebugWaveform() ?? null;
  }

  /** Start (or resume) playback. Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.disposed || this.running) return;
    const tone = (this.tone ??= await import("tone"));
    // Install a context with our chosen latency hint *before* anything is
    // built or started. "playback" (low-power devices) buys a larger audio
    // buffer, which is the main defense against render-thread underrun clicks.
    if (!this.contextReady) {
      // A larger latency buffer *and* a generous Transport look-ahead: the
      // buffer is the defense against render-thread underrun clicks, the
      // look-ahead is the defense against the worker clock falling behind when
      // the OS throttles background timers (the screen-off failure mode).
      // Both cost latency this ambient player never needs. The clock stays on
      // the "worker" source so it keeps ticking off the main thread.
      tone.setContext(
        new tone.Context({
          latencyHint: this.quality.latencyHint,
          lookAhead: this.quality.lookAhead,
          updateInterval: this.quality.updateInterval,
          clockSource: "worker",
        }),
      );
      this.contextReady = true;
    }
    await tone.start();
    await (this.building ??= this.build(tone));
    if (this.disposed) return;
    this.cancelFade();
    this.running = true;
    // Keep-alive must be blessed inside the gesture (iOS).
    this.startKeepAlive();
    this.atc?.start();
    this.ambient?.start();
    (this.resumer ??= new ContextResumer(tone, () => this.recoverFromResume())).start();
  }

  /** Stop both layers. The graph stays warm for the next `start()`. */
  pause(): void {
    this.running = false;
    this.atc?.stop();
    this.ambient?.stop();
    this.cancelFade();
    this.keepAlive?.pause();
    this.resumer?.stop();
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
    this.fadeTarget = 0;
    this.fadeGain?.gain.rampTo(0, seconds);
  }

  /** Abort an in-progress fade and restore full level. */
  cancelFade(): void {
    this.fadeTarget = 1;
    if (!this.fadeGain || !this.tone) return;
    this.fadeGain.gain.cancelScheduledValues(this.tone.now());
    this.fadeGain.gain.rampTo(1, 0.3);
  }

  /**
   * Called once the AudioContext comes back from a suspend/interruption
   * (screen lock, backgrounded tab, another app's audio session). The render
   * thread can restart mid-buffer, which pops if a node was mid-ramp when it
   * was cut off — so the master fader gets a quick protective fade back up
   * to wherever it was supposed to be resting (full level, or still fading
   * out for an active sleep timer). Any audio elements the OS silently
   * paused are nudged back to life too.
   */
  private recoverFromResume(): void {
    if (!this.running) return;
    if (this.fadeGain && this.tone) {
      const now = this.tone.now();
      const gain = this.fadeGain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(0, now);
      gain.linearRampToValueAtTime(this.fadeTarget, now + 0.25);
    }
    this.atc?.resumeIfNeeded();
    if (this.keepAlive?.paused) {
      void this.keepAlive.play().catch(() => {});
    }
  }

  /** Tear down every node. The engine cannot be restarted afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.resumer?.dispose();
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

    // Master reverb as a send off the summed layers, for shared "air". On
    // low-power devices this whole convolution reverb is skipped — the two
    // sub-layers already carry their own reverbs, so dropping the third saves
    // the most expensive node in the graph without silencing anything.
    if (this.quality.masterReverbEnabled) {
      this.masterReverb = new tone.Reverb({
        decay: this.quality.masterReverbDecay,
        wet: 1,
      });
      this.reverbSend = new tone.Gain(0.15).connect(this.masterReverb);
      this.masterReverb.connect(this.limiter);
      this.fadeGain.connect(this.reverbSend);
    }

    this.radioGain = new tone.Gain(
      sliderToGain(this.radioLevel, RADIO_MAX_GAIN),
    ).connect(this.fadeGain);
    this.musicGain = new tone.Gain(
      sliderToGain(this.musicLevel, MUSIC_MAX_GAIN),
    ).connect(this.fadeGain);

    this.atc = new AtcStreamingLayer(tone, this.radioGain, this.quality);
    this.atc.onStatus = (status) => {
      this.status = status;
      this.onStatus?.(status);
    };
    this.atc.onDebugEvent = (event) => this.onDebugEvent?.(event);
    if (this.debugEnabled) this.atc.enableDebugWaveform();
    // The ambient engine ducks against the live ATC signal, so hand it the
    // radio output node as its sidechain source.
    this.ambient = new AmbientEngine(
      tone,
      this.musicGain,
      this.radioGain,
      this.quality,
    );

    await Promise.all([
      this.atc.init(),
      this.ambient.init(),
      this.masterReverb?.ready ?? Promise.resolve(),
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
