/**
 * All tunables for the streaming ATC layer live here.
 */

/**
 * `nasa` — Apollo/mission air-to-ground tapes. `atc` — real-world aviation
 * ground-to-air / air-to-air chatter (LiveATC.net and independent uploads).
 * Carried through discovery onto every `TapeEntry` so `Playlist.pick()` can
 * weight the mix by category instead of by however many files a given
 * archive.org item happens to contain (a handful of Apollo mission items
 * can easily out-file hundreds of individually-uploaded ATC recordings).
 */
export type SourceCategory = "nasa" | "atc";

/** An audio source: an explicit archive.org item or a search query. */
export type SourceSpec = { category: SourceCategory } & (
  | { kind: "identifier"; identifier: string }
  | { kind: "search"; query: string; rows: number }
);

/**
 * Explicit, hand-verified items — a guaranteed-diverse core across nearly
 * every crewed Apollo mission plus a few real aviation ATC recordings, so
 * the mix never collapses down to just whichever two happened to seed the
 * bundled snapshot. All confirmed to carry a playable .mp3 as of writing
 * (`archive.org/metadata/<id>`).
 */
export const SOURCES: readonly SourceSpec[] = [
  { kind: "identifier", identifier: "Apollo11Audio", category: "nasa" },
  { kind: "identifier", identifier: "Apollo10", category: "nasa" },
  { kind: "identifier", identifier: "Apollo12Audio", category: "nasa" },
  { kind: "identifier", identifier: "Apollo13Audio", category: "nasa" },
  { kind: "identifier", identifier: "Apollo14", category: "nasa" },
  { kind: "identifier", identifier: "Apollo15", category: "nasa" },
  { kind: "identifier", identifier: "Apollo16", category: "nasa" },
  { kind: "identifier", identifier: "Apollo17", category: "nasa" },
  { kind: "identifier", identifier: "Apollo4Audio", category: "nasa" },
  {
    kind: "identifier",
    identifier: "ApolloSoyuzTestProgramastpAudio",
    category: "nasa",
  },
  {
    kind: "identifier",
    identifier: "NasaApollo11OnboardRecordings",
    category: "nasa",
  },
  {
    kind: "identifier",
    identifier: "liveatc_1B9-2-CTAF_20191228",
    category: "atc",
  },
  { kind: "identifier", identifier: "epwa-app-may-26-2023-1500-z", category: "atc" },
  {
    // -identifier:*.zip drops the "Space-to-Grounds" zip bundles, which have
    // no playable derivative (no audio inside is transcoded); everything
    // else in the collection reliably gets an mp3 derivative even when the
    // source was a .wav. ~3k candidates after that filter (of 5.5k total).
    kind: "search",
    query: "collection:nasaaudiocollection AND mediatype:audio AND -identifier:*.zip",
    rows: 150,
    category: "nasa",
  },
  {
    // LiveATC.net's bulk archive.org uploads — real tower/ground/approach
    // recordings from thousands of airports worldwide. ~2.1k candidates; a
    // fraction are monthly .zip bundles with no transcoded audio (identifier
    // doesn't end in .zip so they aren't filterable here) — those just
    // resolve to zero entries and cost nothing beyond one wasted metadata
    // fetch. Guard (121.5) is excluded outright: it's an emergency-monitor
    // frequency that's near-silent by design — 30-minute recordings of it
    // are often <20s of actual audio — so even a `require-voice`-verified
    // landing spot is likely to run straight back into dead air within a
    // few seconds of playback.
    kind: "search",
    query: "identifier:liveatc_* AND -identifier:*Guard*",
    rows: 150,
    category: "atc",
  },
  {
    // Independently-uploaded ATC recordings (not part of the bulk LiveATC.net
    // dump above) tagged by their uploaders — smaller pool, catches items
    // like individual airport approach/tower sessions posted one-off.
    kind: "search",
    query: "subject:atc AND mediatype:audio AND -identifier:*.zip AND -identifier:*Guard*",
    rows: 100,
    category: "atc",
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
    /**
     * Tightened from 2-10s: that range was tuned for tolerating natural
     * mid-sentence pauses, but in practice it let long dead-air/static
     * stretches ride for up to 10s before a skip. 1-3s is enough slack for
     * a breath between words; anything longer is dead air to the listener.
     */
    allowedPauseMinSeconds: 1,
    allowedPauseMaxSeconds: 3,
    meterIntervalMs: 100,
    /** Extra dead air tolerated while waiting for a skip target. */
    graceSeconds: 1.5,
    /** Muted pre-roll listen when preparing a tape (avoid silent landings). */
    prerollSeconds: 1.2,
    prerollReseekAttempts: 3,
    /**
     * Rolling window the *live* watchdog aggregates before classifying the
     * active tape as voice / not-voice (same aggregation as the startup
     * preroll, just running continuously against the playing bus). Shorter
     * than the preroll's 1.2s so the watchdog reacts faster once a tape goes
     * quiet/noisy — the trade is a slightly noisier classification per tick,
     * smoothed out by requiring it hold for the full allowed-pause window
     * before triggering a skip.
     */
    voiceWindowSeconds: 0.8,
    /**
     * Apply the same pre-roll listen to the very first tape so playback opens
     * on radio activity instead of dead air / hiss (re-seeks until it lands on
     * signal above `thresholdDb`). Adds a small startup delay. Disable to start
     * instantly wherever the random seek happens to land.
     */
    startOnSignal: true,
  },

  /**
   * Voice detection for the *first* tape. Being above the silence floor isn't
   * enough — carrier hiss / static clears `silence.thresholdDb` easily, so on
   * start we additionally require a spot that looks like an actual
   * transmission (speech energy, not broadband noise) before opening playback.
   * A short FFT + RMS listen classifies each candidate; if none of the
   * attempts qualifies, the most voice-like spot found is used.
   *
   * Discriminators, all computed on the muted pre-roll listen (or, at
   * runtime, the same rolling window against the live bus):
   * - `minSpeechBandRatio` — fraction of energy inside the speech band. Voice
   *   concentrates in 300–3000 Hz; flat hiss spreads energy up past it.
   * - `maxFlatness` — spectral flatness (geo-mean / arithmetic-mean of the
   *   power spectrum). White noise ≈ 1; voiced speech is far lower.
   * - `minModulationDb` — loudest-minus-quietest frame across the window.
   *   The first two are spectral-*shape* checks alone, and a steady tone
   *   (carrier hum, squelch, colored/resonant static) can land in-band and
   *   non-flat too — it just doesn't move. This third check requires the
   *   window to actually swing in level the way speech between words does.
   *   Tightened from the original defaults after real playback showed
   *   colored static (speech-band-heavy, non-flat, but perfectly steady)
   *   scoring as voice on shape alone; retune against `debug-panel.tsx`'s
   *   live speech/flat/level numbers if a particular tape still slips past.
   */
  voice: {
    /** Re-seeks allowed while hunting for a live transmission at start. */
    reseekAttempts: 5,
    /** Speech energy band (Hz). */
    bandLowHz: 300,
    bandHighHz: 3000,
    /** Full band the ratio is measured against (Hz). */
    totalLowHz: 120,
    totalHighHz: 8000,
    /** Band spectral flatness is measured over (Hz). */
    flatnessLowHz: 300,
    flatnessHighHz: 6000,
    /** Min share of energy in the speech band for a spot to count as voice. */
    minSpeechBandRatio: 0.7,
    /** Max spectral flatness (0–1) for a spot to count as voice. */
    maxFlatness: 0.35,
    /** Min loudest-to-quietest swing (dB) across the window to count as voice. */
    minModulationDb: 5,
    /** FFT size for the listen (power of two, 16–16384). */
    fftSize: 1024,
    /**
     * A single passing listen only proves the exact landing instant is
     * voiced — sparse sources (a quiet regional tower, a rarely-used
     * frequency) can pass that check on a brief blip and then run straight
     * back into silence a few seconds later, which is exactly the
     * skip-lands-in-silence-again loop this exists to prevent. When a spot
     * passes the primary listen, jump `confirmAheadSeconds` further in and
     * listen again before accepting; only both passing counts as a real
     * landing. Playback still starts at the original (earlier) offset.
     */
    confirmAheadSeconds: 8,
  },

  /**
   * Per-tape loudness normalization. Archive.org tapes span decades of
   * recording/transfer gain choices — some transmissions sit at -15 dBFS,
   * others at -35 — so back-to-back tapes at the same fader position can
   * jump jarringly in level, which is exactly wrong for something meant to
   * help someone relax. The muted pre-roll listen already measures the
   * landing spot's average level for the voice/silence check; this reuses
   * that measurement to compute a per-tape gain correction toward
   * `targetDb`, applied as the tape's fade-in ceiling (so it fades in
   * already-corrected rather than fading to full then snapping down).
   *
   * Boost is capped much tighter than cut: the pre-roll only samples ~1.2s,
   * so a tape that's quiet on average can still have louder peaks later on,
   * and over-boosting risks clipping/pumping against the master limiter.
   * Cutting a too-loud tape has no such downside.
   */
  normalization: {
    enabled: true,
    /** Target average level, dBFS (mid-point of the ATC voice.md's -30..-15 range). */
    targetDb: -20,
    /** Max upward correction, dB. */
    maxBoostDb: 6,
    /** Max downward correction, dB. */
    maxCutDb: 14,
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
    /**
     * Cap on metadata fetches per refresh. The search alone can surface
     * ~3k candidates; this just bounds how many `/metadata/<id>` calls one
     * refresh makes; explicit `SOURCES` identifiers are never dropped for
     * this cap (see `discoverIdentifiers`) — only the search-discovered tail
     * competes for the remaining slots, split between categories by
     * `pool.discoveryAtcShare` below.
     */
    maxIdentifiers: 50,
    /** How many `/metadata/<id>` calls run concurrently during a refresh. */
    metadataConcurrency: 6,
    storageKey: "tower.atc.manifest.v1",
  },

  /**
   * Aviation ATC (LiveATC + independent uploads) is the point of the app —
   * Apollo mission tapes are flavor, not the main course. Mission items tend
   * to carry far more files per archive.org identifier than individually
   * uploaded ATC recordings, so leaving the mix to flat per-file random
   * selection quietly makes it Apollo-dominated. Both knobs below correct
   * for that independently: the discovery split controls how many *of each
   * category* even make it into the manifest, and `pickAtcWeight` controls
   * the actual per-pick odds regardless of how that manifest ends up sized.
   */
  pool: {
    /** Share of search-discovered (non-explicit) identifier slots reserved for `atc`. */
    discoveryAtcShare: 0.75,
    /** Probability `Playlist.pick()` draws from the `atc` category over `nasa`. */
    pickAtcWeight: 0.85,
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
