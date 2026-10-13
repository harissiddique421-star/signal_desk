import { SCREENSHOT_MAX_BYTES, SCREENSHOT_TYPES, MarketTypeSchema } from "@/lib/api/schemas";
import { enforceRateLimit, HttpError, json, safe } from "@/lib/server/http";
import { checkScreenshotDimensions, sniffImage } from "@/lib/validation/image";

/**
 * Validates an uploaded chart screenshot. The file is processed in memory and
 * discarded — it is never written to disk or a database.
 *
 * Chart interpretation (reading candles/prices from pixels) is NOT implemented:
 * no vision/OCR provider is configured. The response says so explicitly, and
 * no prices or signals are inferred from the image.
 */
export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "screenshot", 10);
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > SCREENSHOT_MAX_BYTES + 64_000) throw new HttpError(413, "Screenshot larger than 5 MB");
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.startsWith("multipart/form-data")) throw new HttpError(415, "Upload must be multipart/form-data");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Missing file field");
    const marketType = MarketTypeSchema.safeParse(form.get("marketType"));
    if (file.size === 0) throw new HttpError(400, "Empty file");
    if (file.size > SCREENSHOT_MAX_BYTES) throw new HttpError(413, "Screenshot larger than 5 MB");
    if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) throw new HttpError(415, "Only PNG, JPEG or WebP screenshots are accepted");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = sniffImage(bytes);
    if (!info) throw new HttpError(415, "File content is not a valid PNG, JPEG or WebP image");
    if (info.kind !== file.type) throw new HttpError(415, `File says ${file.type} but its content is ${info.kind}`);
    const dimError = checkScreenshotDimensions(info);
    if (dimError) throw new HttpError(422, dimError);

    return json({
      accepted: true,
      analysisKind: "SCREENSHOT",
      marketType: marketType.success ? marketType.data : null,
      image: { type: info.kind, bytes: file.size, width: info.width, height: info.height },
      stored: false,
      interpretation: "NOT_IMPLEMENTED",
      decision: "NO_TRADE",
      message:
        "Screenshot validated but NOT interpreted: no vision/OCR model is configured, so no candles, prices or signals were read from it. A preview is not an analysis.",
      messageUr: "Screenshot sahi format mein hai, lekin is ka tajziya (analysis) abhi mojood nahin. Is tasveer se koi price ya signal nahin nikala gaya.",
    });
  });
}
