/** Sleep timer preset in minutes; `null` means infinite (no timer). */
export type TimerPreset = 15 | 30 | 60 | null;

/** Which rung of the failover ladder the ATC layer is playing from. */
export type AtcStatus = "streaming" | "cached" | "offline";

/** One playable tape in the combined manifest. */
export interface TapeEntry {
  identifier: string;
  file: string;
  url: string;
  size: number;
  title: string;
  /** Approximate duration in seconds, when the metadata provides it. */
  lengthSeconds?: number;
  /**
   * "nasa" (Apollo/mission) or "atc" (real aviation ground-to-air/air-to-air).
   * Missing on the bundled offline snapshot's entries — those predate this
   * field and are all NASA anyway; `Playlist.pick()` treats `undefined` as
   * "nasa".
   */
  source?: "nasa" | "atc";
}

/** Shape of the persisted/bundled manifest. */
export interface AtcManifest {
  savedAt: number;
  entries: TapeEntry[];
}

/** The Tone.js module, loaded dynamically on first user gesture. */
export type ToneModule = typeof import("tone");

/** The single Tone.Transport instance, timing authority for the ambient engine. */
export type Transport = ReturnType<ToneModule["getTransport"]>;

/* ---------------------------------------------------------------- */
/* Debug telemetry (dev-only overlay)                                */
/* ---------------------------------------------------------------- */

/** Snapshot of one deck tape for the debug overlay. */
export interface DebugTapeInfo {
  role: "active" | "next" | "spare";
  state: "idle" | "preparing" | "ready" | "playing" | "failed";
  identifier: string | null;
  title: string | null;
  currentTime: number | null;
  duration: number | null;
  bufferedAhead: number | null;
  /** Loudness-normalization correction applied to this tape's fade-in ceiling, dB. */
  normGainDb: number;
}

/** Polled once per watchdog tick; drives the live debug panel. */
export interface DebugSnapshot {
  at: number;
  mode: AtcStatus;
  tapes: DebugTapeInfo[];
  /** Pre-effect bus RMS, dBFS. */
  levelDb: number;
  /** Share of energy in the speech band over the rolling voice window (0-1). */
  speechRatio: number;
  /** Spectral flatness over the rolling voice window (0-1; ~1 = white-noise-like). */
  flatness: number;
  /** Loudest-minus-quietest frame in the rolling window, dB — flags steady tones/hum. */
  modulationDb: number;
  /** Classifier verdict for the rolling window — the same check that trims dead air/static. */
  isVoice: boolean;
  hasSignal: boolean;
  /** ms the current non-voice streak has run, or null if voice is currently detected. */
  silenceMs: number | null;
  /** The randomly-drawn 2-10s cutoff for the current streak. */
  allowedPauseMs: number;
}

/** One line in the debug event log (tape switches, skips, failures, mode changes). */
export interface DebugEvent {
  at: number;
  kind: "start" | "switch" | "silence-skip" | "failure" | "mode";
  message: string;
}
