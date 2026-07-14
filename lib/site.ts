/** Shared site identity for metadata, manifest, and social cards. */
export const SITE = {
  name: "tower",
  shortName: "tower",
  description:
    "Archival air traffic control radio over endless generative ambient. An airport at 3 AM, for sleep.",
  tagline: "an airport at 3 AM, for sleep",
  themeColor: "#05070a",
  backgroundColor: "#05070a",
  locale: "en_US",
  categories: ["music", "lifestyle", "health"] as string[],
} as const;

/** Absolute site origin for SEO; override with NEXT_PUBLIC_SITE_URL when deploying. */
export function getSiteUrl(): URL {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (fromEnv) {
    return new URL(fromEnv.endsWith("/") ? fromEnv.slice(0, -1) : fromEnv);
  }
  if (process.env.VERCEL_URL) {
    return new URL(`https://${process.env.VERCEL_URL}`);
  }
  return new URL("http://localhost:3000");
}
