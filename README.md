# tower

A single-screen relaxation/sleep app. Public-domain NASA air-to-ground radio —
streamed from [archive.org](https://archive.org), processed with a radio-atmosphere
effect chain — plays over an endlessly generated ambient music layer. Dark, quiet,
airport at 3 AM. The listener perceives one continuous, curated late-night radio
atmosphere: tapes rotate between missions, long dead-air stretches are cut, and the
stream never audibly fails.

Built with Next.js (App Router), TypeScript strict, and Tone.js. No backend, no
accounts; fully static deployable and installable as a PWA.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm start        # serve the production build
```

Audio starts only after you tap play (browser autoplay policy — the AudioContext
is created inside that tap). Sleep-timer presets are 15 / 30 / 60 minutes / ∞; a
timed session fades both layers to silence over the final 60 seconds, then stops.

## Architecture

All audio lives in `lib/audio/`; components never touch Tone.js. The
`useAudioEngine()` hook (`lib/audio/use-audio-engine.ts`) is the single seam
between React and the engine, exposing `{ isPlaying, toggle, radioVolume,
setRadioVolume, musicVolume, setMusicVolume, timer, setTimer, remainingSeconds,
status }`, where `status` is the current ATC failover rung
(`"streaming" | "cached" | "offline"`). The engine is disposable — the graph is
torn down on unmount, which also keeps hot reload clean.

### Master graph (`engine.ts`)

```
ATC streaming layer ─▶ radioGain ─┐
                                   ├─▶ fadeGain ─┬─▶ Limiter ─▶ destination
ambient synthesis   ─▶ musicGain ──┘            └─▶ send ─▶ master Reverb ─▶ Limiter
```

The `radio` slider controls `radioGain`; `music` controls `musicGain`. The sleep
timer ramps `fadeGain` to 0. The ambient layer (`ambient-layer.ts`) is pure
Tone.js synthesis (pad chords + sparse FM bells from D-minor pentatonic) and is
unchanged from the original engine.

### The ATC streaming layer

The radio layer streams NASA tapes (30–60 MB each) **by range only — full files
are never downloaded**. Three subsystems cooperate:

#### 1. Triple-buffer tape deck (`tape-deck.ts`)

A pool of **three reusable `<audio>` elements**, each permanently wired into the
shared effect bus:

```
<audio preload=auto crossOrigin=anonymous> ─▶ MediaElementSource ─▶ tape Gain ─▶ bus
                                                       └─▶ tape Meter (pre-gain)
```

`createMediaElementSource` can only be called once per element, so elements live
for the lifetime of the deck; tapes are re-armed by swapping `src` and seeking.
The three roles rotate:

- **active** — playing.
- **next** — pre-seeked, pre-buffered, muted; the scheduled rotation target.
- **spare** — kept prepared at another random position for silence-skip jumps.

Preparing a tape: set `src`, wait for metadata, seek to a random `currentTime`
(clear of the final 5 minutes), and buffer until ≥20 s is available ahead of the
playhead (`buffered` ranges are checked directly). A muted **pre-roll listen**
then samples the pre-gain meter; if the landing spot is silent it re-seeks, so
the deck never crossfades into dead air. A switch may only happen into an element
that is `ready` with enough buffer — otherwise the switch is **postponed** until
it is.

Every element handles `error` / `stalled` / `waiting`; `waiting > 5 s` counts as
a failure of that element (a replacement is prepared, and the layer fails over if
the failed element was active).

#### 2. Rotation & selection (`atc-streaming-layer.ts`, `playlist.ts`)

- Every **60–120 s** (re-randomised each cycle) an **equal-power ~4.5 s
  crossfade** moves from `active` to `next`. Crossfades happen at the per-element
  gain nodes *before* the shared chain, so reverb/delay tails carry across the
  switch — this is what makes rotation seamless.
- **Selection** never repeats a file twice in a row and keeps a 10-pick history,
  biasing *against* recently played files **and** recently played identifiers, so
  consecutive segments come from genuinely different tapes/missions.
- **Easing**: after 20 minutes of continuous playback the rotation interval
  stretches linearly toward 4–6 minutes by the 40-minute mark (the listener is
  asleep; save battery/data). Toggle with `rotation.easingEnabled` in config.

#### 3. Silence trimming (key feature)

A pre-gain `Meter` watches the summed tape bus ~10×/second.

- When RMS drops below `silence.thresholdDb`, a silence timer starts and draws
  `allowedPause = random(2, 10) s`.
- If signal returns first → nothing happens (natural pause preserved).
- If silence exceeds `allowedPause` → a short (~1 s) crossfade into the **spare**
  (a random position, same or different tape). This skip does **not** reset the
  rotation timer. A new spare is prepared immediately.
- If the spare isn't ready, the layer first tries seeking the active element
  forward by +60–180 s (a bounded range request); if that stalls > 3 s it holds
  for the spare. Dead air is tolerated only up to `allowedPause + grace`; beyond
  that a warning is logged.

### Failover ladder (`atc-streaming-layer.ts`)

Automatic, always via crossfade, three rungs:

```
live stream ──(3 consecutive failures)──▶ cached ──▶ offline
   ▲                                                    │
   └──────────── silent recovery (exp. backoff) ────────┘
```

- **streaming** — random tapes/positions from archive.org.
- **cached** — replays positions already played this session (their ranges are in
  the service-worker audio pool, so they load without new network).
- **offline** — the three bundled clips in `public/audio/atc/fallback/`.

After demotion the layer probes the network on exponential backoff
(15 s → 10 min, forever). When a probe succeeds it silently returns to
**streaming** and re-arms the standby tapes; the active tape keeps playing until
the next rotation, so recovery is inaudible. The current rung is surfaced through
`useAudioEngine().status`.

### Service worker (`public/sw.js`, production only)

Caches only **same-origin** assets: `/`, the web manifest, icons, `silence.mp3`,
and the three fallback clips (cache-first), plus `/_next/static/` chunks.

The service worker deliberately **does not** intercept archive.org. The tapes are
streamed with open-ended HTTP range requests that the media element aborts on
every seek; a worker cannot cache/replay those `206` responses without forcing
full-file downloads and breaking the media pipeline ("ServiceWorker intercepted
the request and encountered an unexpected error"). Range streaming and its cache
are left to the browser, which handles them natively. Offline resilience comes
from the in-app **failover ladder** (live → session replay → bundled fallbacks),
not from the worker.

### Mobile / lock screen

`Tone.start()` runs inside the play tap. A silent looping `<audio>` keeps the iOS
audio session alive behind the lock screen, and the Media Session API provides
lock-screen metadata + play/pause. Every `<audio>` element uses `playsinline`.

## Configuration

Everything tunable lives in **`lib/audio/config.ts`**: the `SOURCES` list,
rotation interval range (+ easing), pause range, silence threshold, crossfade
durations, buffering thresholds, cache/history sizes, the distortion toggle, and
the failover/backoff parameters.

### Adding / removing archive.org sources

`SOURCES` accepts two kinds of entry:

```ts
export const SOURCES = [
  { kind: "identifier", identifier: "Apollo11Audio" },      // explicit item
  { kind: "search", query: "collection:nasaaudiocollection AND mediatype:audio", rows: 50 },
];
```

At refresh time the discovery pipeline (`playlist.ts`) resolves search queries
via `archive.org/advancedsearch.php`, merges + dedupes with the explicit
identifiers, caps the total at `manifest.maxIdentifiers`, then fetches
`archive.org/metadata/{id}` for each and keeps every `.mp3` ≥ `minFileBytes`
(1 MB). The combined manifest `{ identifier, file, url, size, title,
lengthSeconds }[]` is cached in `localStorage` with a **7-day TTL** and seeded by
a **bundled build-time snapshot** (`manifest.snapshot.json`). Resolution order at
startup: fresh cache → stale cache → bundled snapshot; a stale cache triggers a
background refresh. To add sources, edit `SOURCES`; to refresh the bundled seed,
regenerate `manifest.snapshot.json`.

### Tuning the silence threshold

`silence.thresholdDb` (default **−48 dBFS**) separates transmissions/static from
tape hiss / dead air. It was calibrated against the Apollo tapes, whose noise
floor sits around −60 dBFS while transmissions land in the −30…−15 dBFS range, so
−48 dBFS reliably catches real dead air without clipping quiet chatter. Different
material has a different noise floor — retune with the live meter on
`/dev/audio-test`:

- If natural pauses get skipped too eagerly, **lower** the threshold (e.g. −54).
- If long dead air is not being trimmed, **raise** it (e.g. −42).

## Risk validation — `/dev/audio-test`

The streaming design assumes three things; the dev-only harness at
**`/dev/audio-test`** (404 in production) verifies them. Run `npm run dev` and
open it, with DevTools ▸ Network open.

1. **CORS silence check** — routes a `MediaElementSource` from an archive.org
   tape through an `AnalyserNode` and measures RMS. Cross-origin taint is *silent
   zeros*, not an error, so it must be measured. archive.org serves
   `access-control-allow-origin: *` on its data nodes, so with
   `crossOrigin="anonymous"` the graph produces **real signal** → the full Web
   Audio + effects routing ships. (If this ever fails for a source, the fallback
   is plain-`<audio>` streaming with effects skipped.)
2. **Range check** — a random seek issues `Range: bytes=…` and receives
   `206 Partial Content` with a `Content-Range` header, downloading ~1 KB instead
   of the whole tape. Confirm in the Network tab that scrubbing issues 206s.
3. **iOS background check** — `mediaSession` metadata + play/pause handlers are
   wired regardless; lock-screen behaviour of (a) the MediaElementSource chain
   and (b) Tone.js synthesis must be observed manually on a real iPhone and
   recorded. If audio stops on lock, ship plain-`<audio>` as the lock-screen
   fallback (documented here).

## Fallback clips

`public/audio/atc/fallback/fallback-0{1,2,3}.mp3` are ~2-minute synthesized
radio-static beds (public domain, no long silences) generated with ffmpeg. They
are the last rung of the failover ladder. Replace them with your own
royalty-free/public-domain clips if you like — keep them short and silence-free,
and bump `APP_CACHE` in `public/sw.js` so the service worker refreshes them.
