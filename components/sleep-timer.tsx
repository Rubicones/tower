"use client";

import type { TimerPreset } from "@/lib/audio/types";

const PRESETS: { value: TimerPreset; label: string; name: string }[] = [
  { value: 15, label: "15", name: "15 minutes" },
  { value: 30, label: "30", name: "30 minutes" },
  { value: 60, label: "60", name: "60 minutes" },
  { value: null, label: "∞", name: "no timer" },
];

export interface SleepTimerProps {
  value: TimerPreset;
  onChange: (preset: TimerPreset) => void;
}

export function SleepTimer({ value, onChange }: SleepTimerProps) {
  return (
    <div className="flex flex-col items-center gap-3">
      <span
        id="sleep-timer-label"
        className="text-muted text-[9px] uppercase tracking-[0.5em]"
      >
        sleep timer
      </span>
      <div
        role="radiogroup"
        aria-labelledby="sleep-timer-label"
        className="flex gap-4 sm:gap-6"
      >
        {PRESETS.map((preset) => {
          const active = value === preset.value;
          return (
            <button
              key={preset.label}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`sleep timer: ${preset.name}`}
              onClick={() => onChange(preset.value)}
              className={`focus-visible:ring-accent/50 flex min-h-11 min-w-11 items-center justify-center rounded-sm text-[12px] font-light tracking-widest transition-all duration-500 focus:outline-none focus-visible:ring-2 ${
                active ? "text-accent" : "opacity-40 hover:opacity-100"
              }`}
              style={
                active
                  ? { textShadow: "0 0 8px rgba(245,158,11,0.55)" }
                  : undefined
              }
            >
              <span
                className={
                  preset.value === null ? "text-[19px] leading-none" : undefined
                }
              >
                {preset.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
