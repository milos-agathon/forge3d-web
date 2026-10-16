import { Forge3DError } from "./index.js";
import type {
  EncodedVideoChunkInput,
  EncodedVideoResult,
  MuxVideoOptions,
  RenderedFrame,
  VideoCodecName,
  VideoCodecProbeOptions,
  VideoCodecSupport,
  VideoCodecUnavailableDetails,
  VideoContainer,
  VideoEncodeOptions,
} from "./index.js";
import { Frame } from "./frames.js";
import { frameTimestampUs } from "./frame-stream.js";

/** Codec strings probed per codec, most capable first. */
const CODEC_STRINGS: Record<VideoCodecName, readonly string[]> = {
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

const MIME_TYPES: Record<VideoContainer, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Seconds between 1904-01-01 (MP4 epoch) and 1970-01-01. */
const MP4_EPOCH_OFFSET_SECONDS = 2_082_844_800;

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
}

function requestedCodecs(
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

function defaultBitrate(width: number, height: number, fps: number): number {
  return Math.max(250_000, Math.round(width * height * fps * 0.1));
}

function unavailable(
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

function frameOf(input: Frame | RenderedFrame): Frame {
  return input instanceof Frame ? input : input.frame;
}

/**
 * Encodes frames with WebCodecs and muxes them deterministically
 * (native example-owned ffmpeg MP4 workflow). Frame `i` gets the exact
 * timestamp `round(i * 1e6 / fps)` us; unavailable codecs raise
 * `UNSUPPORTED_FEATURE` with `VideoCodecUnavailableDetails`.
 */
export async function encodeVideo(
  frames: Iterable<Frame | RenderedFrame> | AsyncIterable<Frame | RenderedFrame>,
  options: VideoEncodeOptions,
): Promise<EncodedVideoResult> {
  const fps = positiveInteger("fps", options.fps);
  const container = options.container ?? "mp4";
  const requested = requestedCodecs(container, options.codec);
  const keyFrameInterval = positiveInteger("keyFrameInterval", options.keyFrameInterval ?? fps);
  const iterator = (Symbol.asyncIterator in frames
    ? (frames as AsyncIterable<Frame | RenderedFrame>)[Symbol.asyncIterator]()
    : (frames as Iterable<Frame | RenderedFrame>)[Symbol.iterator]()) as
    | AsyncIterator<Frame | RenderedFrame>
    | Iterator<Frame | RenderedFrame>;
  const first = await iterator.next();
  if (first.done === true) {
    throw invalid("encodeVideo requires at least one frame");
  }
  const firstFrame = frameOf(first.value);
  const { width, height } = firstFrame;
  const bitrate = options.bitrate ?? defaultBitrate(width, height, fps);
  const probes = await probeVideoCodecs({ width, height, fps, container, codec: requested, bitrate });
  const selected = probes.find((probe) => probe.supported);
  if (selected === undefined) {
    throw unavailable(container, requested, probes);
  }

  const chunks: EncodedVideoChunkInput[] = [];
  let decoderConfig: VideoDecoderConfig | undefined;
  let encodeError: unknown;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        type: chunk.type,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? 0,
      });
      if (decoderConfig === undefined && metadata?.decoderConfig !== undefined) {
        decoderConfig = metadata.decoderConfig;
      }
    },
    error(error) {
      encodeError = error;
    },
  });
  const config: VideoEncoderConfig = {
    codec: selected.codecString,
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: "quality",
  };
  if (selected.codec === "avc") {
    config.avc = { format: "avc" };
  }
  encoder.configure(config);

  const timestampsUs: number[] = [];
  let index = 0;
  let current: IteratorResult<Frame | RenderedFrame> = first;
  try {
    while (current.done !== true) {
      if (options.signal?.aborted === true) {
        throw new Forge3DError("REQUEST_CANCELLED", "Video encoding was cancelled", options.signal.reason);
      }
      if (encodeError !== undefined) {
        throw encodeError;
      }
      const frame = frameOf(current.value);
      if (frame.width !== width || frame.height !== height) {
        throw invalid(`frame ${index} is ${frame.width}x${frame.height}; expected ${width}x${height}`);
      }
      const timestamp = frameTimestampUs(index, fps);
      const duration = frameTimestampUs(index + 1, fps) - timestamp;
      const videoFrame = new VideoFrame(frame.data as Uint8Array<ArrayBuffer>, {
        format: "RGBA",
        codedWidth: width,
        codedHeight: height,
        timestamp,
        duration,
      });
      try {
        encoder.encode(videoFrame, { keyFrame: index % keyFrameInterval === 0 });
      } finally {
        videoFrame.close();
      }
      timestampsUs.push(timestamp);
      index += 1;
      options.onProgress?.(index);
      while (encoder.encodeQueueSize > 4) {
        await new Promise<void>((resolve) => encoder.addEventListener("dequeue", () => resolve(), { once: true }));
      }
      current = await iterator.next();
    }
    await encoder.flush();
    if (encodeError !== undefined) {
      throw encodeError;
    }
  } catch (error) {
    await (iterator as AsyncIterator<unknown>).return?.();
    throw Forge3DError.from(error);
  } finally {
    if (encoder.state !== "closed") {
      encoder.close();
    }
  }
  const blob = await muxEncodedVideo(chunks, {
    codec: selected.codec,
    codecString: selected.codecString,
    container,
    width,
    height,
    fps,
    ...(decoderConfig === undefined ? {} : { decoderConfig }),
    ...(options.creationTime === undefined ? {} : { creationTime: options.creationTime }),
  });
  return {
    blob,
    mimeType: MIME_TYPES[container],
    container,
    codec: selected.codec,
    codecString: selected.codecString,
    width,
    height,
    fps,
    frameCount: index,
    timestampsUs,
    durationUs: frameTimestampUs(index, fps),
    keyFrames: chunks.filter((chunk) => chunk.type === "key").length,
  };
}

interface MediabunnyModule {
  Output: new (options: { format: unknown; target: unknown }) => {
    addVideoTrack(source: unknown, metadata?: { frameRate?: number }): void;
    start(): Promise<void>;
    finalize(): Promise<void>;
    cancel(): Promise<void>;
  };
  Mp4OutputFormat: new (options?: { fastStart?: false | "in-memory" }) => unknown;
  WebMOutputFormat: new () => unknown;
  BufferTarget: new () => { buffer: ArrayBuffer | null };
  EncodedVideoPacketSource: new (codec: VideoCodecName) => {
    add(packet: unknown, meta?: EncodedVideoChunkMetadata): Promise<void>;
  };
  EncodedPacket: new (data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number) => unknown;
}

let mediabunny: Promise<MediabunnyModule> | undefined;

function loadMediabunny(): Promise<MediabunnyModule> {
  mediabunny ??= import("mediabunny").then(
    (module) => module as unknown as MediabunnyModule,
    (error: unknown) => {
      mediabunny = undefined;
      throw new Forge3DError("WASM_LOAD_FAILED", "Failed to load the MP4/WebM muxer", error);
    },
  );
  return mediabunny;
}

/**
 * Muxes encoded chunks into MP4/WebM. Output bytes depend only on the
 * chunks and options (the MP4 creation time is pinned, default 1970-01-01).
 */
export async function muxEncodedVideo(
  chunks: readonly EncodedVideoChunkInput[],
  options: MuxVideoOptions,
): Promise<Blob> {
  const container = options.container ?? "mp4";
  requestedCodecs(container, options.codec);
  const width = positiveInteger("width", options.width);
  const height = positiveInteger("height", options.height);
  const fps = positiveInteger("fps", options.fps);
  if (chunks.length === 0) {
    throw invalid("muxEncodedVideo requires at least one chunk");
  }
  if (chunks[0]?.type !== "key") {
    throw invalid("the first chunk must be a key frame");
  }
  const bunny = await loadMediabunny();
  const target = new bunny.BufferTarget();
  const format =
    container === "mp4" ? new bunny.Mp4OutputFormat({ fastStart: "in-memory" }) : new bunny.WebMOutputFormat();
  const output = new bunny.Output({ format, target });
  const muxer = (output as unknown as { _muxer?: { creationTime?: number } })._muxer;
  if (muxer !== undefined && "creationTime" in muxer) {
    const created = options.creationTime ?? 0;
    const seconds = Math.floor((created instanceof Date ? created.getTime() : created) / 1000);
    muxer.creationTime = MP4_EPOCH_OFFSET_SECONDS + seconds;
  }
  const source = new bunny.EncodedVideoPacketSource(options.codec);
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const decoderConfig: VideoDecoderConfig = options.decoderConfig ?? {
    codec: options.codecString ?? CODEC_STRINGS[options.codec][0] ?? options.codec,
    codedWidth: width,
    codedHeight: height,
  };
  try {
    for (const [index, chunk] of chunks.entries()) {
      const packet = new bunny.EncodedPacket(
        chunk.data,
        chunk.type,
        chunk.timestampUs / 1_000_000,
        chunk.durationUs / 1_000_000,
      );
      await source.add(packet, index === 0 ? { decoderConfig } : undefined);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw new Forge3DError("IO_ERROR", "Video muxing failed", error);
  }
  if (target.buffer === null) {
    throw new Forge3DError("INTERNAL_ERROR", "Video muxer produced no output");
  }
  return new Blob([target.buffer], { type: MIME_TYPES[container] });
}
