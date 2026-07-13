"use client";

export interface PlayButtonProps {
  playing: boolean;
  onToggle: () => void;
}

/**
 * Hero play/pause control with a soft amber halo when active, framed by
 * concentric rings and coordinate ticks.
 */
export function PlayButton({ playing, onToggle }: PlayButtonProps) {
  return (
    <div className="relative">
      {/* Amber halo */}
      <div
        aria-hidden
        className={`bg-accent/25 absolute inset-0 rounded-full blur-3xl transition-opacity duration-1000 ${
          playing ? "animate-beacon opacity-80" : "opacity-0"
        }`}
      />
      {/* Concentric rings */}
      <div
        aria-hidden
        className="absolute inset-0 -m-6 rounded-full border border-white/[0.04]"
      />
      <div
        aria-hidden
        className="absolute inset-0 -m-12 rounded-full border border-white/[0.03]"
      />
      <div
        aria-hidden
        className="absolute inset-0 -m-20 rounded-full border border-white/[0.02]"
      />

      {/* Coordinate ticks */}
      <div
        aria-hidden
        className={`absolute -top-10 left-1/2 h-6 w-px -translate-x-1/2 transition-colors duration-700 ${
          playing ? "bg-accent/60" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute -bottom-10 left-1/2 h-6 w-px -translate-x-1/2 transition-colors duration-700 ${
          playing ? "bg-accent/60" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute top-1/2 -left-10 h-px w-6 -translate-y-1/2 transition-colors duration-700 ${
          playing ? "bg-accent/40" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute top-1/2 -right-10 h-px w-6 -translate-y-1/2 transition-colors duration-700 ${
          playing ? "bg-accent/40" : "bg-white/10"
        }`}
      />

      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? "pause" : "play"}
        aria-pressed={playing}
        className={`focus-visible:ring-accent/50 relative flex size-40 items-center justify-center rounded-full border bg-black/50 backdrop-blur-sm transition-all duration-700 focus:outline-none focus-visible:ring-2 active:scale-95 sm:size-44 ${
          playing
            ? "border-accent/40 shadow-[0_0_60px_-10px_rgba(245,158,11,0.6)]"
            : "hover:border-accent/25 border-white/10"
        }`}
      >
        {playing ? (
          <span className="flex gap-2">
            <span className="bg-accent block h-9 w-1.5" />
            <span className="bg-accent block h-9 w-1.5" />
          </span>
        ) : (
          <span
            className="ml-2 h-0 w-0"
            style={{
              borderTop: "10px solid transparent",
              borderBottom: "10px solid transparent",
              borderLeft: "16px solid var(--color-accent)",
            }}
          />
        )}
      </button>
    </div>
  );
}
