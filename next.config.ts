import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Several sibling projects live under the same parent, each with its own
  // lockfile, so Turbopack otherwise infers the monorepo root and watches
  // (and reloads on) unrelated file activity. Pin the root to this project.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
