import type { Metadata, Viewport } from "next";
import "@fontsource-variable/instrument-sans/wdth.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal Desk",
  description: "Rule-based 1-minute market analysis and alerts. Analysis only — no trade execution, no guarantees.",
  applicationName: "Signal Desk",
  appleWebApp: { capable: true, title: "Signal Desk", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#050a14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="relative min-h-full">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
