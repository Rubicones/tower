import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Open Graph / social preview card. */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: SITE.backgroundColor,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {/* Brand mark: gold reticle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 220,
            height: 220,
            position: "relative",
            marginBottom: 36,
          }}
        >
          <div
            style={{
              width: 140,
              height: 140,
              borderRadius: 999,
              border: "3px solid #c9a227",
            }}
          />
          {/* Cardinal ticks */}
          <div
            style={{
              position: "absolute",
              top: 18,
              width: 3,
              height: 22,
              background: "#c9a227",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 18,
              width: 3,
              height: 22,
              background: "#c9a227",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 18,
              width: 22,
              height: 3,
              background: "#c9a227",
            }}
          />
          <div
            style={{
              position: "absolute",
              right: 18,
              width: 22,
              height: 3,
              background: "#c9a227",
            }}
          />
        </div>
        <div
          style={{
            fontSize: 56,
            letterSpacing: "-0.04em",
            color: "#e2e8f0",
            fontWeight: 500,
          }}
        >
          {SITE.name}
        </div>
        <div
          style={{
            marginTop: 14,
            fontSize: 24,
            color: "#64748b",
            letterSpacing: "0.02em",
          }}
        >
          {SITE.tagline}
        </div>
      </div>
    ),
    { ...size },
  );
}
