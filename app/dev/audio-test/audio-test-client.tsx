"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Candidate tapes to validate against. These are the explicit identifiers
 * shipped in lib/audio/config.ts. archive.org redirects /download/… to a
 * data node (dnNNNNNN.xx.archive.org); the tests below hit that final host,
 * which is where CORS headers actually have to be present.
 */
const TEST_URLS = [
  "https://archive.org/download/Apollo11Audio/11-03301.mp3",
  "https://archive.org/download/Apollo10/10-00149.mp3",
  "https://archive.org/download/NasaApollo11OnboardRecordings/11_highlight_3.mp3",
];

type Verdict = "idle" | "running" | "pass" | "fail";

interface TestState {
  verdict: Verdict;
  lines: string[];
}

const INITIAL: TestState = { verdict: "idle", lines: [] };

function verdictColor(v: Verdict): string {
  if (v === "pass") return "#9dff48";
  if (v === "fail") return "#ff5a5a";
  if (v === "running") return "#ffd15a";
  return "#8a94a6";
}

/** Peak-normalised RMS of a time-domain buffer, in dBFS. */
function rmsDb(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function AudioTestClient() {
  const [url, setUrl] = useState(TEST_URLS[0]);
  const [cors, setCors] = useState<TestState>(INITIAL);
  const [range, setRange] = useState<TestState>(INITIAL);
  const [ios, setIos] = useState<TestState>({
    verdict: "idle",
    lines: [
      "Wire mediaSession, start playback, lock the screen on a real iPhone,",
      "and observe. This check cannot be automated — record results manually.",
    ],
  });

  const ctxRef = useRef<AudioContext | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null);

  useEffect(() => {
    return () => {
      srcRef.current?.disconnect();
      elRef.current?.pause();
      void ctxRef.current?.close();
    };
  }, []);

  /* ----------------------------------------------------------------- */
  /* 1. CORS silence check                                             */
  /* ----------------------------------------------------------------- */

  const runCorsCheck = useCallback(async () => {
    setCors({ verdict: "running", lines: [`Loading ${url}`] });
    const log = (line: string) =>
      setCors((s) => ({ ...s, lines: [...s.lines, line] }));

    try {
      // A single AudioContext + element for the session. createMediaElement-
      // Source can only be called once per element, so build fresh each run.
      srcRef.current?.disconnect();
      elRef.current?.pause();
      await ctxRef.current?.close();

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume();

      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.src = url;
      elRef.current = el;

      const source = ctx.createMediaElementSource(el);
      srcRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // Route through the analyser to the speakers so it is audible too.
      source.connect(analyser);
      analyser.connect(ctx.destination);

      await new Promise<void>((resolve, reject) => {
        const onMeta = () => resolve();
        const onErr = () =>
          reject(new Error(`media error ${el.error?.code ?? "?"}`));
        el.addEventListener("loadedmetadata", onMeta, { once: true });
        el.addEventListener("error", onErr, { once: true });
        setTimeout(() => reject(new Error("metadata timeout")), 15_000);
      });
      log(`Duration ${Math.round(el.duration)}s — seeking to a random spot`);

      // Random seek clear of the final 5 minutes — mirrors production.
      const target = Math.random() * Math.max(0, el.duration - 300);
      el.currentTime = target;
      await el.play();
      log(`Playing from ${Math.round(target)}s; sampling RMS for 4 s…`);

      const buf = new Float32Array(analyser.fftSize);
      let peak = -Infinity;
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        analyser.getFloatTimeDomainData(buf);
        const db = rmsDb(buf);
        if (Number.isFinite(db)) samples.push(db);
        peak = Math.max(peak, db);
      }
      el.pause();

      const avg =
        samples.length > 0
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : -Infinity;
      log(`peak RMS ${peak.toFixed(1)} dBFS · avg ${avg.toFixed(1)} dBFS`);

      // Cross-origin taint yields perfectly silent zeros (-Infinity). Real
      // signal from a NASA tape sits well above -80 dBFS somewhere in 4 s.
      if (Number.isFinite(peak) && peak > -80) {
        log("PASS — real signal through the Web Audio graph (no CORS taint).");
        log("→ Ship the full MediaElementSource + effects routing.");
        setCors((s) => ({ ...s, verdict: "pass" }));
      } else {
        log("FAIL — silent zeros: MediaElementSource is CORS-tainted.");
        log("→ Fall back to plain <audio> streaming (effects skipped).");
        setCors((s) => ({ ...s, verdict: "fail" }));
      }
    } catch (error) {
      log(`ERROR ${String(error)}`);
      setCors((s) => ({ ...s, verdict: "fail" }));
    }
  }, [url]);

  /* ----------------------------------------------------------------- */
  /* 2. Range check                                                    */
  /* ----------------------------------------------------------------- */

  const runRangeCheck = useCallback(async () => {
    setRange({ verdict: "running", lines: ["Requesting bytes 1000000-1001023…"] });
    const log = (line: string) =>
      setRange((s) => ({ ...s, lines: [...s.lines, line] }));
    try {
      const response = await fetch(url, {
        headers: { Range: "bytes=1000000-1001023" },
        cache: "no-store",
      });
      const contentRange = response.headers.get("content-range");
      const acao = response.headers.get("access-control-allow-origin");
      const body = await response.arrayBuffer();
      log(`status ${response.status} (expect 206 Partial Content)`);
      log(`content-range: ${contentRange ?? "(none)"}`);
      log(`access-control-allow-origin: ${acao ?? "(none — but opaque ok)"}`);
      log(`downloaded ${body.byteLength} bytes (expect 1024, NOT the whole file)`);

      if (response.status === 206 && body.byteLength <= 2048) {
        log("PASS — seeking fetches a partial range only.");
        log("→ Confirm in DevTools ▸ Network that scrubbing issues 206s.");
        setRange((s) => ({ ...s, verdict: "pass" }));
      } else {
        log("FAIL — server ignored Range; would download the full tape.");
        setRange((s) => ({ ...s, verdict: "fail" }));
      }
    } catch (error) {
      log(`ERROR ${String(error)}`);
      setRange((s) => ({ ...s, verdict: "fail" }));
    }
  }, [url]);

  /* ----------------------------------------------------------------- */
  /* 3. iOS background check (wires mediaSession, manual observation)   */
  /* ----------------------------------------------------------------- */

  const wireMediaSession = useCallback(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      setIos({
        verdict: "fail",
        lines: ["mediaSession API unavailable in this browser."],
      });
      return;
    }
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: "tower — audio test",
      artist: "airport at 3 am",
    });
    session.playbackState = "playing";
    session.setActionHandler("play", () => void elRef.current?.play());
    session.setActionHandler("pause", () => elRef.current?.pause());
    setIos({
      verdict: "running",
      lines: [
        "mediaSession metadata + play/pause handlers wired.",
        "",
        "Now, on a real iPhone (Safari):",
        "  a) Start the CORS check above so a tape is playing.",
        "  b) Lock the screen. Does MediaElementSource audio continue?",
        "  c) Separately, does Tone.js synthesis (ambient layer) continue?",
        "  d) Do the lock-screen play/pause controls appear and work?",
        "",
        "Record a/b/c/d in the PR. If audio stops on lock → ship plain-<audio>",
        "mode as the lock-screen fallback (documented in the README).",
      ],
    });
  }, []);

  return (
    <main
      style={{
        maxWidth: 860,
        margin: "0 auto",
        padding: "40px 24px 80px",
        fontFamily: "var(--font-jetbrains-mono, monospace)",
        color: "#c9d2e0",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 18, letterSpacing: "0.2em", fontWeight: 300 }}>
        tower · audio risk validation
      </h1>
      <p style={{ color: "#8a94a6" }}>
        Dev-only harness (404 in production). Verifies the three assumptions the
        streaming ATC engine depends on. Open DevTools ▸ Network to watch range
        requests. Results should be reported in the PR description.
      </p>

      <label style={{ display: "block", margin: "24px 0 8px", color: "#8a94a6" }}>
        Test tape
      </label>
      <select
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          background: "#0b0f16",
          color: "#c9d2e0",
          border: "1px solid #232b39",
          borderRadius: 6,
          fontFamily: "inherit",
          fontSize: 12,
        }}
      >
        {TEST_URLS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>

      <TestCard
        index={1}
        title="CORS silence check"
        subtitle="MediaElementSource → AnalyserNode → destination"
        state={cors}
        actionLabel="Run CORS check"
        onRun={runCorsCheck}
      />
      <TestCard
        index={2}
        title="Range check"
        subtitle="random seek must fetch a partial range, not the whole tape"
        state={range}
        actionLabel="Run range check"
        onRun={runRangeCheck}
      />
      <TestCard
        index={3}
        title="iOS background check"
        subtitle="lock-screen behaviour (manual) + mediaSession wiring"
        state={ios}
        actionLabel="Wire mediaSession"
        onRun={wireMediaSession}
      />
    </main>
  );
}

function TestCard({
  index,
  title,
  subtitle,
  state,
  actionLabel,
  onRun,
}: {
  index: number;
  title: string;
  subtitle: string;
  state: TestState;
  actionLabel: string;
  onRun: () => void;
}) {
  return (
    <section
      style={{
        marginTop: 28,
        border: "1px solid #232b39",
        borderRadius: 10,
        padding: 18,
        background: "#0a0e15",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14 }}>
            {index}. {title}{" "}
            <span
              style={{
                color: verdictColor(state.verdict),
                textTransform: "uppercase",
                fontSize: 11,
                letterSpacing: "0.15em",
              }}
            >
              · {state.verdict}
            </span>
          </div>
          <div style={{ color: "#6b7485", fontSize: 11 }}>{subtitle}</div>
        </div>
        <button
          onClick={onRun}
          disabled={state.verdict === "running"}
          style={{
            padding: "8px 14px",
            background: state.verdict === "running" ? "#1a2130" : "#141a26",
            color: "#c9d2e0",
            border: "1px solid #2b3546",
            borderRadius: 6,
            cursor: state.verdict === "running" ? "default" : "pointer",
            fontFamily: "inherit",
            fontSize: 12,
            whiteSpace: "nowrap",
          }}
        >
          {actionLabel}
        </button>
      </div>
      {state.lines.length > 0 && (
        <pre
          style={{
            marginTop: 14,
            padding: 12,
            background: "#05070a",
            borderRadius: 6,
            color: "#9aa6b8",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {state.lines.join("\n")}
        </pre>
      )}
    </section>
  );
}
