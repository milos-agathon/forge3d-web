import { afterEach, describe, expect, it, vi } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type { ByteReadProgress } from "../../src-ts/index.js";
import { readByteSource, writeByteSink } from "../../src-ts/browser-io.js";

function expectReject(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readByteSource", () => {
  it("reads ArrayBuffer and exact view slices", async () => {
    const buffer = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
    expect(Array.from(await readByteSource(buffer))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);

    const view = new Uint8Array(buffer, 2, 2);
    const out = await readByteSource(view);
    expect(Array.from(out)).toEqual([2, 3]);
    view[0] = 99;
    expect(out[0]).toBe(2);
  });

  it("reads Blob and Response bodies", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])]);
    expect(Array.from(await readByteSource(blob))).toEqual([7, 8, 9]);

    const response = new Response(new Uint8Array([4, 5]), {
      status: 200,
      headers: { "content-length": "2" },
    });
    const progress: ByteReadProgress[] = [];
    const out = await readByteSource(response, {
      onProgress: (entry) => progress.push(entry),
    });
    expect(Array.from(out)).toEqual([4, 5]);
    expect(progress.at(-1)).toEqual({ loaded: 2, total: 2, done: true });
  });

  it("rejects failed HTTP responses", async () => {
    await expectReject(
      readByteSource(new Response("nope", { status: 500 })),
      "IO_ERROR",
    );

    vi.stubGlobal("fetch", async () => new Response("no", { status: 404 }));
    await expectReject(
      readByteSource("https://example.test/missing"),
      "IO_ERROR",
    );
  });

  it("fetches string and URL sources with same-origin defaults", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    await readByteSource(new URL("https://example.test/a"));
    await readByteSource("https://example.test/b");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(calls[0]!.url).toBe("https://example.test/a");
  });

  it("reads streams with monotonic progress", async () => {
    const progress: ByteReadProgress[] = [];
    const out = await readByteSource(
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
      { onProgress: (entry) => progress.push(entry) },
    );
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!.loaded).toBeGreaterThanOrEqual(
        progress[i - 1]!.loaded,
      );
    }
    expect(progress.at(-1)!.done).toBe(true);
    expect(progress.at(-1)!.loaded).toBe(3);
  });

  it("enforces maxBytes and stops consuming after overflow", async () => {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array([produced]));
      },
    });
    await expectReject(
      readByteSource(stream, { maxBytes: 2 }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    expect(produced).toBeLessThanOrEqual(4);

    await expectReject(
      readByteSource(new Uint8Array([1, 2, 3]), { maxBytes: 2 }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    await expectReject(
      readByteSource(new Uint8Array([1]), { maxBytes: 1.5 }),
      "INVALID_INPUT",
    );
  });

  it("cancels before and during reads with a stable REQUEST_CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectReject(
      readByteSource(new Uint8Array([1]), { signal: controller.signal }),
      "REQUEST_CANCELLED",
    );

    const pending = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pending.abort();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return Promise.resolve();
      },
    });
    await expectReject(
      readByteSource(stream, { signal: pending.signal }),
      "REQUEST_CANCELLED",
    );
    expect(cancelled).toBe(true);
  });
});

describe("writeByteSink", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it("writes blob sinks", async () => {
    const result = await writeByteSink(bytes, {
      kind: "blob",
      type: "application/octet-stream",
    });
    expect(result.bytesWritten).toBe(4);
    expect(await result.blob!.text()).toEqual(
      await new Blob([bytes]).text(),
    );
  });

  it("writes writable streams with awaited backpressure", async () => {
    const received: number[] = [];
    const writes: number[] = [];
    const stream = new WritableStream<Uint8Array>({
      async write(chunk) {
        writes.push(chunk.byteLength);
        await new Promise((resolve) => setTimeout(resolve, 1));
        received.push(...chunk);
      },
    });
    const result = await writeByteSink(bytes, { kind: "stream", stream });
    expect(result.bytesWritten).toBe(4);
    expect(writes).toEqual([4]);
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it("maps missing File System Access API to UNSUPPORTED_FEATURE", async () => {
    await expectReject(
      writeByteSink(bytes, { kind: "file-system" }),
      "UNSUPPORTED_FEATURE",
    );
  });

  it("uses a supplied file-system handle", async () => {
    const written: Blob[] = [];
    const handle = {
      createWritable: async () => ({
        write: async (data: Blob) => {
          written.push(data);
        },
        close: async () => undefined,
      }),
    } as unknown as FileSystemFileHandle;
    const result = await writeByteSink(bytes, {
      kind: "file-system",
      handle,
    });
    expect(result.bytesWritten).toBe(4);
    expect(result.handle).toBe(handle);
    expect(written).toHaveLength(1);
    expect(new Uint8Array(await written[0]!.arrayBuffer())).toEqual(bytes);
  });

  it("maps missing OPFS to UNSUPPORTED_FEATURE", async () => {
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: "a/b.bin" }),
      "UNSUPPORTED_FEATURE",
    );
  });

  it("creates nested OPFS directories and writes the file", async () => {
    const writes: Array<{ path: string; data: Blob }> = [];
    const makeDirectory = (prefix: string): unknown => ({
      getDirectoryHandle: async (name: string) =>
        makeDirectory(`${prefix}${name}/`),
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (data: Blob) => {
            writes.push({ path: `${prefix}${name}`, data });
          },
          close: async () => undefined,
        }),
      }),
    });
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => makeDirectory("") },
    });
    const result = await writeByteSink(bytes, {
      kind: "opfs",
      path: "deep/nested/file.bin",
    });
    expect(result.bytesWritten).toBe(4);
    expect(writes.map((write) => write.path)).toEqual([
      "deep/nested/file.bin",
    ]);
  });

  it("maps QuotaExceededError to RESOURCE_LIMIT_EXCEEDED", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => {
          const error = new Error("quota");
          error.name = "QuotaExceededError";
          throw error;
        },
      },
    });
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: "f.bin" }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
  });

  it("maps AbortError to REQUEST_CANCELLED", async () => {
    const handle = {
      createWritable: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    } as unknown as FileSystemFileHandle;
    await expectReject(
      writeByteSink(bytes, { kind: "file-system", handle }),
      "REQUEST_CANCELLED",
    );
  });

  it("downloads through a temporary anchor and always revokes", async () => {
    const anchors: Array<Record<string, unknown>> = [];
    const revoked: string[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const anchor = {
          href: "",
          download: "",
          clicks: 0,
          removed: false,
          click() {
            this.clicks += 1;
          },
          remove() {
            this.removed = true;
          },
        };
        anchors.push(anchor);
        return anchor;
      },
    });
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    }));

    const result = await writeByteSink(bytes, {
      kind: "download",
      filename: "terrain.bin",
    });
    expect(result.bytesWritten).toBe(4);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!["clicks"]).toBe(1);
    expect(anchors[0]!["removed"]).toBe(true);
    expect(anchors[0]!["download"]).toBe("terrain.bin");
    expect(revoked).toEqual(["blob:fake"]);
  });

  it("still returns the blob when download DOM APIs are absent", async () => {
    const result = await writeByteSink(bytes, {
      kind: "download",
      filename: "x.bin",
    });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.bytesWritten).toBe(4);
  });

  it("aborts a writable stream writer after a write failure", async () => {
    const abort = vi.fn(async () => undefined);
    const stream = {
      getWriter: () => ({
        write: async () => {
          throw new Error("write failed");
        },
        close: async () => undefined,
        abort,
        releaseLock: () => undefined,
      }),
    } as unknown as WritableStream<Uint8Array>;
    await expectReject(
      writeByteSink(bytes, { kind: "stream", stream }),
      "IO_ERROR",
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts a file-system writable after a write failure", async () => {
    const abort = vi.fn(async () => undefined);
    const handle = {
      createWritable: async () => ({
        write: async () => {
          throw new Error("disk failed");
        },
        close: async () => undefined,
        abort,
      }),
    } as unknown as FileSystemFileHandle;
    await expectReject(
      writeByteSink(bytes, { kind: "file-system", handle }),
      "IO_ERROR",
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("rejects dot segments in OPFS paths", async () => {
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({}) },
    });
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: "a/../b.bin" }),
      "INVALID_INPUT",
    );
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: "./file.bin" }),
      "INVALID_INPUT",
    );
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: "a/./b.bin" }),
      "INVALID_INPUT",
    );
    await expectReject(
      writeByteSink(bytes, { kind: "opfs", path: ".." }),
      "INVALID_INPUT",
    );
  });
});
