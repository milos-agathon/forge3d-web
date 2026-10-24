import {Forge3DError} from "./runtime-failure.js";
import type {VideoCodecName,VideoContainer,VideoCodecProbeOptions,VideoCodecSupport,VideoCodecUnavailableDetails} from "./index.js";
/** Codec strings probed per codec, most capable first. */
export const CODEC_STRINGS: Record<VideoCodecName, readonly string[]> = {
  avc: ["avc1.640028", "avc1.4d0028", "avc1.42001f"],
  hevc: ["hvc1.1.6.L93.B0"],
  vp9: ["vp09.00.40.08", "vp09.00.10.08"],
  av1: ["av01.0.08M.08", "av01.0.04M.08"],
  vp8: ["vp8"],
};

/** Codecs each container can carry, in default preference order. */
const CONTAINER_CODECS: Record<VideoContainer, readonly VideoCodecName[]> = {
  mp4: ["avc", "vp9", "av1", "hevc"],
  webm: ["vp9", "vp8", "av1"],
};

export const MIME_TYPES: Record<VideoContainer, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Seconds between 1904-01-01 (MP4 epoch) and 1970-01-01. */
export const MP4_EPOCH_OFFSET_SECONDS = 2_082_844_800;

export function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

export function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
}

export function requestedCodecs(
  container: VideoContainer,
  codec: VideoCodecName | readonly VideoCodecName[] | undefined,
): VideoCodecName[] {
  const allowed = CONTAINER_CODECS[container];
  if (allowed === undefined) {
    throw invalid("container must be 'mp4' or 'webm'");
  }
  const list = codec === undefined ? [...allowed] : typeof codec === "string" ? [codec] : [...codec];
  if (list.length === 0) {
    throw invalid("codec list must not be empty");
  }
  for (const name of list) {
    if (!(name in CODEC_STRINGS)) {
      throw invalid(`unknown video codec '${String(name)}'`);
    }
    if (!allowed.includes(name)) {
      throw invalid(`codec '${name}' cannot be muxed into ${container}`);
    }
  }
  return list;
}

function webCodecsAvailable(): boolean {
  return typeof globalThis.VideoEncoder === "function" && typeof globalThis.VideoFrame === "function";
}

/** Probes WebCodecs support for each requested codec (first supported string). */
export async function probeVideoCodecs(options: VideoCodecProbeOptions): Promise<VideoCodecSupport[]> {
  const width = positiveInteger("width", options.width);
  const height = positiveInteger("height", options.height);
  const fps = positiveInteger("fps", options.fps);
  const container = options.container ?? "mp4";
  const codecs = requestedCodecs(container, options.codec);
  const results: VideoCodecSupport[] = [];
  for (const codec of codecs) {
    let support: VideoCodecSupport = {
      codec,
      codecString: CODEC_STRINGS[codec][0] ?? codec,
      container,
      supported: false,
      reason: webCodecsAvailable() ? "unsupported-config" : "webcodecs-unavailable",
    };
    if (webCodecsAvailable()) {
      for (const codecString of CODEC_STRINGS[codec]) {
        try {
          const result = await VideoEncoder.isConfigSupported({
            codec: codecString,
            width,
            height,
            framerate: fps,
            bitrate: options.bitrate ?? defaultBitrate(width, height, fps),
          });
          if (result.supported === true) {
            support = { codec, codecString, container, supported: true };
            break;
          }
        } catch {
          // A malformed or unknown codec string counts as unsupported.
        }
      }
    }
    results.push(support);
  }
  return results;
}

export function defaultBitrate(width: number, height: number, fps: number): number {
  return Math.max(250_000, Math.round(width * height * fps * 0.1));
}

export function unavailable(
  container: VideoContainer,
  requested: VideoCodecName[],
  probes: VideoCodecSupport[],
): Forge3DError {
  const details: VideoCodecUnavailableDetails = {
    kind: "video-codec-unavailable",
    container,
    requested,
    probes,
    webCodecs: webCodecsAvailable(),
  };
  return new Forge3DError(
    "UNSUPPORTED_FEATURE",
    webCodecsAvailable()
      ? `No requested video codec (${requested.join(", ")}) can be encoded for ${container} in this browser`
      : "WebCodecs VideoEncoder is unavailable in this browser",
    details,
  );
}
