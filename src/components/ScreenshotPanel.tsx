"use client";

import { useEffect, useState } from "react";
import type { ScreenshotResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import type { MarketType } from "@/lib/types";

const MAX = 5 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

export function ScreenshotPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [marketType, setMarketType] = useState<MarketType>("OTC");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScreenshotResponse | null>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL lifecycle is tied to the file
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(f: File | null) {
    setResult(null);
    setError(null);
    const reject = (msg: string | null) => {
      setFile(null);
      setPreview(null);
      if (msg) setError(msg);
    };
    if (!f) return reject(null);
    if (!TYPES.includes(f.type)) return reject("Choose a PNG, JPEG or WebP image.");
    if (f.size > MAX) return reject("Screenshot is larger than 5 MB.");
    setFile(f);
  }

  async function validate() {
    if (!file) return;
    setBusy(true);
    const body = new FormData();
    body.set("file", file);
    body.set("marketType", marketType);
    const r = await api<ScreenshotResponse>("/api/screenshot", { method: "POST", body });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn" role="note">
        Screenshot interpretation is not implemented. No vision or OCR model is configured, so the app cannot read candles or prices from an image and will not produce a signal from one.
      </div>
      <p className="text-sm text-faint" lang="ur-Latn">
        Aap screenshot upload kar ke check kar sakte hain ke file sahi hai, lekin abhi is se tajziya ya signal nahin banta. Screenshot mehfooz (save) nahin kiya jata.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1 text-sm">
          <span className="text-muted" id="shot-mt">Market</span>
          <div className="seg" role="group" aria-labelledby="shot-mt">
            {(["LIVE", "OTC"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={marketType === m} onClick={() => setMarketType(m)}>
                {m === "LIVE" ? "Regular" : "OTC"}
              </button>
            ))}
          </div>
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Chart screenshot (PNG, JPEG or WebP, up to 5 MB)</span>
          <input className="field file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-ink" type="file" accept={TYPES.join(",")} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn btn-ghost" disabled={!file || busy} onClick={() => void validate()}>
          {busy ? "Checking…" : "Check screenshot"}
        </button>
      </div>

      {error && <p role="alert" className="text-put">{error}</p>}

      {preview && (
        <figure className="glass-quiet overflow-hidden p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
          <img src={preview} alt="Preview of the uploaded chart screenshot" className="max-h-80 w-full rounded-md object-contain" />
          <figcaption className="mt-2 text-xs text-muted">Preview only (stays in your browser). A preview is not an analysis.</figcaption>
        </figure>
      )}

      {result && (
        <div className="glass-quiet space-y-1 p-4 text-sm" role="status">
          <p className="font-semibold">Screenshot-derived analysis: not available</p>
          <p className="text-muted">
            Valid {result.image.type.replace("image/", "").toUpperCase()} image, {result.image.width}×{result.image.height}px, {(result.image.bytes / 1024).toFixed(0)} KB. Not stored.
          </p>
          <p className="text-muted">{result.message}</p>
          <p className="text-faint" lang="ur-Latn">{result.messageUr}</p>
          <p className="font-semibold text-hold">Decision: NO TRADE</p>
        </div>
      )}
    </div>
  );
}
