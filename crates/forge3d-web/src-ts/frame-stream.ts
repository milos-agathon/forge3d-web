import { Forge3DError } from "./index.js";
import type {
  CameraInput,
  CaptureOptions,
  CaptureResult,
  FrameSequenceOptions,
  FrameSink,
  FrameSinkFormat,
  FrameWriteSummary,
  OfflineRenderOptions,
  OfflineResult,
  PngEncodeOptions,
  RenderedFrame,
} from "./index.js";
import { RenderConfig, RenderProgress } from "./camera-animation.js";
import { Frame } from "./frames.js";

/** Minimal render surface `renderFrames` drives (runtime or session). */
export interface FrameRenderTarget {
  readonly width: number;
  readonly height: number;
  setCamera(camera: CameraInput): void;
  render(): boolean;
  readRgba(): Promise<Uint8Array>;
  capture(options?: CaptureOptions): Promise<CaptureResult>;
  renderOffline(options?: OfflineRenderOptions): Promise<OfflineResult>;
}

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}

function cancelled(signal: AbortSignal): Forge3DError {
  return new Forge3DError("REQUEST_CANCELLED", "Frame rendering was cancelled", signal.reason);
}

/** Exact microsecond timestamp of frame `index` at `fps`. */
export function frameTimestampUs(index: number, fps: number): number {
  return Math.round((index * 1_000_000) / fps);
}

/**
 * Renders a deterministic frame sequence (native `render_animation` /
 * `FrameDumper`): frame `i` sits at time `i / fps` with an exact
 * microsecond timestamp and duration. Cancel with `signal`; progress is
 * reported after each frame with the completed-frame count.
 */
export async function* renderFrames(
  target: FrameRenderTarget,
  options: FrameSequenceOptions,
): AsyncGenerator<RenderedFrame, void, undefined> {
  const config =
    options.config ??
    new RenderConfig({
      fps: options.fps ?? 30,
      width: target.width,
      height: target.height,
    });
  const fps = options.fps ?? config.fps;
  if (!Number.isSafeInteger(fps) || fps <= 0) {
    throw invalid("fps must be a positive integer");
  }
  let total: number;
  let cameraAt: (time: number, index: number) => CameraInput;
  if (options.animation !== undefined) {
    const animation = options.animation;
    total = options.frameCount ?? animation.getFrameCount(fps);
    const cameraOptions = options.cameraOptions ?? {};
    cameraAt = (time) => {
      const camera = animation.cameraAt(time, cameraOptions);
      if (camera === undefined) {
        throw invalid("camera animation has no keyframes");
      }
      return camera;
    };
  } else if (options.cameraAt !== undefined) {
    if (options.frameCount === undefined) {
      throw invalid("frameCount is required with cameraAt");
    }
    total = options.frameCount;
    cameraAt = options.cameraAt;
  } else {
    throw invalid("renderFrames requires an animation or cameraAt callback");
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw invalid("frameCount must be a non-negative integer");
  }
  const start = options.startFrame ?? 0;
  const end = options.endFrame ?? total;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > total || start > end) {
    throw invalid(`frame range [${start}, ${end}) must lie within [0, ${total}]`);
  }
  const mode = options.mode ?? "capture";
  if (mode !== "capture" && mode !== "display" && mode !== "offline") {
    throw invalid("mode must be 'capture', 'display' or 'offline'");
  }
  let previousCamera: CameraInput | undefined;
  for (let index = start; index < end; index += 1) {
    if (options.signal?.aborted === true) {
      throw cancelled(options.signal);
    }
    const time = index / fps;
    const camera = cameraAt(time, index);
    const timestampUs = frameTimestampUs(index, fps);
    const durationUs = frameTimestampUs(index + 1, fps) - timestampUs;
    target.setCamera(camera);
    const previous = previousCamera ?? camera;
    let rendered: RenderedFrame;
    if (mode === "display") {
      target.render();
      const rgba = await target.readRgba();
      rendered = {
        index,
        time,
        timestampUs,
        durationUs,
        camera,
        frame: new Frame(target.width, target.height, rgba),
      };
    } else if (mode === "capture") {
      const result = await target.capture({
        ...(options.capture ?? { aovs: [] }),
        previousCamera: previous,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      rendered = {
        index,
        time,
        timestampUs,
        durationUs,
        camera,
        frame: result.frame,
        hdrFrame: result.hdrFrame,
        aovFrame: result.aovFrame,
      };
    } else {
      const result = await target.renderOffline({
        ...(options.offline ?? {}),
        previousCamera: previous,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      rendered = {
        index,
        time,
        timestampUs,
        durationUs,
        camera,
        frame: result.frame,
        hdrFrame: result.hdrFrame,
        aovFrame: result.aovFrame,
      };
    }
    previousCamera = camera;
    options.onProgress?.(
      new RenderProgress(index - start + 1, end - start, time, config.frameFileName(index)),
    );
    yield rendered;
  }
}

/** `renderFrames` as a `ReadableStream` with pull-based backpressure. */
export function createFrameStream(
  target: FrameRenderTarget,
  options: FrameSequenceOptions,
): ReadableStream<RenderedFrame> {
  const iterator = renderFrames(target, options);
  return new ReadableStream<RenderedFrame>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done === true) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(Forge3DError.from(error));
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 1 },
  );
}

async function encodeFrame(
  frame: RenderedFrame,
  format: FrameSinkFormat,
  png: PngEncodeOptions,
): Promise<Blob> {
  if (format === "exr") {
    if (frame.hdrFrame === undefined) {
      throw invalid("EXR frame sinks require capture or offline frames with an HdrFrame");
    }
    return frame.aovFrame !== undefined && frame.aovFrame.channels().length > 0
      ? frame.aovFrame.toExr(frame.hdrFrame)
      : frame.hdrFrame.toExr();
  }
  return frame.frame.toPng(png);
}

function sinkName(
  config: RenderConfig,
  index: number,
  format: FrameSinkFormat,
  requested?: string,
): string {
  const png = requested ?? config.frameFileName(index);
  return format === "exr" ? png.replace(/\.png$/u, ".exr") : png;
}

/** Keeps encoded frames in memory (tests, previews, zipping). */
export function createMemoryFrameSink(
  options: { config?: RenderConfig; format?: FrameSinkFormat; png?: PngEncodeOptions } = {},
): FrameSink & { readonly files: Map<string, Blob> } {
  const config = options.config ?? new RenderConfig();
  const format = options.format ?? "png";
  const files = new Map<string, Blob>();
  return {
    files,
    async write(frame, requested) {
      const name = sinkName(config, frame.index, format, requested);
      files.set(name, await encodeFrame(frame, format, options.png ?? {}));
      return name;
    },
  };
}

/**
 * Writes frames into `config.outputDir` below an OPFS or File System Access
 * directory (native `RenderConfig.ensure_output_dir` + `frame_path`).
 */
export async function createOpfsFrameSink(
  options: {
    root?: FileSystemDirectoryHandle;
    config?: RenderConfig;
    format?: FrameSinkFormat;
    png?: PngEncodeOptions;
  } = {},
): Promise<FrameSink & { readonly directory: FileSystemDirectoryHandle }> {
  const config = options.config ?? new RenderConfig();
  const format = options.format ?? "png";
  let root = options.root;
  if (root === undefined) {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    if (storage === undefined || typeof storage.getDirectory !== "function") {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Origin private file system is unavailable; pass a FileSystemDirectoryHandle",
        { kind: "opfs-unavailable" },
      );
    }
    root = await storage.getDirectory();
  }
  const directory = await config.ensureOutputDir(root);
  return {
    directory,
    async write(frame, requested) {
      const name = sinkName(config, frame.index, format, requested);
      const blob = await encodeFrame(frame, format, options.png ?? {});
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw new Forge3DError("IO_ERROR", `Failed to write ${name}`, error);
      }
      return name;
    },
  };
}

/**
 * Triggers one browser download per frame (`<a download>`); pass
 * `download` to route blobs elsewhere (tests, custom UI).
 */
export function createDownloadFrameSink(
  options: {
    config?: RenderConfig;
    format?: FrameSinkFormat;
    png?: PngEncodeOptions;
    download?: (blob: Blob, name: string) => void | Promise<void>;
  } = {},
): FrameSink {
  const config = options.config ?? new RenderConfig();
  const format = options.format ?? "png";
  const download =
    options.download ??
    ((blob: Blob, name: string) => {
      if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Download sinks need a document; pass a download callback in workers",
        );
      }
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.rel = "noopener";
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    });
  return {
    async write(frame, requested) {
      const name = sinkName(config, frame.index, format, requested);
      await download(await encodeFrame(frame, format, options.png ?? {}), name);
      return name;
    },
  };
}

/** Drains frames into a sink in order; closes (or aborts) the sink. */
export async function writeFrames(
  frames: AsyncIterable<RenderedFrame> | Iterable<RenderedFrame>,
  sink: FrameSink,
  options: { signal?: AbortSignal } = {},
): Promise<FrameWriteSummary> {
  const names: string[] = [];
  const timestampsUs: number[] = [];
  try {
    for await (const frame of frames) {
      if (options.signal?.aborted === true) {
        throw cancelled(options.signal);
      }
      names.push(await sink.write(frame));
      timestampsUs.push(frame.timestampUs);
    }
    await sink.close?.();
    return { frames: names.length, names, timestampsUs };
  } catch (error) {
    await Promise.resolve(sink.abort?.(error)).catch(() => undefined);
    throw Forge3DError.from(error);
  }
}

/** Native `FrameDumper`: auto-numbered frame capture into a sink. */
export class FrameDumper {
  readonly prefix: string;
  readonly #sink: FrameSink;
  readonly #config: RenderConfig;
  #frameCount = 0;
  #recording = false;

  constructor(sink: FrameSink, options: { prefix?: string; frameDigits?: number } = {}) {
    this.#sink = sink;
    this.prefix = options.prefix ?? "frame";
    this.#config = new RenderConfig({
      filenamePrefix: this.prefix,
      frameDigits: options.frameDigits ?? 4,
    });
  }

  startRecording(): void {
    if (this.#recording) {
      throw invalid("Already recording; call stopRecording() first");
    }
    this.#frameCount = 0;
    this.#recording = true;
  }

  /** Writes one frame; returns the frame file name. */
  async captureFrame(frame: Frame | RenderedFrame): Promise<string> {
    if (!this.#recording) {
      throw invalid("Not recording; call startRecording() first");
    }
    const index = this.#frameCount;
    const rendered: RenderedFrame =
      frame instanceof Frame
        ? { index, time: 0, timestampUs: 0, durationUs: 0, frame }
        : { ...frame, index };
    this.#frameCount += 1;
    return this.#sink.write(rendered, this.#config.frameFileName(index));
  }

  async stopRecording(): Promise<number> {
    if (!this.#recording) {
      throw invalid("Not recording");
    }
    this.#recording = false;
    await this.#sink.close?.();
    return this.#frameCount;
  }

  getFrameCount(): number {
    return this.#frameCount;
  }

  isRecording(): boolean {
    return this.#recording;
  }
}

/** Native `dump_frame_sequence`: writes frames and returns the count. */
export async function dumpFrameSequence(
  frames: Iterable<Frame> | AsyncIterable<Frame>,
  sink: FrameSink,
  options: { prefix?: string; frameDigits?: number } = {},
): Promise<number> {
  const dumper = new FrameDumper(sink, options);
  dumper.startRecording();
  for await (const frame of frames) {
    await dumper.captureFrame(frame);
  }
  return dumper.stopRecording();
}
