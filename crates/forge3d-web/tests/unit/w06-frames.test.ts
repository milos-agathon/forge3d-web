import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { RenderConfig } from "../../src-ts/camera-animation.js";
import {
  createDownloadFrameSink,
  createMemoryFrameSink,
  dumpFrameSequence,
  FrameDumper,
  frameTimestampUs,
  renderFrames,
  writeFrames,
  type FrameRenderTarget,
} from "../../src-ts/frame-stream.js";
import { AovFrame, aovObjectId, encodePng, Frame, HdrFrame } from "../../src-ts/frames.js";
import { CameraAnimation } from "../../src-ts/camera-animation.js";
import type { CameraInput, CaptureOptions } from "../../src-ts/index.js";
import { encodeVideo, muxEncodedVideo, probeVideoCodecs } from "../../src-ts/video.js";

function frame(value = 7, width = 3, height = 2): Frame {
  return new Frame(width, height, new Uint8Array(width * height * 4).fill(value));
}

function pngChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

describe("W06 frame types", () => {
  it("validates sizes and exposes native accessors", () => {
    const f = frame();
    expect(f.size()).toEqual([3, 2]);
    expect(f.format).toBe("rgba8unorm");
    expect(f.pixel(2, 1)).toEqual([7, 7, 7, 7]);
    expect(() => f.pixel(3, 0)).toThrow(/outside/);
    expect(() => new Frame(3, 2, new Uint8Array(5))).toThrow(/24 values/);
    const hdr = new HdrFrame(1, 1, new Float32Array([2, 3, 4, 1]));
    expect(hdr.size).toEqual([1, 1]);
    const copy = hdr.toFloat32();
    copy[0] = 0;
    expect(hdr.data[0]).toBe(2);
  });

  it("reports missing AOVs with native wording and converts linear depth", () => {
    const aov = new AovFrame({ width: 2, height: 1, near: 1, far: 11, depth: new Float32Array([0, 0.5]) });
    expect(aov.channels()).toEqual(["depth"]);
    expect(aov.hasNormal).toBe(false);
    expect(() => aov.normal()).toThrow("Normal AOV not available");
    expect(Array.from(aov.linearDepth())).toEqual([1, 6]);
    expect(() => new AovFrame({ width: 1, height: 1, near: 2, far: 1 })).toThrow(/far > near/);
    expect(() => new AovFrame({ width: 1, height: 1, near: 0, far: 1, id: new Uint32Array(2) })).toThrow(/1 values/);
    expect(aovObjectId(0)).toBe(2);
  });

  it("encodes deterministic lossless PNGs in both zlib modes", async () => {
    const rgba = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 0, 9, 9, 9, 9]);
    for (const compression of ["none", "deflate"] as const) {
      const a = new Uint8Array(await (await encodePng(2, 2, rgba, { compression })).arrayBuffer());
      const b = new Uint8Array(await (await encodePng(2, 2, rgba, { compression })).arrayBuffer());
      expect(a).toEqual(b);
      expect(Array.from(a.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const chunks = pngChunks(a);
      expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
      const raw = inflateSync(chunks[1]!.data);
      expect(raw.length).toBe(2 * (2 * 4 + 1));
      expect(Array.from(raw.subarray(1, 9))).toEqual(Array.from(rgba.subarray(0, 8)));
      expect(Array.from(raw.subarray(10, 18))).toEqual(Array.from(rgba.subarray(8, 16)));
    }
    await expect(encodePng(2, 2, rgba.subarray(1))).rejects.toThrow(/16 values/);
  });
});

class FakeTarget implements FrameRenderTarget {
  readonly width = 2;
  readonly height = 1;
  cameras: CameraInput[] = [];
  captures: CaptureOptions[] = [];
  setCamera(camera: CameraInput): void {
    this.cameras.push(camera);
  }
  render(): boolean {
    return true;
  }
  async readRgba(): Promise<Uint8Array> {
    return new Uint8Array(8).fill(this.cameras.length);
  }
  async capture(options: CaptureOptions = {}) {
    this.captures.push(options);
    const value = this.cameras.length;
    return {
      frame: new Frame(2, 1, new Uint8Array(8).fill(value)),
      hdrFrame: new HdrFrame(2, 1, new Float32Array(8).fill(value)),
      aovFrame: new AovFrame({ width: 2, height: 1, near: 0.1, far: 10 }),
    };
  }
  async renderOffline(): Promise<never> {
    throw new Error("unused");
  }
}

const animation = new CameraAnimation([
  { time: 0, phiDeg: 0, thetaDeg: 45, radius: 5, fovDeg: 50, target: [0, 0, 0] },
  { time: 1, phiDeg: 90, thetaDeg: 45, radius: 5, fovDeg: 50, target: [0, 0, 0] },
]);

describe("W06 frame sequences and sinks", () => {
  it("renders exact timestamps, chains previous cameras and reports progress", async () => {
    const target = new FakeTarget();
    const progress: number[] = [];
    const frames = [];
    for await (const rendered of renderFrames(target, { animation, fps: 4, onProgress: (p) => progress.push(p.frame) })) {
      frames.push(rendered);
    }
    expect(frames.map((f) => f.timestampUs)).toEqual([0, 250000, 500000, 750000, 1000000]);
    expect(frames.every((f) => f.durationUs === 250000)).toBe(true);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(target.captures[0]!.previousCamera).toEqual(target.cameras[0]);
    expect(target.captures[1]!.previousCamera).toEqual(target.cameras[0]);
    expect(target.captures[2]!.previousCamera).toEqual(target.cameras[1]);
    expect(frameTimestampUs(1, 30)).toBe(33333);
    expect(frameTimestampUs(2, 30)).toBe(66667);
  });

  it("validates ranges, cancels and names sink files natively", async () => {
    const target = new FakeTarget();
    await expect(renderFrames(target, { animation, fps: 4, startFrame: 4, endFrame: 2 }).next()).rejects.toThrow(/range/);
    await expect(renderFrames(target, { fps: 4 }).next()).rejects.toThrow(/animation or cameraAt/);
    await expect(renderFrames(target, { cameraAt: () => target.cameras[0]!, fps: 4 }).next()).rejects.toThrow(/frameCount/);
    const controller = new AbortController();
    controller.abort();
    await expect(renderFrames(target, { animation, fps: 4, signal: controller.signal }).next()).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });

    const sink = createMemoryFrameSink({ config: new RenderConfig({ filenamePrefix: "take", frameDigits: 3 }) });
    const summary = await writeFrames(renderFrames(target, { animation, fps: 2, mode: "display" }), sink);
    expect(summary.names).toEqual(["take_000.png", "take_001.png", "take_002.png"]);
    expect(summary.timestampsUs).toEqual([0, 500000, 1000000]);
    expect([...sink.files.values()].every((blob) => blob.type === "image/png")).toBe(true);

    const downloaded: string[] = [];
    await writeFrames(
      renderFrames(target, { animation, fps: 1 }),
      createDownloadFrameSink({ format: "exr", download: (_blob, name) => void downloaded.push(name) }),
    ).catch(() => undefined);
    // EXR encoding needs the WASM bridge; the sink is aborted with a typed error in Node.
    expect(downloaded).toEqual([]);
  });

  it("implements the native FrameDumper contract", async () => {
    const sink = createMemoryFrameSink();
    const dumper = new FrameDumper(sink, { prefix: "render" });
    expect(dumper.isRecording()).toBe(false);
    await expect(dumper.captureFrame(frame())).rejects.toThrow(/Not recording/);
    dumper.startRecording();
    expect(() => dumper.startRecording()).toThrow(/Already recording/);
    expect(await dumper.captureFrame(frame())).toBe("render_0000.png");
    expect(await dumper.captureFrame(frame(9))).toBe("render_0001.png");
    expect(dumper.getFrameCount()).toBe(2);
    expect(await dumper.stopRecording()).toBe(2);
    await expect(dumper.stopRecording()).rejects.toThrow(/Not recording/);
    expect(await dumpFrameSequence([frame(), frame(), frame()], createMemoryFrameSink())).toBe(3);
  });
});

describe("W06 video export diagnostics", () => {
  it("returns a typed unavailable-codec diagnostic without WebCodecs", async () => {
    expect(globalThis.VideoEncoder).toBeUndefined();
    const probes = await probeVideoCodecs({ width: 4, height: 4, fps: 30 });
    expect(probes.map((p) => [p.codec, p.supported, p.reason])).toEqual([
      ["avc", false, "webcodecs-unavailable"],
      ["vp9", false, "webcodecs-unavailable"],
      ["av1", false, "webcodecs-unavailable"],
      ["hevc", false, "webcodecs-unavailable"],
    ]);
    await expect(encodeVideo([frame()], { fps: 30 })).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
      details: { kind: "video-codec-unavailable", container: "mp4", webCodecs: false },
    });
    await expect(encodeVideo([frame()], { fps: 30, container: "webm", codec: "avc" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(encodeVideo([], { fps: 30 })).rejects.toThrow(/at least one frame/);
    await expect(encodeVideo([frame()], { fps: 0 })).rejects.toThrow(/fps/);
  });

  it("muxes identical chunks to identical bytes regardless of wall-clock time", async () => {
    const chunk = { data: new Uint8Array([1, 2, 3, 4]), type: "key" as const, timestampUs: 0, durationUs: 33333 };
    for (const container of ["mp4", "webm"] as const) {
      const options = { codec: "vp9" as const, container, width: 16, height: 16, fps: 30 };
      const a = new Uint8Array(await (await muxEncodedVideo([chunk], options)).arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const b = new Uint8Array(await (await muxEncodedVideo([chunk], options)).arrayBuffer());
      expect(a, container).toEqual(b);
      expect(a.length, container).toBeGreaterThan(32);
    }
    await expect(
      muxEncodedVideo([{ ...chunk, type: "delta" }], { codec: "vp9", width: 16, height: 16, fps: 30 }),
    ).rejects.toThrow(/key frame/);
  });
});
