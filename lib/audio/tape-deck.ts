import type { Gain, Meter } from "tone";
import { ATC_CONFIG } from "./config";
import { randRange } from "./random";
import type { TapeEntry, ToneModule } from "./types";

export type TapeState = "idle" | "preparing" | "ready" | "playing" | "failed";

export interface TapeCallbacks {
  /** Element failed (error / waiting>5s / rejected play). */
  onTapeFailure: (tape: Tape, reason: string) => void;
  /** The active tape ran off the end of the file. */
  onTapeEnded: (tape: Tape) => void;
}

const EQUAL_POWER_STEPS = 33;

function equalPowerCurve(from: number, to: number): number[] {
  const curve: number[] = new Array(EQUAL_POWER_STEPS);
  for (let i = 0; i < EQUAL_POWER_STEPS; i++) {
    const t = i / (EQUAL_POWER_STEPS - 1);
    // Equal-power blend between the two levels; clamp off negative
    // rounding artifacts at the edges.
    const value =
      from * Math.cos((t * Math.PI) / 2) + to * Math.sin((t * Math.PI) / 2);
    curve[i] = Math.max(0, value);
  }
  return curve;
}

/**
 * One reusable `<audio>` element wired into the shared ATC bus:
 *
 *   element -> MediaElementSource -> tape gain -> bus (shared effect chain)
 *                       └────────-> tape meter (pre-gain, for pre-roll checks)
 *
 * `createMediaElementSource` can only be called once per element, so the
 * element + source node live for the lifetime of the deck and tapes are
 * re-armed by swapping `src`.
 */
export class Tape {
  readonly id: number;
  readonly el: HTMLAudioElement;
  readonly gain: Gain;
  entry: TapeEntry | null = null;
  state: TapeState = "idle";

  private readonly tone: ToneModule;
  private readonly meter: Meter;
  private readonly source: MediaElementAudioSourceNode;
  private readonly callbacks: TapeCallbacks;
  private generation = 0;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    id: number,
    tone: ToneModule,
    bus: Gain,
    callbacks: TapeCallbacks,
  ) {
    this.id = id;
    this.tone = tone;
    this.callbacks = callbacks;

    const el = document.createElement("audio");
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.setAttribute("playsinline", "");
    this.el = el;

    this.gain = new tone.Gain(0);
    // Force a stable stereo output. Different tapes (and the fallback clips)
    // are mono or stereo; without this, the channel count entering the shared
    // BiquadFilters flips when a new file loads → "channel count changes may
    // produce audio glitches" and audible clicks. Explicit 2-ch upmixes mono
    // sources so downstream topology never changes.
    try {
      this.gain.channelCount = 2;
      this.gain.channelCountMode = "explicit";
      this.gain.channelInterpretation = "speakers";
    } catch {
      // Some engines disallow overriding these; the graph still works.
    }
    this.gain.connect(bus);
    this.meter = new tone.Meter({ smoothing: 0.8 });
    this.source = tone.getContext().createMediaElementSource(el);
    tone.connect(this.source, this.gain);
    tone.connect(this.source, this.meter);

    el.addEventListener("error", this.handleError);
    el.addEventListener("stalled", this.handleWaiting);
    el.addEventListener("waiting", this.handleWaiting);
    el.addEventListener("playing", this.clearWaitingTimer);
    el.addEventListener("canplay", this.clearWaitingTimer);
    el.addEventListener("ended", this.handleEnded);
  }

  /**
   * Bless the element inside the first user gesture so later programmatic
   * `play()` calls are allowed (iOS Safari requires a gesture per element).
   */
  prime(): void {
    try {
      this.el.load();
    } catch {
      // Nothing to load yet — that's fine, the gesture still counts.
    }
  }

  /** Seconds of media buffered ahead of the playhead. */
  bufferedAhead(): number {
    const { el } = this;
    for (let i = 0; i < el.buffered.length; i++) {
      if (
        el.buffered.start(i) <= el.currentTime &&
        el.currentTime < el.buffered.end(i)
      ) {
        return el.buffered.end(i) - el.currentTime;
      }
    }
    return 0;
  }

  /** Pre-gain RMS of this element's signal, in dB. */
  levelDb(): number {
    const value = this.meter.getValue();
    return typeof value === "number" ? value : Math.max(...value);
  }

  /**
   * Arm this tape: load `entry`, seek to `offset` (clamped clear of the
   * tape tail), buffer at least `minAheadSeconds`, and verify the landing
   * spot isn't dead air (muted pre-roll listen + re-seek).
   * Resolves when ready; rejects on timeout/error/cancellation.
   */
  async prepare(
    entry: TapeEntry,
    offset: number | null,
    minAheadSeconds: number,
    checkPreroll: boolean,
  ): Promise<void> {
    const generation = ++this.generation;
    this.entry = entry;
    this.state = "preparing";
    this.gain.gain.value = 0;
    this.el.src = entry.url;
    this.el.load();

    await this.waitForMetadata(generation);
    // When the manifest didn't know the duration, draw the random offset
    // now that the element's metadata does.
    let target = this.clampOffset(
      offset ?? randRange(0, this.el.duration || 0),
    );
    this.el.currentTime = target;
    await this.waitForBuffer(generation, minAheadSeconds);

    if (checkPreroll) {
      let attempts = 0;
      while (
        attempts < ATC_CONFIG.silence.prerollReseekAttempts &&
        (await this.prerollIsSilent(generation))
      ) {
        attempts += 1;
        target = this.clampOffset(
          randRange(0, this.el.duration || entry.lengthSeconds || 0),
        );
        this.el.currentTime = target;
        await this.waitForBuffer(generation, minAheadSeconds);
      }
    }

    this.assertCurrent(generation);
    this.el.pause();
    this.state = "ready";
  }

  /** Start playing and fade in (equal-power) over `seconds`. */
  async fadeIn(seconds: number): Promise<void> {
    this.state = "playing";
    // Keep the element silent until playback has actually started, then ramp.
    // Scheduling the ramp before play() resolves (mobile latency) makes the
    // audio pop in at a partial gain.
    this.gain.gain.cancelScheduledValues(this.tone.now());
    this.gain.gain.value = 0;
    try {
      await this.el.play();
    } catch (error) {
      this.fail(`play() rejected: ${String(error)}`);
      throw error;
    }
    if (this.disposed) return;
    this.applyFade(equalPowerCurve(this.gain.gain.value, 1), seconds);
  }

  /** Fade out over `seconds`, then pause the element. */
  fadeOut(seconds: number): void {
    this.applyFade(equalPowerCurve(this.gain.gain.value, 0), seconds);
    const generation = this.generation;
    setTimeout(
      () => {
        if (this.generation === generation && !this.disposed) {
          // Guarantee true silence before pausing so the stop never clicks.
          this.gain.gain.cancelScheduledValues(this.tone.now());
          this.gain.gain.value = 0;
          this.el.pause();
          if (this.state === "playing") this.state = "ready";
        }
      },
      seconds * 1000 + 120,
    );
  }

  /**
   * Seek the currently-playing element with a tiny gain dip so the jump
   * doesn't click (used by the in-place silence-skip fallback).
   */
  seekWithDip(target: number): void {
    const now = this.tone.now();
    const current = this.gain.gain.value;
    const dip = 0.05;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(current, now);
    this.gain.gain.linearRampToValueAtTime(0.0001, now + dip);
    this.el.currentTime = target;
    this.gain.gain.linearRampToValueAtTime(current, now + dip * 2);
  }

  /** Hard-mute and stop without fades (used on pause/dispose). */
  halt(): void {
    this.generation += 1;
    this.clearWaitingTimer();
    this.gain.gain.cancelScheduledValues(this.tone.now());
    this.gain.gain.value = 0;
    this.el.pause();
    if (this.state !== "failed") this.state = "idle";
  }

  dispose(): void {
    this.disposed = true;
    this.halt();
    this.el.removeEventListener("error", this.handleError);
    this.el.removeEventListener("stalled", this.handleWaiting);
    this.el.removeEventListener("waiting", this.handleWaiting);
    this.el.removeEventListener("playing", this.clearWaitingTimer);
    this.el.removeEventListener("canplay", this.clearWaitingTimer);
    this.el.removeEventListener("ended", this.handleEnded);
    this.el.removeAttribute("src");
    this.source.disconnect();
    this.gain.dispose();
    this.meter.dispose();
  }

  /* ---------------------------------------------------------------- */

  private applyFade(curve: number[], seconds: number): void {
    const now = this.tone.now();
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueCurveAtTime(curve, now, seconds);
  }

  private clampOffset(offset: number): number {
    const duration = this.el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const max = Math.max(0, duration - ATC_CONFIG.tapeTailAvoidSeconds);
    return Math.min(Math.max(0, offset), max);
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new Error("tape prepare cancelled");
    }
  }

  private waitForMetadata(generation: number): Promise<void> {
    if (this.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        try {
          this.assertCurrent(generation);
        } catch (error) {
          clearInterval(poll);
          reject(error as Error);
          return;
        }
        if (this.el.error) {
          clearInterval(poll);
          reject(new Error(`media error ${this.el.error.code}`));
          return;
        }
        if (this.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() - started > ATC_CONFIG.buffering.prepareTimeoutMs) {
          clearInterval(poll);
          reject(new Error("metadata timeout"));
        }
      }, 200);
    });
  }

  private waitForBuffer(
    generation: number,
    minAheadSeconds: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        try {
          this.assertCurrent(generation);
        } catch (error) {
          clearInterval(poll);
          reject(error as Error);
          return;
        }
        if (this.el.error) {
          clearInterval(poll);
          reject(new Error(`media error ${this.el.error.code}`));
          return;
        }
        const remaining = this.el.duration - this.el.currentTime;
        if (
          this.bufferedAhead() >= Math.min(minAheadSeconds, remaining - 1) ||
          this.el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
        ) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() - started > ATC_CONFIG.buffering.prepareTimeoutMs) {
          clearInterval(poll);
          reject(new Error("buffer timeout"));
        }
      }, 300);
    });
  }

  /**
   * Muted listen: play ~1.2 s with gain at 0 and sample the pre-gain
   * meter. Returns true when the landing spot is silent.
   */
  private async prerollIsSilent(generation: number): Promise<boolean> {
    this.gain.gain.value = 0;
    try {
      await this.el.play();
    } catch {
      return false; // Can't listen ahead — accept the spot.
    }
    let peak = -Infinity;
    const samples = Math.ceil(
      (ATC_CONFIG.silence.prerollSeconds * 1000) /
        ATC_CONFIG.silence.meterIntervalMs,
    );
    for (let i = 0; i < samples; i++) {
      await new Promise((r) =>
        setTimeout(r, ATC_CONFIG.silence.meterIntervalMs),
      );
      this.assertCurrent(generation);
      peak = Math.max(peak, this.levelDb());
    }
    this.el.pause();
    return peak < ATC_CONFIG.silence.thresholdDb;
  }

  private fail(reason: string): void {
    this.state = "failed";
    this.clearWaitingTimer();
    this.callbacks.onTapeFailure(this, reason);
  }

  private readonly handleError = (): void => {
    if (this.disposed) return;
    this.fail(`media error ${this.el.error?.code ?? "unknown"}`);
  };

  private readonly handleWaiting = (): void => {
    if (this.disposed || this.state !== "playing") return;
    if (this.waitingTimer !== null) return;
    this.waitingTimer = setTimeout(() => {
      this.waitingTimer = null;
      if (this.state === "playing") this.fail("waiting > 5s");
    }, ATC_CONFIG.buffering.waitingFailureMs);
  };

  private readonly clearWaitingTimer = (): void => {
    if (this.waitingTimer !== null) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
  };

  private readonly handleEnded = (): void => {
    if (this.disposed) return;
    this.callbacks.onTapeEnded(this);
  };
}

/** The pool of three reusable tapes (active / next / spare). */
export class TapeDeck {
  readonly tapes: [Tape, Tape, Tape];

  constructor(tone: ToneModule, bus: Gain, callbacks: TapeCallbacks) {
    this.tapes = [
      new Tape(0, tone, bus, callbacks),
      new Tape(1, tone, bus, callbacks),
      new Tape(2, tone, bus, callbacks),
    ];
  }

  primeAll(): void {
    for (const tape of this.tapes) tape.prime();
  }

  haltAll(): void {
    for (const tape of this.tapes) tape.halt();
  }

  dispose(): void {
    for (const tape of this.tapes) tape.dispose();
  }
}
