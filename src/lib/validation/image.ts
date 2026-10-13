export type ImageKind = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
}

/**
 * Identify an image from its magic bytes (never trust the declared MIME type)
 * and read its pixel dimensions from the header. Returns null if the bytes are
 * not a well-formed PNG, JPEG or WebP header.
 */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk with width/height (big-endian)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
    return { kind: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }

  // JPEG: FF D8 FF, scan segments for a SOFn marker
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { kind: "image/jpeg", height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8 " && b.length >= 30) return { kind: "image/webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = dv.getUint32(21, true);
      return { kind: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && b.length >= 30) {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { kind: "image/webp", width: w, height: h };
    }
    return null;
  }
  return null;
}

export const SCREENSHOT_LIMITS = {
  minWidth: 320,
  minHeight: 240,
  maxWidth: 8000,
  maxHeight: 8000,
};

export function checkScreenshotDimensions(info: ImageInfo): string | null {
  const l = SCREENSHOT_LIMITS;
  if (info.width < l.minWidth || info.height < l.minHeight) return `Image is ${info.width}×${info.height}; at least ${l.minWidth}×${l.minHeight} is needed to read a chart.`;
  if (info.width > l.maxWidth || info.height > l.maxHeight) return `Image is ${info.width}×${info.height}; maximum is ${l.maxWidth}×${l.maxHeight}.`;
  return null;
}
