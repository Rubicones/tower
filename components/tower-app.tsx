"use client";

import { useEffect, useMemo, useState } from "react";
import { useAudioEngine } from "@/lib/audio/use-audio-engine";
import { Atmosphere } from "./atmosphere";
import { DebugPanel } from "./debug-panel";
import { Fader } from "./fader";
import { PlayButton } from "./play-button";
import { SleepTimer } from "./sleep-timer";

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** UTC clock, set only on the client to avoid hydration mismatches. */
function useZuluClock(): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const timeout = setTimeout(update, 0);
    const id = setInterval(update, 1_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(id);
    };
  }, []);
  if (!now) return "--:-- z";
  const h = now.getUTCHours().toString().padStart(2, "0");
  const m = now.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m} z`;
}

export function TowerApp() {
  const {
    isPlaying,
    toggle,
    radioVolume,
    setRadioVolume,
    musicVolume,
    setMusicVolume,
    timer,
    setTimer,
    remainingSeconds,
    debug,
  } = useAudioEngine();
  const zulu = useZuluClock();

  // Space toggles playback (unless focus is on a control that handles it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "BUTTON")
      ) {
        return;
      }
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const statusLine = useMemo(() => {
    if (!isPlaying) return "standby";
    if (remainingSeconds !== null) {
      return `transmitting · ${formatCountdown(remainingSeconds)}`;
    }
    return "transmitting";
  }, [isPlaying, remainingSeconds]);

  return (
    <div className="selection:bg-accent/30 animate-tower-in relative flex h-dvh max-h-dvh w-full flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      <Atmosphere />

      {/* Header */}
      <header className="relative z-10 flex shrink-0 items-baseline justify-between px-5 pt-3 sm:px-8 sm:pt-5">
        <h1 className="text-xs font-light lowercase opacity-70 tracking-[0.4em]">
          tower
        </h1>
        <div className="text-muted flex gap-3 font-mono text-[9px] uppercase tracking-widest sm:gap-4">
          <span>tuned · 118.10</span>
          <span className="hidden sm:inline">khnd</span>
          <span>{zulu}</span>
        </div>
      </header>

      {/* Hero play/pause */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <PlayButton playing={isPlaying} onToggle={toggle} />
        <p
          aria-live="polite"
          className={`mt-10 font-mono text-[10px] uppercase tracking-[0.3em] transition-colors duration-700 sm:mt-12 ${
            isPlaying ? "text-accent/85" : "text-muted"
          }`}
        >
          {statusLine}
        </p>
      </main>

      {/* Bottom controls */}
      <footer className="relative z-10 flex shrink-0 flex-col gap-4 px-6 pb-5 sm:gap-8 sm:px-10 sm:pb-12">
        <div className="mx-auto grid w-full max-w-xl grid-cols-2 gap-6 sm:gap-12">
          <Fader
            label="radio"
            value={radioVolume}
            onChange={setRadioVolume}
            active={isPlaying && radioVolume > 0}
          />
          <Fader
            label="music"
            value={musicVolume}
            onChange={setMusicVolume}
            active={isPlaying && musicVolume > 0}
          />
        </div>

        <SleepTimer value={timer} onChange={setTimer} />
      </footer>

      {process.env.NODE_ENV !== "production" && <DebugPanel debug={debug} />}
    </div>
  );
}
