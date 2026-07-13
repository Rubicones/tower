import { notFound } from "next/navigation";
import { AudioTestClient } from "./audio-test-client";

/**
 * MANDATORY risk-validation harness (task §"MANDATORY first step").
 *
 * Excluded from production: any request in a production build 404s, so the
 * page never ships. Run it with `npm run dev` and open /dev/audio-test.
 *
 * It verifies the three assumptions the streaming architecture depends on:
 *   1. CORS silence check — a MediaElementSource from archive.org produces
 *      real signal through a Web Audio graph (cross-origin taint is silent
 *      zeros, not an error, so it must be measured with an AnalyserNode).
 *   2. Range check — a random seek fetches a partial range, not the whole
 *      30–60 MB tape.
 *   3. iOS background check — documents MediaElementSource + Tone.js
 *      behaviour behind the lock screen; wires mediaSession regardless.
 */
export default function AudioTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AudioTestClient />;
}

export const dynamic = "force-static";
