import type {
  Distortion,
  FeedbackDelay,
  FFT,
  Filter,
  Gain,
  Meter,
  Mono,
  PingPongDelay,
  Reverb,
  Waveform,
} from "tone";
import { ATC_CONFIG } from "./config";
import type { AudioQuality } from "./perf";
import { Playlist } from "./playlist";
import { randRange } from "./random";
import {
  classifyListen,
  type FrameFeatures,
  type PrerollMode,
  spectralFeatures,
  type Verdict,
} from "./signal-detector";
import { Tape, TapeDeck } from "./tape-deck";
import type {
  AtcStatus,
  DebugEvent,
  DebugSnapshot,
  DebugTapeInfo,
  TapeEntry,
  ToneModule,
} from "./types";

interface PlayedPosition {
  entry: TapeEntry;
  offset: number;
}

function fallbackEntries(): TapeEntry[] {
  return ATC_CONFIG.fallbackFiles.map((file) => ({
    identifier: "local-fallback",
    file,
    url: `/audio/atc/fallback/${file}`,
    size: 0,
    title: `bundled fallback — ${file}`,
  }));
}

/**
 * The streaming ATC layer. Orchestrates the triple-buffered tape deck:
 *
 * - active plays; next is pre-seeked+buffered for the scheduled rotation;
 *   spare is kept ready for silence skips. Both (and every re-arm after a
 *   switch) are hunted with `require-voice`, not just `avoid-silence` — a
 *   skip exists to escape dead air/static, so its destination must already
 *   be verified speech or the listener just lands in another quiet/noisy
 *   patch and skips again immediately.
 * - Rotation every 60–120 s (equal-power 4–5 s crossfade), interval eased
 *   up after 20 min of continuous play.
 * - A meter+FFT on the pre-effect bus continuously classifies the active
 *   tape (same voice/static discriminator as the startup preroll). Dead air
 *   *and* sustained carrier hiss/static both count as "not voice"; either
 *   one, once it runs longer than a random 2–10 s pause, triggers a 1 s
 *   crossfade into the spare — noise doesn't get to ride out a whole
 *   rotation just because it clears the RMS floor.
 * - Failover ladder: live stream → previously played (SW-cached)
 *   positions → bundled local files; silent recovery with backoff.
 *
 * Effect chain (shared by all tapes):
 *   tape gains -> bus -> bandpass -> waveshaper -> delay -> reverb -> output
 */
export class AtcStreamingLayer {
  onStatus: ((status: AtcStatus) => void) | null = null;
  /** Dev-only telemetry stream — tape switches, skips, failures, mode changes. */
  onDebugEvent: ((event: DebugEvent) => void) | null = null;

  private readonly tone: ToneModule;
  private readonly playlist = new Playlist();
  private readonly deck: TapeDeck;

  private readonly quality: AudioQuality;

  private readonly bus: Gain;
  private readonly mono: Mono;
  private readonly bandpass: Filter;
  private readonly grit: Distortion;
  private readonly delay: FeedbackDelay;
  private readonly pingpong: PingPongDelay | null;
  private readonly reverb: Reverb;
  private readonly watchdog: Meter;
  private readonly watchdogFft: FFT;
  /** Lazily created only when a debug panel subscribes (`enableDebugWaveform`). */
  private debugWaveform: Waveform | null = null;

  private active: Tape;
  private next: Tape;
  private spare: Tape;

  private running = false;
  private disposed = false;
  /** True while the tab is hidden: rotation/skip/watchdog are frozen. */
  private suspended = false;
  private crossfadingUntil = 0;
  private startedAt = 0;

  private mode: AtcStatus = "streaming";
  private consecutiveFailures = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryBackoffMs: number =
    ATC_CONFIG.failover.recoveryBackoffInitialMs;

  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private postponePoll: ReturnType<typeof setInterval> | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;

  private silenceStartedAt: number | null = null;
  private allowedPauseMs = 0;
  /** Rolling window of recent bus frames the watchdog classifies against. */
  private voiceFrames: FrameFeatures[] = [];
  /** Most recent watchdog frame/verdict — surfaced to the debug panel. */
  private lastFrame: FrameFeatures = { db: -Infinity, speechRatio: 0, flatness: 1 };
  private lastVerdict: Verdict = {
    hasSignal: false,
    isVoice: false,
    score: -Infinity,
    modulationDb: 0,
  };
  private skipPending = false;
  private skipDeadline = 0;
  private warnedAboutDeadAir = false;

  private sessionPlayed: PlayedPosition[] = [];

  constructor(tone: ToneModule, output: Gain, quality: AudioQuality) {
    this.tone = tone;
    this.quality = quality;

    this.bus = new tone.Gain(1);
    this.bandpass = new tone.Filter({
      type: "bandpass",
      frequency: 1200,
      Q: 0.55, // wide band-pass ≈ 300–3000 Hz passband
    });
    this.grit = new tone.Distortion({
      distortion: ATC_CONFIG.distortion.amount,
      wet: ATC_CONFIG.distortion.enabled ? ATC_CONFIG.distortion.wet : 0,
    });
    this.delay = new tone.FeedbackDelay({
      delayTime: 0.4,
      feedback: 0.35,
      wet: 0.3,
    });
    // The ping-pong is a second, stereo delay purely for width; on low-power
    // devices it's dropped (two extra delay lines' worth of work) and the mono
    // feedback delay alone carries the echoes.
    this.pingpong = quality.pingPongEnabled
      ? new tone.PingPongDelay({
          delayTime: ATC_CONFIG.pingPong.delayTime,
          feedback: ATC_CONFIG.pingPong.feedback,
          wet: ATC_CONFIG.pingPong.wet,
        })
      : null;
    this.reverb = new tone.Reverb({ decay: quality.atcReverbDecay, wet: 0.5 });

    // Sum the tape bus to mono first, so the dry radio is centered; the
    // ping-pong then bounces only the echoes across L/R for slight width.
    this.mono = new tone.Mono();
    this.bus.chain(
      ...[
        this.mono,
        this.bandpass,
        this.grit,
        this.delay,
        this.pingpong,
        this.reverb,
        output,
      ].filter((node): node is NonNullable<typeof node> => node !== null),
    );

    // RMS + spectral watchdog stay on the pre-effect bus (used for
    // silence/static trimming). Same FFT size as the per-tape preroll listen
    // so `spectralFeatures`/`classifyListen` behave identically at runtime.
    this.watchdog = new tone.Meter({ smoothing: 0.8 });
    this.watchdogFft = new tone.FFT({ size: ATC_CONFIG.voice.fftSize, smoothing: 0 });
    this.bus.connect(this.watchdog);
    this.bus.connect(this.watchdogFft);

    this.deck = new TapeDeck(tone, this.bus, {
      onTapeFailure: this.handleTapeFailure,
      onTapeEnded: this.handleTapeEnded,
    });
    [this.active, this.next, this.spare] = this.deck.tapes;

    // `next`/`spare` are armed from whatever manifest existed at the time —
    // if that was the bundled/stale snapshot, don't wait for the next
    // scheduled rotation to notice a freshly-discovered broad pool exists.
    this.playlist.onRefreshed = () => {
      if (!this.running) return;
      void this.armTape(
        this.next,
        ATC_CONFIG.buffering.minBufferedAheadSeconds,
        "require-voice",
      );
      void this.armTape(
        this.spare,
        ATC_CONFIG.buffering.minBufferedAheadSeconds,
        "require-voice",
      );
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
  }

  async init(): Promise<void> {
    await this.reverb.ready;
  }

  /** Begin playback. Must be called after Tone.start() (user gesture). */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.suspended = false;
    this.startedAt = Date.now();
    this.deck.primeAll();
    this.playlist.refreshIfStale();
    void this.launch();
    this.startWatchdog();
  }

  stop(): void {
    this.running = false;
    this.suspended = false;
    this.clearTimers();
    this.deck.haltAll();
    this.resetVoiceTracking();
    this.skipPending = false;
  }

  /**
   * Called after the shared AudioContext comes back from a suspend /
   * interruption. The context resuming doesn't guarantee the underlying
   * `<audio>` element is still playing — some mobile browsers pause media
   * elements independently during the same event — so nudge it back to life
   * rather than waiting for the 5s `waiting` failure timeout to notice.
   */
  resumeIfNeeded(): void {
    if (!this.running || this.active.state !== "playing") return;
    if (this.active.el.paused) {
      void this.active.el.play().catch(() => {
        // Non-fatal: the normal `waiting`/`error` handling takes over.
      });
    }
  }

  /**
   * While the tab is hidden the mobile browser throttles timers to ~1 s and
   * pauses media elements independently. Running rotations, silence-skips and
   * the watchdog under those conditions is precisely what clicks and stalls
   * with the screen off: every crossfade seeks and re-`play()`s an element the
   * OS has just paused, and the setValueCurveAtTime ramps land on a throttled
   * clock. So we freeze all of that machinery when hidden and let the one
   * active tape keep streaming continuously — the seamless, click-free state —
   * then thaw and resume rotating when the tab comes back to the foreground.
   */
  private readonly handleVisibility = (): void => {
    if (this.disposed || !this.running) return;
    if (typeof document !== "undefined" && document.hidden) {
      this.suspendForBackground();
    } else {
      this.resumeFromBackground();
    }
  };

  private suspendForBackground(): void {
    if (this.suspended) return;
    this.suspended = true;
    // Freeze scheduled work; the active element is left playing untouched.
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.clearPostponePoll();
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    this.skipPending = false;
    this.resetVoiceTracking();
  }

  private resumeFromBackground(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (!this.running) return;
    // Discard any silence/crossfade state accumulated (or frozen) while hidden
    // so the watchdog judges only fresh, post-foreground frames.
    this.crossfadingUntil = 0;
    this.resetVoiceTracking();
    // Nudge the active element in case the OS paused it behind the lock screen.
    this.resumeIfNeeded();
    // The browser can drop the standby tapes' buffers while hidden; re-arm any
    // that are no longer ready so the next rotation has a target.
    if (this.next.state !== "ready") {
      void this.armTape(
        this.next,
        ATC_CONFIG.buffering.minBufferedAheadSeconds,
        "require-voice",
      );
    }
    if (this.spare.state !== "ready") {
      void this.armTape(
        this.spare,
        ATC_CONFIG.buffering.minBufferedAheadSeconds,
        "require-voice",
      );
    }
    this.startWatchdog();
    this.scheduleRotation();
  }

  /* ---------------------------------------------------------------- */
  /* Debug telemetry (dev-only overlay)                                */
  /* ---------------------------------------------------------------- */

  /** Lazily taps the bus with a time-domain analyser for a waveform view. */
  enableDebugWaveform(): void {
    if (this.debugWaveform || this.disposed) return;
    this.debugWaveform = new this.tone.Waveform(2048);
    this.bus.connect(this.debugWaveform);
  }

  /** Latest time-domain samples off the pre-effect bus, or null if not enabled. */
  getDebugWaveform(): Float32Array | null {
    if (!this.debugWaveform) return null;
    const value = this.debugWaveform.getValue();
    return value instanceof Float32Array ? value : null;
  }

  /** Point-in-time snapshot of everything the debug panel needs to render. */
  getDebugSnapshot(): DebugSnapshot {
    const describe = (tape: Tape, role: DebugTapeInfo["role"]): DebugTapeInfo => ({
      role,
      state: tape.state,
      identifier: tape.entry?.identifier ?? null,
      title: tape.entry?.title ?? null,
      currentTime: Number.isFinite(tape.el.currentTime) ? tape.el.currentTime : null,
      duration: Number.isFinite(tape.el.duration) ? tape.el.duration : null,
      bufferedAhead: tape.state === "idle" ? null : tape.bufferedAhead(),
      normGainDb: tape.normGainDb(),
    });
    return {
      at: Date.now(),
      mode: this.mode,
      tapes: [
        describe(this.active, "active"),
        describe(this.next, "next"),
        describe(this.spare, "spare"),
      ],
      levelDb: this.lastFrame.db,
      speechRatio: this.lastFrame.speechRatio,
      flatness: this.lastFrame.flatness,
      modulationDb: this.lastVerdict.modulationDb,
      isVoice: this.lastVerdict.isVoice,
      hasSignal: this.lastVerdict.hasSignal,
      silenceMs: this.silenceStartedAt === null ? null : Date.now() - this.silenceStartedAt,
      allowedPauseMs: this.allowedPauseMs,
    };
  }

  private emitDebug(kind: DebugEvent["kind"], message: string): void {
    this.onDebugEvent?.({ at: Date.now(), kind, message });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
    this.deck.dispose();
    this.watchdog.dispose();
    this.watchdogFft.dispose();
    this.debugWaveform?.dispose();
    this.bus.dispose();
    this.mono.dispose();
    this.bandpass.dispose();
    this.grit.dispose();
    this.delay.dispose();
    this.pingpong?.dispose();
    this.reverb.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Launch & rotation                                                 */
  /* ---------------------------------------------------------------- */

  private async launch(): Promise<void> {
    // Skip silence *and* carrier hiss/static so the first thing heard is an
    // actual transmission (config-toggleable via silence.startOnSignal).
    const ok = await this.armTape(
      this.active,
      ATC_CONFIG.buffering.initialStartAheadSeconds,
      ATC_CONFIG.silence.startOnSignal ? "require-voice" : "none",
    );
    if (!this.running) return;
    if (ok) {
      await this.playTape(this.active, ATC_CONFIG.crossfade.startSeconds);
      this.emitDebug(
        "start",
        `playing ${this.active.entry?.title ?? this.active.entry?.identifier ?? "?"} @ ${Math.round(this.active.el.currentTime)}s`,
      );
    }
    // Pre-buffer the other two in the background regardless; failures
    // route through handleTapeFailure and the ladder.
    void this.armTape(
      this.next,
      ATC_CONFIG.buffering.minBufferedAheadSeconds,
      "require-voice",
    );
    void this.armTape(
      this.spare,
      ATC_CONFIG.buffering.minBufferedAheadSeconds,
      "require-voice",
    );
    this.scheduleRotation();
  }

  private drawRotationMs(): number {
    const { rotation } = ATC_CONFIG;
    const u = Math.random();
    const base =
      rotation.minSeconds + u * (rotation.maxSeconds - rotation.minSeconds);
    if (!rotation.easingEnabled) return base * 1000;
    const elapsedMin = (Date.now() - this.startedAt) / 60_000;
    const progress = Math.min(
      1,
      Math.max(
        0,
        (elapsedMin - rotation.easingStartMinutes) /
          (rotation.easingEndMinutes - rotation.easingStartMinutes),
      ),
    );
    const eased =
      rotation.easedMinSeconds +
      u * (rotation.easedMaxSeconds - rotation.easedMinSeconds);
    return (base + (eased - base) * progress) * 1000;
  }

  private scheduleRotation(): void {
    if (!this.running) return;
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      this.rotate();
    }, this.drawRotationMs());
  }

  /** Scheduled rotation into `next`; postponed until `next` is ready. */
  private rotate(): void {
    if (!this.running) return;
    if (!this.tapeReadyForSwitch(this.next)) {
      // Postpone: check every 3 s until the target has enough buffer.
      if (this.postponePoll) return;
      this.postponePoll = setInterval(() => {
        if (!this.running) {
          this.clearPostponePoll();
          return;
        }
        if (this.tapeReadyForSwitch(this.next)) {
          this.clearPostponePoll();
          this.rotate();
        }
      }, 3_000);
      return;
    }
    void this.switchTo("next", ATC_CONFIG.crossfade.rotationSeconds, "rotation");
    this.scheduleRotation();
  }

  private tapeReadyForSwitch(tape: Tape): boolean {
    return (
      tape.state === "ready" &&
      tape.bufferedAhead() >=
        Math.min(
          ATC_CONFIG.buffering.minBufferedAheadSeconds,
          Math.max(1, tape.el.duration - tape.el.currentTime - 1),
        )
    );
  }

  /**
   * Crossfade from `active` into the given role. The freed element
   * immediately starts preparing a new random file+position for the role
   * it inherits.
   */
  private async switchTo(
    role: "next" | "spare",
    seconds: number,
    reason: string,
  ): Promise<void> {
    const target = role === "next" ? this.next : this.spare;
    const freed = this.active;
    this.crossfadingUntil = Date.now() + seconds * 1000 + 300;
    this.resetVoiceTracking();

    try {
      await this.playTape(target, seconds);
    } catch {
      return; // failure handler already took over
    }
    freed.fadeOut(seconds);

    this.active = target;
    if (role === "next") this.next = freed;
    else this.spare = freed;

    this.emitDebug(
      "switch",
      `${reason} → ${role} (${target.entry?.title ?? target.entry?.identifier ?? "?"} @ ${Math.round(target.el.currentTime)}s)`,
    );

    void this.armTape(
      freed,
      ATC_CONFIG.buffering.minBufferedAheadSeconds,
      "require-voice",
    );
  }

  /** Fade a tape in and record the position for the "cached" rung. */
  private async playTape(tape: Tape, fadeSeconds: number): Promise<void> {
    await tape.fadeIn(fadeSeconds);
    this.consecutiveFailures = 0;
    if (tape.entry && tape.entry.identifier !== "local-fallback") {
      this.sessionPlayed.push({
        entry: tape.entry,
        offset: tape.el.currentTime,
      });
      if (this.sessionPlayed.length > 50) this.sessionPlayed.shift();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Preparing tapes (source selection per failover rung)              */
  /* ---------------------------------------------------------------- */

  private pickForMode(): { entry: TapeEntry; offset: number | null } {
    if (this.mode === "streaming") {
      const entry = this.playlist.pick();
      const offset = entry.lengthSeconds
        ? this.playlist.pickOffset(entry)
        : null;
      return { entry, offset };
    }
    if (this.mode === "cached" && this.sessionPlayed.length > 0) {
      const played =
        this.sessionPlayed[Math.floor(Math.random() * this.sessionPlayed.length)];
      return { entry: played.entry, offset: played.offset };
    }
    const pool = fallbackEntries();
    return {
      entry: pool[Math.floor(Math.random() * pool.length)],
      offset: 0,
    };
  }

  /** Arm a tape with a freshly picked source. Returns success. */
  private async armTape(
    tape: Tape,
    minAheadSeconds: number,
    preroll: PrerollMode,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.running || this.disposed) return false;
      const { entry, offset } = this.pickForMode();
      try {
        await tape.prepare(entry, offset, minAheadSeconds, preroll);
        return true;
      } catch (error) {
        if (!this.running || this.disposed) return false;
        if (String(error).includes("cancelled")) return false;
        this.registerFailure(`prepare failed: ${String(error)}`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Silence watchdog                                                  */
  /* ---------------------------------------------------------------- */

  private startWatchdog(): void {
    // Idempotent: resuming from background restarts it, and start() may too.
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    const windowFrames = Math.max(
      1,
      Math.round(
        (ATC_CONFIG.silence.voiceWindowSeconds * 1000) /
          this.quality.watchdogMeterMs,
      ),
    );
    this.watchdogInterval = setInterval(() => {
      if (!this.running || this.active.state !== "playing") return;
      if (Date.now() < this.crossfadingUntil) {
        this.resetVoiceTracking();
        return;
      }
      const level = this.watchdog.getValue();
      const db = typeof level === "number" ? level : Math.max(...level);
      const frame = spectralFeatures(
        db,
        this.watchdogFft.getValue(),
        (index) => this.watchdogFft.getFrequencyOfIndex(index),
      );
      this.voiceFrames.push(frame);
      if (this.voiceFrames.length > windowFrames) this.voiceFrames.shift();
      this.lastFrame = frame;

      // Same discriminator the startup preroll uses: dead air *and* carrier
      // hiss/static both fail `isVoice`, so both get trimmed on the same
      // 2–10 s clock instead of static riding out a whole rotation because
      // it happens to clear the RMS floor.
      const verdict = classifyListen(this.voiceFrames);
      this.lastVerdict = verdict;
      if (verdict.isVoice) {
        this.silenceStartedAt = null;
        this.warnedAboutDeadAir = false;
        return;
      }
      const now = Date.now();
      if (this.silenceStartedAt === null) {
        this.silenceStartedAt = now;
        this.allowedPauseMs =
          randRange(
            ATC_CONFIG.silence.allowedPauseMinSeconds,
            ATC_CONFIG.silence.allowedPauseMaxSeconds,
          ) * 1000;
        return;
      }
      if (now - this.silenceStartedAt > this.allowedPauseMs) {
        this.triggerSilenceSkip();
      }
      if (
        this.skipPending &&
        now > this.skipDeadline &&
        !this.warnedAboutDeadAir
      ) {
        this.warnedAboutDeadAir = true;
        console.warn(
          "[tower] dead air exceeded allowed pause + grace while waiting for a skip target",
        );
      }
    }, this.quality.watchdogMeterMs);
  }

  /** Skip dead air: crossfade into the spare (does NOT reset rotation). */
  private triggerSilenceSkip(): void {
    if (this.skipPending) return;
    this.emitDebug(
      "silence-skip",
      `not-voice for ${this.allowedPauseMs}ms (db ${this.lastFrame.db.toFixed(1)}, ` +
        `speech ${this.lastFrame.speechRatio.toFixed(2)}, flat ${this.lastFrame.flatness.toFixed(2)}) — skipping`,
    );

    if (this.tapeReadyForSwitch(this.spare)) {
      this.resetVoiceTracking();
      void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds, "silence-skip");
      return;
    }

    // Spare not ready — try seeking the active tape forward in place
    // (a bounded range request), then fall back to waiting for the spare.
    this.skipPending = true;
    this.skipDeadline =
      Date.now() + this.allowedPauseMs + ATC_CONFIG.silence.graceSeconds * 1000;

    const el = this.active.el;
    const jump = randRange(
      ATC_CONFIG.seekForward.minSeconds,
      ATC_CONFIG.seekForward.maxSeconds,
    );
    const target = el.currentTime + jump;
    const safeMax = el.duration - ATC_CONFIG.tapeTailAvoidSeconds;
    const canSeekInPlace = Number.isFinite(el.duration) && target < safeMax;

    if (canSeekInPlace) {
      this.active.seekWithDip(target);
      const seekStartedAt = Date.now();
      const stallPoll = setInterval(() => {
        if (!this.running) {
          clearInterval(stallPoll);
          this.skipPending = false;
          return;
        }
        if (this.active.bufferedAhead() > 1) {
          clearInterval(stallPoll);
          this.skipPending = false;
          // The in-place seek jumped the playhead; stale pre-jump frames
          // must not leak into the post-jump classification.
          this.resetVoiceTracking();
          this.emitDebug(
            "silence-skip",
            `in-place seek +${Math.round(jump)}s (spare not ready) @ ${Math.round(target)}s`,
          );
          return;
        }
        if (Date.now() - seekStartedAt > ATC_CONFIG.buffering.seekStallMs) {
          clearInterval(stallPoll);
          this.holdForSpare();
        }
      }, 250);
      return;
    }
    this.holdForSpare();
  }

  /** Wait (bounded) for the spare to become ready, then crossfade. */
  private holdForSpare(): void {
    const poll = setInterval(() => {
      if (!this.running) {
        clearInterval(poll);
        this.skipPending = false;
        return;
      }
      if (this.tapeReadyForSwitch(this.spare)) {
        clearInterval(poll);
        this.skipPending = false;
        this.resetVoiceTracking();
        void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds, "silence-skip (held)");
      }
    }, 300);
  }

  /* ---------------------------------------------------------------- */
  /* Failures, failover ladder, recovery                               */
  /* ---------------------------------------------------------------- */

  private readonly handleTapeFailure = (tape: Tape, reason: string): void => {
    if (!this.running || this.disposed) return;
    console.warn(`[tower] tape ${tape.id} failed: ${reason}`);
    this.emitDebug("failure", `tape ${tape.id} failed: ${reason}`);
    tape.halt();
    this.registerFailure(reason);

    if (tape === this.active) {
      // Emergency switch — never leave the layer silent.
      if (this.tapeReadyForSwitch(this.next)) {
        void this.switchTo("next", ATC_CONFIG.crossfade.skipSeconds, "failure");
        this.scheduleRotation();
      } else if (this.tapeReadyForSwitch(this.spare)) {
        void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds, "failure");
      } else {
        void this.armTape(
          tape,
          ATC_CONFIG.buffering.initialStartAheadSeconds,
          "none",
        ).then((ok) => {
          if (ok && this.running && tape === this.active) {
            void this.playTape(tape, ATC_CONFIG.crossfade.skipSeconds);
          }
        });
        return;
      }
    }
    void this.armTape(
      tape,
      ATC_CONFIG.buffering.minBufferedAheadSeconds,
      "require-voice",
    );
  };

  private readonly handleTapeEnded = (tape: Tape): void => {
    if (!this.running || tape !== this.active) return;
    // Ran off the end of a tape — rotate immediately.
    if (this.tapeReadyForSwitch(this.next)) {
      void this.switchTo("next", ATC_CONFIG.crossfade.skipSeconds, "tape-ended");
      this.scheduleRotation();
    } else {
      this.handleTapeFailure(tape, "tape ended with no ready target");
    }
  };

  private registerFailure(reason: string): void {
    void reason;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= ATC_CONFIG.failover.failuresBeforeDemotion) {
      this.consecutiveFailures = 0;
      this.demote();
    }
  }

  private demote(): void {
    if (this.mode === "streaming") {
      this.setMode(this.sessionPlayed.length > 0 ? "cached" : "offline");
    } else if (this.mode === "cached") {
      this.setMode("offline");
    }
    this.scheduleRecoveryProbe();
  }

  private setMode(mode: AtcStatus): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onStatus?.(mode);
    this.emitDebug("mode", `failover rung → ${this.mode}`);
  }

  /** Silently probe the network forever (exponential backoff). */
  private scheduleRecoveryProbe(): void {
    if (this.recoveryTimer || this.disposed) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.probeRecovery();
    }, this.recoveryBackoffMs);
    this.recoveryBackoffMs = Math.min(
      this.recoveryBackoffMs * 2,
      ATC_CONFIG.failover.recoveryBackoffMaxMs,
    );
  }

  private async probeRecovery(): Promise<void> {
    if (this.disposed || this.mode === "streaming") return;
    const entries = this.playlist.entries();
    const sample = entries[Math.floor(Math.random() * entries.length)];
    try {
      const response = await fetch(sample.url, {
        headers: { Range: "bytes=0-1023" },
        cache: "no-store",
      });
      if (!response.ok && response.status !== 206) throw new Error("bad status");
      await response.arrayBuffer();
      // Network is back: return to streaming and quietly re-arm the
      // standby tapes; the active tape keeps playing until rotation.
      this.recoveryBackoffMs = ATC_CONFIG.failover.recoveryBackoffInitialMs;
      this.setMode("streaming");
      if (this.running) {
        void this.armTape(
          this.next,
          ATC_CONFIG.buffering.minBufferedAheadSeconds,
          "require-voice",
        );
        void this.armTape(
          this.spare,
          ATC_CONFIG.buffering.minBufferedAheadSeconds,
          "require-voice",
        );
      }
    } catch {
      this.scheduleRecoveryProbe();
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * Clear the silence/static timer and its rolling frame buffer. Call this
   * whenever the playhead jumps discontinuously (tape switch, silence skip,
   * in-place seek) so frames from before the jump never get classified
   * together with frames from after it.
   */
  private resetVoiceTracking(): void {
    this.silenceStartedAt = null;
    this.voiceFrames = [];
  }

  private clearPostponePoll(): void {
    if (this.postponePoll) {
      clearInterval(this.postponePoll);
      this.postponePoll = null;
    }
  }

  private clearTimers(): void {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.clearPostponePoll();
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
}
