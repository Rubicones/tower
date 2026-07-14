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
      {/* Concentric rings — tighter on small screens so the hero fits one viewport */}
      <div
        aria-hidden
        className="absolute inset-0 -m-4 rounded-full border border-white/4 sm:-m-6"
      />
      <div
        aria-hidden
        className="absolute inset-0 -m-8 rounded-full border border-white/3 sm:-m-12"
      />
      <div
        aria-hidden
        className="absolute inset-0 -m-12 rounded-full border border-white/2 sm:-m-20"
      />

      {/* Coordinate ticks */}
      <div
        aria-hidden
        className={`absolute -top-7 left-1/2 h-4 w-px -translate-x-1/2 transition-colors duration-700 sm:-top-10 sm:h-6 ${
          playing ? "bg-accent/60" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute -bottom-7 left-1/2 h-4 w-px -translate-x-1/2 transition-colors duration-700 sm:-bottom-10 sm:h-6 ${
          playing ? "bg-accent/60" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute top-1/2 -left-7 h-px w-4 -translate-y-1/2 transition-colors duration-700 sm:-left-10 sm:w-6 ${
          playing ? "bg-accent/40" : "bg-white/10"
        }`}
      />
      <div
        aria-hidden
        className={`absolute top-1/2 -right-7 h-px w-4 -translate-y-1/2 transition-colors duration-700 sm:-right-10 sm:w-6 ${
          playing ? "bg-accent/40" : "bg-white/10"
        }`}
      />

      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? "pause" : "play"}
        aria-pressed={playing}
        className={`focus-visible:ring-accent/50 relative flex size-28 items-center justify-center rounded-full border bg-black/50 backdrop-blur-sm transition-all duration-700 focus:outline-none focus-visible:ring-2 active:scale-95 sm:size-44 ${
          playing
            ? "border-accent/40 shadow-[0_0_60px_-10px_rgba(245,158,11,0.6)]"
            : "hover:border-accent/25 border-white/10"
        }`}
      >
        {playing ? (
          <span className="flex gap-1.5 sm:gap-2">
            <span className="bg-accent block h-7 w-1.5 sm:h-9" />
            <span className="bg-accent block h-7 w-1.5 sm:h-9" />
          </span>
        ) : (
          <span
            className="ml-1.5 h-0 w-0 sm:ml-2"
            style={{
              borderTop: "8px solid transparent",
              borderBottom: "8px solid transparent",
              borderLeft: "13px solid var(--color-accent)",
            }}
          />
        )}
      </button>
    </div>
  );
}
