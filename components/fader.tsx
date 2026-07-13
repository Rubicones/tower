"use client";

export interface FaderProps {
  label: string;
  /** 0–100; 0 mutes the layer completely. */
  value: number;
  onChange: (value: number) => void;
  active: boolean;
}

/**
 * Minimal horizontal fader. The visible track/thumb are decorative; the
 * real control is a transparent native range input stretched over a
 * 44px-tall hit area (keyboard- and touch-friendly).
 */
export function Fader({ label, value, onChange, active }: FaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between px-0.5">
        <span className="text-[10px] lowercase opacity-50 tracking-[0.25em]">
          {label}
        </span>
        <span
          className={`font-mono text-[9px] tabular-nums transition-opacity ${
            active ? "text-accent/90" : "opacity-60"
          }`}
        >
          {value.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="group relative flex h-11 items-center">
        <div className="absolute inset-x-0 h-px bg-white/5" />
        <div
          className="bg-accent/70 absolute left-0 h-px transition-[width] duration-300 ease-out"
          style={{
            width: `${value}%`,
            boxShadow: active ? "0 0 10px rgba(245, 158, 11, 0.45)" : "none",
          }}
        />
        <div
          className="bg-accent absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 transition-all duration-300"
          style={{
            left: `${value}%`,
            opacity: active ? 1 : 0.5,
            boxShadow: active ? "0 0 8px rgba(245, 158, 11, 0.7)" : "none",
          }}
        />
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={`${label} volume`}
          aria-valuetext={value === 0 ? `${label} muted` : `${value} percent`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}
