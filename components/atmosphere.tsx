/**
 * Decorative background: night-sky radial, drifting starfield with a few
 * twinkling stars, and small glowing dots that drift across like distant
 * aircraft — some flashing red. Everything is a soft dot (no trails). Pure CSS
 * transforms/opacity; every animation is disabled under prefers-reduced-motion
 * (see globals.css).
 */

const STAR_POSITIONS = [
  { top: "8%", left: "12%", size: 1, opacity: 0.6 },
  { top: "14%", left: "78%", size: 1, opacity: 0.5 },
  { top: "22%", left: "34%", size: 1, opacity: 0.7 },
  { top: "31%", left: "88%", size: 1, opacity: 0.4 },
  { top: "42%", left: "8%", size: 1, opacity: 0.6 },
  { top: "48%", left: "62%", size: 1, opacity: 0.5 },
  { top: "55%", left: "22%", size: 1, opacity: 0.4 },
  { top: "63%", left: "82%", size: 1, opacity: 0.7 },
  { top: "71%", left: "48%", size: 1, opacity: 0.5 },
  { top: "78%", left: "14%", size: 1, opacity: 0.6 },
  { top: "84%", left: "72%", size: 1, opacity: 0.4 },
  { top: "92%", left: "38%", size: 1, opacity: 0.5 },
  { top: "18%", left: "54%", size: 2, opacity: 0.35 },
  { top: "68%", left: "6%", size: 2, opacity: 0.3 },
  { top: "6%", left: "44%", size: 1, opacity: 0.5 },
  { top: "27%", left: "18%", size: 1, opacity: 0.45 },
  { top: "37%", left: "72%", size: 1, opacity: 0.55 },
  { top: "52%", left: "92%", size: 1, opacity: 0.4 },
  { top: "59%", left: "40%", size: 1, opacity: 0.5 },
  { top: "74%", left: "60%", size: 1, opacity: 0.45 },
  { top: "88%", left: "24%", size: 1, opacity: 0.5 },
  { top: "12%", left: "30%", size: 1, opacity: 0.4 },
] as const;

/** Stars that flash. `d` = duration (s), `delay` = animation offset (s). */
const TWINKLE_STARS = [
  { top: "16%", left: "24%", size: 2, d: 3.2, delay: 0 },
  { top: "24%", left: "66%", size: 2, d: 4.1, delay: 0.8 },
  { top: "39%", left: "46%", size: 2, d: 3.6, delay: 1.6 },
  { top: "46%", left: "84%", size: 2, d: 4.8, delay: 0.4 },
  { top: "58%", left: "12%", size: 2, d: 3.9, delay: 2.1 },
  { top: "66%", left: "70%", size: 2, d: 4.4, delay: 1.1 },
  { top: "82%", left: "52%", size: 2, d: 3.4, delay: 2.6 },
  { top: "34%", left: "8%", size: 3, d: 5.2, delay: 1.3 },
] as const;

/** Movement direction → the CSS animation utility that drives it. */
const DIR_CLASS = {
  lr: "animate-fly-lr", // left → right
  rl: "animate-fly-rl", // right → left
  td: "animate-fly-td", // top → bottom
  du: "animate-fly-du", // bottom → top
  diagA: "animate-fly-diag-a", // top-left → bottom-right
  diagB: "animate-fly-diag-b", // bottom-left → top-right
} as const;

type FlyDir = keyof typeof DIR_CLASS;

interface Flyer {
  dir: FlyDir;
  /** Cross-axis position: `top` for horizontal movers, `left` for vertical. */
  top?: string;
  left?: string;
  d: number;
  delay: number;
  size: number;
  color: string;
  glow: string;
  flash: boolean;
}

/**
 * Small glowing dots that drift across the sky like distant aircraft, each
 * entering from a different edge and heading a different way. `flash` makes the
 * dot blink (red beacon); the rest glide steadily. Dots only — no trails.
 */
const FLYERS: Flyer[] = [
  { dir: "lr", top: "18%", d: 34, delay: 0, size: 3, color: "#ef4444", glow: "rgba(239,68,68,0.9)", flash: true },
  { dir: "rl", top: "40%", d: 46, delay: 8, size: 2, color: "rgba(255,255,255,0.85)", glow: "rgba(255,255,255,0.7)", flash: false },
  { dir: "diagB", d: 52, delay: 18, size: 3, color: "#ef4444", glow: "rgba(239,68,68,0.9)", flash: true },
  { dir: "td", left: "28%", d: 62, delay: 28, size: 2, color: "#f59e0b", glow: "rgba(245,158,11,0.8)", flash: false },
  { dir: "du", left: "72%", d: 44, delay: 13, size: 2, color: "rgba(255,255,255,0.8)", glow: "rgba(255,255,255,0.65)", flash: false },
  { dir: "diagA", d: 56, delay: 38, size: 2, color: "#38bdf8", glow: "rgba(56,189,248,0.8)", flash: false },
];

export function Atmosphere() {
  return (
    <>
      {/* Atmospheric radial */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 35%, #101a2e 0%, #05070a 65%)",
        }}
      />

      {/* Drifting starfield */}
      <div
        aria-hidden
        className="animate-drift pointer-events-none absolute inset-0 opacity-60"
      >
        {STAR_POSITIONS.map((star, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white/70"
            style={{
              top: star.top,
              left: star.left,
              width: star.size,
              height: star.size,
              opacity: star.opacity,
            }}
          />
        ))}
        <span
          className="bg-accent/70 absolute rounded-full"
          style={{ top: "22%", left: "68%", width: 2, height: 2 }}
        />
      </div>

      {/* Twinkling stars */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {TWINKLE_STARS.map((star, i) => (
          <span
            key={i}
            className="animate-twinkle absolute rounded-full bg-white"
            style={{
              top: star.top,
              left: star.left,
              width: star.size,
              height: star.size,
              boxShadow: "0 0 4px rgba(255,255,255,0.7)",
              animationDuration: `${star.d}s`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>

      {/* Drifting aircraft dots — varied directions, entering from all edges */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {FLYERS.map((flyer, i) => (
          <div
            key={i}
            className={`${DIR_CLASS[flyer.dir]} absolute`}
            style={{
              top: flyer.top ?? 0,
              left: flyer.left ?? 0,
              animationDuration: `${flyer.d}s`,
              animationDelay: `${flyer.delay}s`,
            }}
          >
            <span
              className={`block rounded-full ${flyer.flash ? "animate-flyby-beacon" : ""}`}
              style={{
                width: flyer.size,
                height: flyer.size,
                backgroundColor: flyer.color,
                boxShadow: `0 0 6px ${flyer.glow}`,
              }}
            />
          </div>
        ))}
      </div>

      {/* Distant aircraft beacon */}
      <div
        aria-hidden
        className="animate-aircraft absolute top-[18%] right-[14%] h-1 w-1 rounded-full bg-red-500"
        style={{ boxShadow: "0 0 6px rgba(239,68,68,0.9)" }}
      />

      {/* HUD grid crosshair */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="bg-grid animate-reveal-x absolute inset-x-0 top-1/2 h-px origin-center" />
        <div className="bg-grid animate-reveal-y absolute inset-y-0 left-1/2 w-px origin-center" />
      </div>

      {/* Decorative telemetry */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-6 bottom-6 text-right font-mono text-[8px] leading-relaxed tracking-wider opacity-25"
      >
        alt 36,000 ft
        <br />
        spd 440 kts
        <br />
        hdg 274°
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-6 left-6 font-mono text-[8px] leading-relaxed tracking-wider opacity-25"
      >
        34.05° n
        <br />
        118.24° w
      </div>
    </>
  );
}
