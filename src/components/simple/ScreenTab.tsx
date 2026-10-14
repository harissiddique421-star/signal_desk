"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readChart, type ScreenCandle } from "@/lib/screen/read-chart";
import { MIN_SCREEN_CANDLES, screenSignal, type ScreenSignal } from "@/lib/screen/screen-signal";
import { playSignalTone, unlockAudio } from "@/lib/client/sound";

/** Largest width the screenshot is scaled to before reading (speed on phones). */
const MAX_W = 1100;
/** Live capture: second of the minute when the screen is scanned. */
const LIVE_SCAN_SECOND = 45;

interface Scan {
  at: number;
  signal: ScreenSignal | null;
  candles: ScreenCandle[];
  detail: string;
  /** start of the candle the signal is for (live capture only) */
  tradeAt: number | null;
}

export function ScreenTab({ sound }: { sound: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(0);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- feature detection after mount
    setCanShare(typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  /** Draw a source (image or video frame) on the canvas, read candles, draw the overlay. */
  const analyse = useCallback(
    (src: CanvasImageSource, w: number, h: number, tradeAt: number | null) => {
      const cv = canvasRef.current;
      if (!cv || !w || !h) return;
      const scale = Math.min(1, MAX_W / w);
      cv.width = Math.round(w * scale);
      cv.height = Math.round(h * scale);
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
      const read = readChart(ctx.getImageData(0, 0, cv.width, cv.height));
      const signal = screenSignal(read.candles);
      // overlay: every candle that was read, the last one highlighted
      ctx.lineWidth = Math.max(1, cv.width / 500);
      read.candles.forEach((c, i) => {
        const last = i === read.candles.length - 1;
        ctx.strokeStyle = last ? "#f5c45b" : "rgba(86,212,236,0.8)";
        ctx.strokeRect(c.box.x0 - 1.5, c.box.y0 - 1.5, c.box.x1 - c.box.x0 + 3, c.box.y1 - c.box.y0 + 3);
      });
      setScan({ at: Date.now(), signal, candles: read.candles, detail: read.detail, tradeAt });
      setError(null);
      if (signal && sound && tradeAt) playSignalTone(signal.direction === "UP" ? "CALL" : "PUT");
    },
    [sound],
  );

  // ---- phone / any device: screenshot from the gallery, or paste -----------------
  const loadFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("Sirf tasveer (screenshot) daalein.");
        return;
      }
      setBusy(true);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        analyse(img, img.naturalWidth, img.naturalHeight, null);
        URL.revokeObjectURL(url);
        setBusy(false);
      };
      img.onerror = () => {
        setError("Tasveer khul nahin saki.");
        URL.revokeObjectURL(url);
        setBusy(false);
      };
      img.src = url;
    },
    [analyse],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (item) loadFile(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadFile]);

  // ---- computer: share the Quotex tab, scan every minute at second 45 ------------
  const scanFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const t = Date.now();
    analyse(v, v.videoWidth, v.videoHeight, t - (t % 60_000) + 60_000);
  }, [analyse]);

  const stopLive = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    videoRef.current = null;
    setLive(false);
  }, []);

  const startLive = useCallback(async () => {
    unlockAudio();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      await v.play();
      streamRef.current = stream;
      videoRef.current = v;
      stream.getVideoTracks()[0]?.addEventListener("ended", stopLive);
      setLive(true);
      setTimeout(scanFrame, 500);
    } catch {
      setError("Screen share shuru nahin hua (ijazat nahin di gayi ya browser support nahin karta).");
    }
  }, [scanFrame, stopLive]);

  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const t = Date.now();
      let d = LIVE_SCAN_SECOND * 1000 - (t % 60_000);
      if (d <= 0) d += 60_000;
      timer = setTimeout(() => {
        scanFrame();
        schedule();
      }, d);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [live, scanFrame]);

  useEffect(() => stopLive, [stopLive]);

  // ---- derived -----------------------------------------------------------------------
  const sig = scan?.signal ?? null;
  const startsIn = scan?.tradeAt && now ? Math.ceil((scan.tradeAt - now) / 1000) : null;
  const tradeOpen = startsIn !== null && startsIn <= 0 && startsIn > -15;
  const stale = scan?.tradeAt ? now - scan.tradeAt > 15_000 : false;
  const show = sig && !stale;
  const color = show ? (sig.direction === "UP" ? "#3FDCA0" : "#FF7088") : "#A9B7CA";
  const nextScanIn = live && now ? (() => {
    let d = LIVE_SCAN_SECOND * 1000 - (now % 60_000);
    if (d <= 0) d += 60_000;
    return Math.ceil(d / 1000);
  })() : null;

  return (
    <section aria-label="Screen scan" className="mt-4">
      <h2 className="text-lg font-semibold">📷 Screen scan</h2>
      <p className="mt-1 text-sm text-muted">Quotex ka chart (1 minute, candlestick) screen par khol kar scan karein. App hari/laal candles parh kar agli candle ka UP ya DOWN batati hai.</p>

      <div className="mt-4 grid gap-2">
        <label className="btn btn-primary w-full cursor-pointer text-center text-base">
          {busy ? "Parh raha hai…" : "🖼️ Screenshot daalein"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        {canShare &&
          (live ? (
            <div className="grid grid-cols-2 gap-2">
              <button className="btn w-full" onClick={scanFrame}>
                🎯 Abhi scan karein
              </button>
              <button className="btn w-full" onClick={stopLive}>
                ⏹ Share band karein
              </button>
            </div>
          ) : (
            <button className="btn w-full" onClick={() => void startLive()}>
              🖥️ Computer: Quotex tab share karein (har minute khud scan)
            </button>
          ))}
        <p className="text-xs text-faint">
          {canShare ? "Computer par: screenshot paste (Ctrl+V) bhi kar sakte hain. " : "Phone par: Quotex ka screenshot lein, phir yahan daalein. "}
          Behtar parhne ke liye chart par zoom thora kam rakhein aur indicators band rakhein.
        </p>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-put">
          {error}
        </p>
      )}

      {scan && (
        <div className="glass mt-4 px-5 py-6 text-center" style={{ borderRadius: "1.75rem", borderColor: color }} aria-live="polite">
          {show ? (
            <>
              <p className="verdict text-[4.5rem] leading-none" style={{ color }} data-testid="screen-verdict">
                {sig.direction === "UP" ? "▲ UP" : "▼ DOWN"}
              </p>
              <p className="mt-2 text-base font-medium">
                {sig.strength === "STRONG" ? "Mazboot" : "Kamzor"} ishara — agli candle par {sig.direction === "UP" ? "UP (CALL)" : "DOWN (PUT)"}
              </p>
              {scan.tradeAt && startsIn !== null && startsIn > 0 && (
                <p className="mx-auto mt-3 w-fit rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: "rgba(255,255,255,0.06)", color }}>
                  Signal wali candle shuru hone mein {startsIn}s baqi
                </p>
              )}
              {tradeOpen && (
                <p className="mx-auto mt-3 w-fit rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: "rgba(255,255,255,0.06)", color }}>
                  Abhi entry lein — {15 + startsIn!}s baqi
                </p>
              )}
              {!scan.tradeAt && <p className="mt-2 text-xs text-faint">Yeh screenshot lene ke waqt ki agli candle ke liye hai. Purana screenshot = purana signal.</p>}
              <ul className="mt-4 space-y-1 text-left text-sm">
                {sig.reasons.slice(0, 4).map((r) => (
                  <li key={r}>• {r}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="verdict text-[4rem] leading-none text-hold">WAIT</p>
              <p className="mt-2 text-sm">
                {sig ? "Pichla signal purana ho gaya — agla scan aa raha hai." : `Kaafi candles nahin parhi ja sakin (${scan.candles.length}/${MIN_SCREEN_CANDLES}). Chart 1 minute candlestick par rakhein, zoom kam karein, aur dobara koshish karein.`}
              </p>
            </>
          )}
          <p className="mt-4 text-xs text-faint">
            {scan.candles.length} candles parhi gayin{nextScanIn !== null ? ` · agla scan ${nextScanIn}s mein` : ""}
          </p>
        </div>
      )}

      <canvas ref={canvasRef} className={`mt-4 w-full rounded-xl border border-white/10 ${scan ? "" : "hidden"}`} aria-label="Scan kiya gaya chart (neeli boxes = parhi gayi candles, peeli = aakhri)" />
      {scan && <p className="mt-1 text-xs text-faint">Neeli boxes wo candles hain jo app ne parhin, peeli box aakhri candle. Agar boxes candles par nahin hain to signal par bharosa na karein.</p>}

      <p className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
        <b>Experimental:</b> tasveer se candles ka andaza hai — asli price data nahin, aur yeh strategy saabit nahin. Sirf demo account par istemal karein.
      </p>
    </section>
  );
}
