/**
 * All tunables for the streaming ATC layer live here.
 */

/** An audio source: an explicit archive.org item or a search query. */
export type SourceSpec =
  | { kind: "identifier"; identifier: string }
  | { kind: "search"; query: string; rows: number };

export const SOURCES: readonly SourceSpec[] = [
  { kind: "identifier", identifier: "Apollo11Audio" },
  { kind: "identifier", identifier: "Apollo10" },
  { kind: "identifier", identifier: "NasaApollo11OnboardRecordings" },
  {
    kind: "search",
    query: "collection:nasaaudiocollection AND mediatype:audio",
    rows: 50,
  },
];

export const ATC_CONFIG = {
  /** Rotation between tapes. */
  rotation: {
    minSeconds: 60,
    maxSeconds: 120,
    /**
     * After `easingStartMinutes` of continuous playback the rotation
     * interval stretches linearly, reaching eased range at
     * `easingEndMinutes` (listener is asleep; save battery and data).
     */
    easingEnabled: true,
    easedMinSeconds: 240,
    easedMaxSeconds: 360,
    easingStartMinutes: 20,
    easingEndMinutes: 40,
  },

  /**
   * Silence trimming. RMS is measured pre-effects on the summed tape bus.
   * `thresholdDb` separates tape hiss / dead air from transmissions+static.
   * Default derived from the noise floor of the Apollo11Audio tapes
   * (hiss ≈ -60 dBFS, transmissions ≈ -30..-15 dBFS); the /dev/audio-test
   * page shows a live meter for re-tuning against other material.
   */
  silence: {
    thresholdDb: -48,
    allowedPauseMinSeconds: 2,
    allowedPauseMaxSeconds: 10,
    meterIntervalMs: 100,
    /** Extra dead air tolerated while waiting for a skip target. */
    graceSeconds: 3,
    /** Muted pre-roll listen when preparing a tape (avoid silent landings). */
    prerollSeconds: 1.2,
    prerollReseekAttempts: 3,
  },

  crossfade: {
    rotationSeconds: 4.5,
    /** Silence-skip crossfade — shorter than rotation. */
    skipSeconds: 1,
    /** First fade-in from nothing. */
    startSeconds: 1,
  },

  buffering: {
    /** A switch may only happen into an element with this much buffered. */
    minBufferedAheadSeconds: 20,
    /** First tape may start with less so playback begins quickly. */
    initialStartAheadSeconds: 5,
    prepareTimeoutMs: 30_000,
    /** `waiting` longer than this counts as element failure. */
    waitingFailureMs: 5_000,
    /** Stall budget for an in-place forward seek during a silence skip. */
    seekStallMs: 3_000,
  },

  /** Never land inside the final stretch of a tape. */
  tapeTailAvoidSeconds: 300,

  /** In-place forward jump when the spare isn't ready for a silence skip. */
  seekForward: { minSeconds: 60, maxSeconds: 180 },

  /** Radio-grit waveshaper. Toggleable; keep the drive subtle. */
  distortion: { enabled: true, amount: 0.08, wet: 0.3 },

  /**
   * The ATC bus is summed to mono, then a subtle ping-pong delay bounces the
   * echoes L/R for a hint of stereo movement over the mono dry signal. This is
   * layered on top of the default (mono) feedback delay.
   */
  pingPong: { delayTime: 0.28, feedback: 0.25, wet: 0.22 },

  manifest: {
    ttlDays: 7,
    minFileBytes: 1_000_000,
    /** Cap on metadata fetches per refresh (search can return thousands). */
    maxIdentifiers: 8,
    storageKey: "tower.atc.manifest.v1",
  },

  /** Anti-repetition memory. Weights multiply a candidate's probability. */
  history: { size: 10, fileWeight: 0.15, identifierWeight: 0.4 },

  /** Failover ladder. */
  failover: {
    /** Consecutive failures before dropping one rung. */
    failuresBeforeDemotion: 3,
    /** Exponential backoff for silent recovery probes (ms). */
    recoveryBackoffInitialMs: 15_000,
    recoveryBackoffMaxMs: 10 * 60_000,
  },

  /** Bundled last-resort clips in /public/audio/atc/fallback/. */
  fallbackFiles: [
    "fallback-01.mp3",
    "fallback-02.mp3",
    "fallback-03.mp3",
  ],
} as const;

export type AtcConfig = typeof ATC_CONFIG;
