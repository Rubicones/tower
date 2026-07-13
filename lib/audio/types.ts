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
