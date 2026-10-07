import { decodeRgbe } from "./ibl.js";
import { readByteSource } from "./browser-io.js";
import { Forge3DError } from "./index.js";
import type { BrowserByteSource, ByteReadOptions, RgbeImage } from "./index.js";
import { meshLimit, meshError, meshInteger, meshNumber } from "./mesh.js";
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export async function loadHdr(
  source: BrowserByteSource,
  o: ByteReadOptions = {},
): Promise<RgbeImage> {
  return decodeRgbe(await readByteSource(source, o));
}
/** Radiance RGBE is a shared-exponent format; use float EXR for lossless HDR. */
export function exportHdr(image: RgbeImage): Blob {
  const w = meshInteger(image.width, "width", 1, 16384),
    h = meshInteger(image.height, "height", 1, 16384);
  if (!(image.data instanceof Float32Array) || image.data.length !== w * h * 4)
    meshError("HDR RGBA shape mismatch");
  meshLimit(w * h * 4);
  const header = new TextEncoder().encode(
      `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`,
    ),
    pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const rgb = [
      image.data[i * 4]!,
      image.data[i * 4 + 1]!,
      image.data[i * 4 + 2]!,
    ];
    rgb.forEach((x) => meshNumber(x, "HDR channel", 0));
    const max = Math.max(...rgb);
    if (max < 1e-32) continue;
    const exponent = Math.floor(Math.log2(max)) + 1,
      scale = 2 ** (8 - exponent),
      off = i * 4;
    if (exponent + 128 > 255) meshError("HDR exponent exceeds RGBE range");
    for (let c = 0; c < 3; c++)
      pixels[off + c] = Math.min(255, Math.floor(rgb[c]! * scale));
    pixels[off + 3] = exponent + 128;
  }
  // Modern planar scanlines avoid the ambiguous [2,2,...] legacy prefix.
  if (w >= 8 && w <= 32767) {
    const rowBytes = 4 + 4 * (w + Math.ceil(w / 128)),
      out = new Uint8Array(header.length + h * rowBytes);
    meshLimit(out.length);
    out.set(header);
    let cursor = header.length;
    for (let y = 0; y < h; y++) {
      out.set([2, 2, w >> 8, w & 255], cursor);
      cursor += 4;
      for (let c = 0; c < 4; c++)
        for (let x = 0; x < w; x += 128) {
          const n = Math.min(128, w - x);
          out[cursor++] = n;
          for (let j = 0; j < n; j++)
            out[cursor++] = pixels[(y * w + x + j) * 4 + c]!;
        }
    }
    return new Blob([out], { type: "image/vnd.radiance" });
  }
  return new Blob([header, pixels], { type: "image/vnd.radiance" });
}
function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Forge3DError(
    "UNSUPPORTED_FEATURE",
    "image IO requires Canvas or OffscreenCanvas",
  );
}
export async function loadImage(
  source: BrowserByteSource,
  o: ByteReadOptions = {},
): Promise<RasterImage> {
  const bytes = await readByteSource(source, o);
  if (typeof createImageBitmap === "undefined")
    throw new Forge3DError("UNSUPPORTED_FEATURE", "image decoder unavailable");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch {
    throw new Forge3DError("IO_ERROR", "image decode failed");
  }
  try {
    meshLimit(bitmap.width * bitmap.height * 4);
    if (o.signal?.aborted)
      throw new Forge3DError("REQUEST_CANCELLED", "image load cancelled");
    const c = canvas(bitmap.width, bitmap.height),
      ctx = c.getContext("2d") as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
    if (!ctx)
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "2D image context unavailable",
      );
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}
export async function exportImage(
  image: RasterImage,
  o: {
    type?: "image/png" | "image/jpeg" | "image/webp";
    quality?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Blob> {
  const w = meshInteger(image.width, "width", 1, 16384),
    h = meshInteger(image.height, "height", 1, 16384);
  if (
    !(image.data instanceof Uint8ClampedArray) ||
    image.data.length !== w * h * 4
  )
    meshError("image RGBA shape mismatch");
  meshLimit(w * h * 4);
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "image export cancelled");
  if (o.quality !== undefined) meshNumber(o.quality, "quality", 0, 1);
  const c = canvas(w, h),
    ctx = c.getContext("2d") as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
  if (!ctx)
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "2D image context unavailable",
    );
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), w, h),
    0,
    0,
  );
  const type = o.type ?? "image/png";
  let blob: Blob;
  if ("convertToBlob" in c)
    blob = await c.convertToBlob({
      type,
      ...(o.quality !== undefined ? { quality: o.quality } : {}),
    });
  else
    blob = await new Promise<Blob>((resolve, reject) =>
      c.toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(new Forge3DError("IO_ERROR", "image encode failed")),
        type,
        o.quality,
      ),
    );
  if (o.signal?.aborted)
    throw new Forge3DError("REQUEST_CANCELLED", "image export cancelled");
  return blob;
}
