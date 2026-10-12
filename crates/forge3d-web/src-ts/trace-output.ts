import type { TraceResult } from "./trace-types.js";
import { integer, traceInvalid } from "./trace-math.js";
import { Frame, writeExr } from "./frames.js";
export interface TraceTile {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Native scanline order and clipped edge tiles, without filesystem coupling. */
export function* iterTraceTiles(
  width: number,
  height: number,
  tileSize: number,
): Generator<TraceTile> {
  integer(width, "width", 1, 65536);
  integer(height, "height", 1, 65536);
  integer(tileSize, "tileSize", 1, 65536);
  for (let y = 0; y < height; y += tileSize)
    for (let x = 0; x < width; x += tileSize)
      yield {
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
      };
}
/** Native save_aovs outcome as named EXR/PNG Blobs, using W06 encoders. */
export async function encodeTraceAovs(
  result: TraceResult,
  baseName = "trace",
): Promise<Record<string, Blob>> {
  const width = integer(result.width, "width", 1, 65536),
    height = integer(result.height, "height", 1, 65536),
    n = width * height,
    blobs: Record<string, Blob> = {};
  for (const name of [
    "albedo",
    "normal",
    "depth",
    "direct",
    "indirect",
    "emission",
  ] as const) {
    const data = result[name],
      components = name === "depth" ? 1 : 3;
    if (!(data instanceof Float32Array) || data.length !== n * components)
      traceInvalid(`Invalid ${name} AOV shape`);
    const channels =
      components === 1
        ? [{ name: `${name}.Z`, data }]
        : (name === "normal" ? ["X", "Y", "Z"] : ["R", "G", "B"]).map(
            (channel, c) => ({
              name: `${name}.${channel}`,
              data: Float32Array.from(
                { length: n },
                (_, i) => data[i * 3 + c]!,
              ),
            }),
          );
    blobs[`${baseName}_aov-${name}.exr`] = await writeExr({
      width,
      height,
      channels,
    });
  }
  if (
    !(result.visibility instanceof Float32Array) ||
    result.visibility.length !== n
  )
    traceInvalid("Invalid visibility AOV shape");
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.max(0, Math.min(1, result.visibility[i]!)) * 255);
    rgba.set([v, v, v, 255], i * 4);
  }
  blobs[`${baseName}_aov-visibility.png`] = await new Frame(
    width,
    height,
    rgba,
  ).toPng();
  return blobs;
}
