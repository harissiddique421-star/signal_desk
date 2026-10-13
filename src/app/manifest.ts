import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signal Desk",
    short_name: "Signal Desk",
    description: "Rule-based 1-minute market analysis and alerts. Analysis only.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#050a14",
    theme_color: "#050a14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
