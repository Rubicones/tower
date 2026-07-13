import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "tower",
    short_name: "tower",
    description:
      "Archival air traffic control radio over endless generative ambient. An airport at 3 AM, for sleep.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#05070a",
    theme_color: "#05070a",
    categories: ["music", "lifestyle", "health"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
