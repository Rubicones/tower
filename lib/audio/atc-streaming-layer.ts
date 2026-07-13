import type {
  Distortion,
  FeedbackDelay,
  Filter,
  Gain,
  Meter,
  Mono,
  PingPongDelay,
  Reverb,
} from "tone";
import { ATC_CONFIG } from "./config";
import { Playlist } from "./playlist";
import { randRange } from "./random";
import { Tape, TapeDeck } from "./tape-deck";
import type { AtcStatus, TapeEntry, ToneModule } from "./types";

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
 *   spare is kept ready for silence skips.
 * - Rotation every 60–120 s (equal-power 4–5 s crossfade), interval eased
 *   up after 20 min of continuous play.
 * - A meter on the pre-effect bus watches RMS; silence longer than a
 *   random 2–10 s pause triggers a 1 s crossfade into the spare.
 * - Failover ladder: live stream → previously played (SW-cached)
 *   positions → bundled local files; silent recovery with backoff.
 *
 * Effect chain (shared by all tapes):
 *   tape gains -> bus -> bandpass -> waveshaper -> delay -> reverb -> output
 */
export class AtcStreamingLayer {
  onStatus: ((status: AtcStatus) => void) | null = null;

  private readonly tone: ToneModule;
  private readonly playlist = new Playlist();
  private readonly deck: TapeDeck;

  private readonly bus: Gain;
  private readonly mono: Mono;
  private readonly bandpass: Filter;
  private readonly grit: Distortion;
  private readonly delay: FeedbackDelay;
  private readonly pingpong: PingPongDelay;
  private readonly reverb: Reverb;
  private readonly watchdog: Meter;

  private active: Tape;
  private next: Tape;
  private spare: Tape;

  private running = false;
  private disposed = false;
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
  private skipPending = false;
  private skipDeadline = 0;
  private warnedAboutDeadAir = false;

  private sessionPlayed: PlayedPosition[] = [];

  constructor(tone: ToneModule, output: Gain) {
    this.tone = tone;

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
    this.pingpong = new tone.PingPongDelay({
      delayTime: ATC_CONFIG.pingPong.delayTime,
      feedback: ATC_CONFIG.pingPong.feedback,
      wet: ATC_CONFIG.pingPong.wet,
    });
    this.reverb = new tone.Reverb({ decay: 7, wet: 0.5 });

    // Sum the tape bus to mono first, so the dry radio is centered; the
    // ping-pong then bounces only the echoes across L/R for slight width.
    this.mono = new tone.Mono();
    this.bus.chain(
      this.mono,
      this.bandpass,
      this.grit,
      this.delay,
      this.pingpong,
      this.reverb,
      output,
    );

    // RMS watchdog stays on the pre-effect bus (used for silence trimming).
    this.watchdog = new tone.Meter({ smoothing: 0.8 });
    this.bus.connect(this.watchdog);

    this.deck = new TapeDeck(tone, this.bus, {
      onTapeFailure: this.handleTapeFailure,
      onTapeEnded: this.handleTapeEnded,
    });
    [this.active, this.next, this.spare] = this.deck.tapes;
  }

  async init(): Promise<void> {
    await this.reverb.ready;
  }

  /** Begin playback. Must be called after Tone.start() (user gesture). */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.startedAt = Date.now();
    this.deck.primeAll();
    this.playlist.refreshIfStale();
    void this.launch();
    this.startWatchdog();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.deck.haltAll();
    this.silenceStartedAt = null;
    this.skipPending = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.deck.dispose();
    this.watchdog.dispose();
    this.bus.dispose();
    this.mono.dispose();
    this.bandpass.dispose();
    this.grit.dispose();
    this.delay.dispose();
    this.pingpong.dispose();
    this.reverb.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Launch & rotation                                                 */
  /* ---------------------------------------------------------------- */

  private async launch(): Promise<void> {
    const ok = await this.armTape(
      this.active,
      ATC_CONFIG.buffering.initialStartAheadSeconds,
      false,
    );
    if (!this.running) return;
    if (ok) {
      await this.playTape(this.active, ATC_CONFIG.crossfade.startSeconds);
    }
    // Pre-buffer the other two in the background regardless; failures
    // route through handleTapeFailure and the ladder.
    void this.armTape(this.next, ATC_CONFIG.buffering.minBufferedAheadSeconds, true);
    void this.armTape(this.spare, ATC_CONFIG.buffering.minBufferedAheadSeconds, true);
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
    void this.switchTo("next", ATC_CONFIG.crossfade.rotationSeconds);
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
  private async switchTo(role: "next" | "spare", seconds: number): Promise<void> {
    const target = role === "next" ? this.next : this.spare;
    const freed = this.active;
    this.crossfadingUntil = Date.now() + seconds * 1000 + 300;
    this.silenceStartedAt = null;

    try {
      await this.playTape(target, seconds);
    } catch {
      return; // failure handler already took over
    }
    freed.fadeOut(seconds);

    this.active = target;
    if (role === "next") this.next = freed;
    else this.spare = freed;

    void this.armTape(
      freed,
      ATC_CONFIG.buffering.minBufferedAheadSeconds,
      true,
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
    checkPreroll: boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.running || this.disposed) return false;
      const { entry, offset } = this.pickForMode();
      try {
        await tape.prepare(entry, offset, minAheadSeconds, checkPreroll);
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
    this.watchdogInterval = setInterval(() => {
      if (!this.running || this.active.state !== "playing") return;
      if (Date.now() < this.crossfadingUntil) {
        this.silenceStartedAt = null;
        return;
      }
      const level = this.watchdog.getValue();
      const db = typeof level === "number" ? level : Math.max(...level);

      if (db >= ATC_CONFIG.silence.thresholdDb) {
        // Signal present — natural pause never got too long.
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
    }, ATC_CONFIG.silence.meterIntervalMs);
  }

  /** Skip dead air: crossfade into the spare (does NOT reset rotation). */
  private triggerSilenceSkip(): void {
    if (this.skipPending) return;

    if (this.tapeReadyForSwitch(this.spare)) {
      this.silenceStartedAt = null;
      void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds);
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
      el.currentTime = target;
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
          this.silenceStartedAt = null;
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
        this.silenceStartedAt = null;
        void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds);
      }
    }, 300);
  }

  /* ---------------------------------------------------------------- */
  /* Failures, failover ladder, recovery                               */
  /* ---------------------------------------------------------------- */

  private readonly handleTapeFailure = (tape: Tape, reason: string): void => {
    if (!this.running || this.disposed) return;
    console.warn(`[tower] tape ${tape.id} failed: ${reason}`);
    tape.halt();
    this.registerFailure(reason);

    if (tape === this.active) {
      // Emergency switch — never leave the layer silent.
      if (this.tapeReadyForSwitch(this.next)) {
        void this.switchTo("next", ATC_CONFIG.crossfade.skipSeconds);
        this.scheduleRotation();
      } else if (this.tapeReadyForSwitch(this.spare)) {
        void this.switchTo("spare", ATC_CONFIG.crossfade.skipSeconds);
      } else {
        void this.armTape(
          tape,
          ATC_CONFIG.buffering.initialStartAheadSeconds,
          false,
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
      true,
    );
  };

  private readonly handleTapeEnded = (tape: Tape): void => {
    if (!this.running || tape !== this.active) return;
    // Ran off the end of a tape — rotate immediately.
    if (this.tapeReadyForSwitch(this.next)) {
      void this.switchTo("next", ATC_CONFIG.crossfade.skipSeconds);
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
        void this.armTape(this.next, ATC_CONFIG.buffering.minBufferedAheadSeconds, true);
        void this.armTape(this.spare, ATC_CONFIG.buffering.minBufferedAheadSeconds, true);
      }
    } catch {
      this.scheduleRecoveryProbe();
    }
  }

  /* ---------------------------------------------------------------- */

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
