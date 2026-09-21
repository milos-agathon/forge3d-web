import { Forge3DError } from "./index.js";
import type {
  BrowserByteSink,
  ByteWriteResult,
  Forge3DOffscreenRendererOptions,
  Forge3DScene as Forge3DSceneShape,
  OffscreenOutput,
} from "./index.js";
import { writeByteSink } from "./browser-io.js";
import { Forge3DSession } from "./session.js";

interface CanvasLike {
  width: number;
  height: number;
}

export class Forge3DOffscreenRenderer {
  readonly #session: Forge3DSession;
  readonly #width: number;
  readonly #height: number;
  #disposed = false;

  private constructor(
    session: Forge3DSession,
    width: number,
    height: number,
  ) {
    this.#session = session;
    this.#width = width;
    this.#height = height;
  }

  static async create(
    options: Forge3DOffscreenRendererOptions,
  ): Promise<Forge3DOffscreenRenderer> {
    const { width, height, ...sessionOptions } = options;
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "width and height must be positive safe integers",
      );
    }
    const canvas = createOffscreenCanvas(width, height);
    const session = await Forge3DSession.create(
      canvas as unknown as OffscreenCanvas,
      sessionOptions,
    );
    return new Forge3DOffscreenRenderer(session, width, height);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  setScene(scene: Forge3DSceneShape): void {
    this.#assertLive();
    this.#session.setScene(scene);
  }

  render(): boolean {
    this.#assertLive();
    return this.#session.render();
  }

  async capture(kind: OffscreenOutput["kind"]): Promise<OffscreenOutput> {
    this.#assertLive();
    switch (kind) {
      case "blob":
        return { kind: "blob", value: await this.#session.screenshot() };
      case "image-bitmap": {
        const createImageBitmapFn = (
          globalThis as typeof globalThis & {
            createImageBitmap?: (source: Blob) => Promise<ImageBitmap>;
          }
        ).createImageBitmap;
        if (typeof createImageBitmapFn !== "function") {
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "createImageBitmap is not available",
          );
        }
        const blob = await this.#session.screenshot();
        return {
          kind: "image-bitmap",
          value: await createImageBitmapFn(blob),
        };
      }
      case "rgba8": {
        const value = await this.#session.readRgba();
        const expected = this.#width * this.#height * 4;
        if (value.byteLength !== expected) {
          throw new Forge3DError(
            "INTERNAL_ERROR",
            `rgba8 readback returned ${value.byteLength} bytes, expected ${expected}`,
          );
        }
        return {
          kind: "rgba8",
          value,
          width: this.#width,
          height: this.#height,
        };
      }
      case "stream": {
        const blob = await this.#session.screenshot();
        return { kind: "stream", value: byteStreamOf(blob) };
      }
      default:
        throw new Forge3DError(
          "INVALID_INPUT",
          `unknown capture kind ${String(kind)}`,
        );
    }
  }

  async write(sink: BrowserByteSink): Promise<ByteWriteResult> {
    this.#assertLive();
    const output = (await this.capture("blob")) as {
      kind: "blob";
      value: Blob;
    };
    const bytes = new Uint8Array(await output.value.arrayBuffer());
    return writeByteSink(bytes, sink);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#session.dispose();
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Forge3DError(
        "RUNTIME_DISPOSED",
        "Offscreen renderer is disposed",
      );
    }
  }
}

function createOffscreenCanvas(
  width: number,
  height: number,
): CanvasLike {
  const OffscreenCanvasCtor = (
    globalThis as typeof globalThis & {
      OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
    }
  ).OffscreenCanvas;
  if (typeof OffscreenCanvasCtor === "function") {
    return new OffscreenCanvasCtor(width, height);
  }
  const documentLike = (
    globalThis as typeof globalThis & {
      document?: {
        createElement(tag: string): {
          width: number;
          height: number;
          style: { display: string };
        };
      };
    }
  ).document;
  if (typeof documentLike?.createElement === "function") {
    const canvas = documentLike.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = "none";
    return canvas;
  }
  throw new Forge3DError(
    "UNSUPPORTED_FEATURE",
    "Neither OffscreenCanvas nor DOM canvas is available",
  );
}

function byteStreamOf(blob: Blob): ReadableStream<Uint8Array> {
  const source = blob.stream();
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value === undefined) {
        return;
      }
      controller.enqueue(
        value instanceof Uint8Array
          ? value
          : new Uint8Array(
              (value as ArrayBufferView).buffer,
              (value as ArrayBufferView).byteOffset,
              (value as ArrayBufferView).byteLength,
            ),
      );
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
