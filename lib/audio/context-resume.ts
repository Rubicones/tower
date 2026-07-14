import type { ToneModule } from "./types";

/**
 * Backstop poll while the tab is hidden. `visibilitychange` / `focus` /
 * `pageshow` cover the normal cases, but none of them are guaranteed to fire
 * promptly on every mobile browser (iOS Safari in particular can interrupt
 * the AudioContext — a phone call, Siri, another app's audio session —
 * without ever touching document visibility). Polling is cheap and only
 * runs while playback is supposed to be live.
 */
const POLL_MS = 3_000;

/**
 * Mobile browsers can suspend or interrupt the shared AudioContext when the
 * screen locks, the tab is backgrounded, or another app grabs audio focus.
 * Nothing resumes it automatically — the render thread just stops, and the
 * music silently stops with it until the page is reopened. This watches
 * every signal that we might be back and asks the context to resume.
 *
 * Resuming a render thread that was cut mid-buffer can pop if a node was
 * mid-ramp when it was interrupted, so a successful resume also gets a
 * chance to run a protective fade via `onResumed`.
 */
export class ContextResumer {
  private pollId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private resuming = false;

  constructor(
    private readonly tone: ToneModule,
    private readonly onResumed: () => void,
  ) {
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("focus", this.wake);
    window.addEventListener("pageshow", this.wake);
  }

  /** Call once playback starts; stop on pause so the poll doesn't run idle. */
  start(): void {
    if (this.pollId !== null || this.disposed) return;
    this.pollId = setInterval(this.wake, POLL_MS);
  }

  stop(): void {
    if (this.pollId !== null) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("focus", this.wake);
    window.removeEventListener("pageshow", this.wake);
  }

  private readonly wake = (): void => {
    void this.tryResume();
  };

  private async tryResume(): Promise<void> {
    if (this.disposed || this.resuming) return;
    const context = this.tone.getContext();
    // Read through a function so TS doesn't (incorrectly) narrow this as a
    // one-shot value across the `await` below — `state` can change from
    // underneath us while `resume()` is in flight.
    const state = (): AudioContextState => context.state;
    if (state() === "running") return;
    this.resuming = true;
    try {
      await context.resume();
      if (!this.disposed && state() === "running") this.onResumed();
    } catch {
      // Transient — retried on the next wake event or poll tick.
    } finally {
      this.resuming = false;
    }
  }
}
