"use client";

import { useEffect, useRef, useState } from "react";
import type { UseAudioEngineResult } from "@/lib/audio/use-audio-engine";
import type { DebugEvent, DebugSnapshot, DebugTapeInfo } from "@/lib/audio/types";

const MAX_EVENTS = 40;
const POLL_MS = 150;

function fmtTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function fmtDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-inf";
}

function eventColor(kind: DebugEvent["kind"]): string {
  switch (kind) {
    case "start":
      return "#9dff48";
    case "switch":
      return "#5ac8ff";
    case "silence-skip":
      return "#ffd15a";
    case "failure":
      return "#ff5a5a";
    case "mode":
      return "#c98bff";
  }
}

/** RMS level, clamped -70..-10 dBFS, mapped to a 0-100% bar. */
function levelPercent(db: number): number {
  const clamped = Math.max(-70, Math.min(-10, db));
  return ((clamped + 70) / 60) * 100;
}

function TapeRow({ tape }: { tape: DebugTapeInfo }) {
  const stateColor =
    tape.state === "playing"
      ? "#9dff48"
      : tape.state === "ready"
        ? "#5ac8ff"
        : tape.state === "preparing"
          ? "#ffd15a"
          : tape.state === "failed"
            ? "#ff5a5a"
            : "#6b7485";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}>
      <span style={{ color: "#6b7485", width: 44, flexShrink: 0 }}>{tape.role}</span>
      <span style={{ color: stateColor, width: 62, flexShrink: 0 }}>{tape.state}</span>
      <span
        style={{
          color: "#c9d2e0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
        title={tape.identifier ?? undefined}
      >
        {tape.title ?? tape.identifier ?? "—"}
      </span>
      <span style={{ color: "#8a94a6", flexShrink: 0 }}>
        {fmtTime(tape.currentTime)}/{fmtTime(tape.duration)}
      </span>
      <span style={{ color: "#8a94a6", width: 44, textAlign: "right", flexShrink: 0 }}>
        buf {tape.bufferedAhead !== null ? Math.round(tape.bufferedAhead) : "-"}s
      </span>
      <span
        style={{
          color: tape.normGainDb === 0 ? "#4a5468" : "#8a94a6",
          width: 48,
          textAlign: "right",
          flexShrink: 0,
        }}
        title="loudness normalization correction"
      >
        {tape.normGainDb >= 0 ? "+" : ""}
        {tape.normGainDb.toFixed(1)}dB
      </span>
    </div>
  );
}

/**
 * Dev-only telemetry overlay for the ATC streaming layer: which tape is
 * playing and where, live level/voice classification (the same signal that
 * drives silence/static trimming), a waveform scope, and a scrolling log of
 * every switch/skip/failure/mode event. Excluded from production builds —
 * this never ships.
 */
export function DebugPanel({ debug }: { debug: UseAudioEngineResult["debug"] }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // Snapshot polling + event subscription — only while the panel is open, so
  // the debug tooling itself never costs anything when collapsed.
  useEffect(() => {
    if (!open) return;
    debug.enable();
    const unsubscribe = debug.subscribe((event) => {
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    });
    const id = setInterval(() => setSnapshot(debug.getSnapshot()), POLL_MS);
    return () => {
      clearInterval(id);
      unsubscribe();
    };
  }, [open, debug]);

  // Waveform scope, drawn straight from the analyser each frame.
  useEffect(() => {
    if (!open) return;
    const draw = () => {
      const canvas = canvasRef.current;
      const data = debug.getWaveform();
      if (canvas && data) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const { width, height } = canvas;
          ctx.clearRect(0, 0, width, height);
          ctx.strokeStyle = "#5ac8ff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          const step = data.length / width;
          for (let x = 0; x < width; x++) {
            const sample = data[Math.floor(x * step)] ?? 0;
            const y = height / 2 - sample * (height / 2);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [open, debug]);

  if (process.env.NODE_ENV === "production") return null;

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 12,
    right: 12,
    zIndex: 9999,
    fontFamily: "var(--font-jetbrains-mono, monospace)",
    fontSize: 11,
    color: "#c9d2e0",
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          ...panelStyle,
          padding: "6px 10px",
          background: "#0a0e15",
          border: "1px solid #232b39",
          borderRadius: 6,
          color: "#8a94a6",
          cursor: "pointer",
          letterSpacing: "0.1em",
        }}
      >
        DEBUG
      </button>
    );
  }

  return (
    <div
      style={{
        ...panelStyle,
        width: 360,
        maxHeight: "80vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "#0a0e15",
        border: "1px solid #232b39",
        borderRadius: 10,
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #232b39",
        }}
      >
        <span style={{ letterSpacing: "0.15em", color: "#8a94a6" }}>
          DEBUG · {snapshot?.mode ?? "—"}
        </span>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: "none",
            border: "none",
            color: "#8a94a6",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {snapshot?.tapes.map((tape) => <TapeRow key={tape.role} tape={tape} />) ?? (
          <span style={{ color: "#6b7485" }}>waiting for playback…</span>
        )}
      </div>

      {snapshot && (
        <div
          style={{
            padding: "0 12px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderBottom: "1px solid #232b39",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: "#8a94a6", width: 60 }}>level</span>
            <div
              style={{
                flex: 1,
                height: 6,
                background: "#141a26",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${levelPercent(snapshot.levelDb)}%`,
                  height: "100%",
                  background: snapshot.isVoice ? "#9dff48" : "#ff5a5a",
                }}
              />
            </div>
            <span style={{ color: "#8a94a6", width: 60, textAlign: "right" }}>
              {fmtDb(snapshot.levelDb)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <span
              style={{
                color: snapshot.isVoice ? "#9dff48" : "#6b7485",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {snapshot.isVoice ? "● voice" : snapshot.hasSignal ? "● noise" : "● silence"}
            </span>
            <span style={{ color: "#8a94a6" }}>
              speech {snapshot.speechRatio.toFixed(2)}
            </span>
            <span style={{ color: "#8a94a6" }}>flat {snapshot.flatness.toFixed(2)}</span>
            <span style={{ color: "#8a94a6" }}>mod {snapshot.modulationDb.toFixed(1)}dB</span>
            {snapshot.silenceMs !== null && (
              <span style={{ color: "#ffd15a" }}>
                not-voice {(snapshot.silenceMs / 1000).toFixed(1)}s / {(
                  snapshot.allowedPauseMs / 1000
                ).toFixed(1)}
                s
              </span>
            )}
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={336}
        height={48}
        style={{ margin: "10px 12px", background: "#05070a", borderRadius: 6 }}
      />

      <div
        style={{
          padding: "0 12px 12px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
        }}
      >
        {events.length === 0 ? (
          <span style={{ color: "#6b7485" }}>no events yet</span>
        ) : (
          events.map((event, i) => (
            <div
              key={`${event.at}-${i}`}
              style={{
                display: "flex",
                gap: 6,
                padding: "3px 0",
                borderBottom: "1px solid #141a26",
              }}
            >
              <span style={{ color: "#4a5468", flexShrink: 0 }}>
                {new Date(event.at).toLocaleTimeString(undefined, {
                  hour12: false,
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span style={{ color: eventColor(event.kind), flexShrink: 0 }}>
                {event.kind}
              </span>
              <span style={{ color: "#c9d2e0", wordBreak: "break-word" }}>
                {event.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
