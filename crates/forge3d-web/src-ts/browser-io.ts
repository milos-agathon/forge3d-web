import { Forge3DError } from "./index.js";
import type {
  BrowserByteSink,
  BrowserByteSource,
  ByteReadOptions,
  ByteReadProgress,
  ByteWriteResult,
} from "./index.js";

interface WritableFileHandle {
  write(data: FileSystemWriteChunkType): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<WritableFileHandle>;
}

interface DirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
}

function blobOptions(type: string | undefined): BlobPropertyBag {
  return type === undefined ? {} : { type };
}

export async function readByteSource(
  source: BrowserByteSource,
  options: ByteReadOptions = {},
): Promise<Uint8Array> {
  const signal = options.signal;
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const onProgress = options.onProgress;
  throwIfAborted(signal);

  if (source instanceof ArrayBuffer) {
    return finishRead(
      [new Uint8Array(source.slice(0))],
      source.byteLength,
      maxBytes,
      onProgress,
      signal,
    );
  }
  if (ArrayBuffer.isView(source)) {
    const bytes = new Uint8Array(
      source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ),
    );
    return finishRead([bytes], bytes.byteLength, maxBytes, onProgress, signal);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return readStream(
      source.stream(),
      source.size,
      maxBytes,
      onProgress,
      signal,
    );
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    if (!source.ok) {
      throw new Forge3DError(
        "IO_ERROR",
        `HTTP request failed with status ${source.status}`,
        { status: source.status },
      );
    }
    const total = parseContentLength(source.headers.get("content-length"));
    if (source.body !== null) {
      return readStream(source.body, total, maxBytes, onProgress, signal);
    }
    try {
      const buffer = await source.arrayBuffer();
      return finishRead(
        [new Uint8Array(buffer)],
        buffer.byteLength,
        maxBytes,
        onProgress,
        signal,
      );
    } catch (error) {
      throw mapPlatformError(error);
    }
  }
  if (isReadableStream(source)) {
    return readStream(source, undefined, maxBytes, onProgress, signal);
  }
  if (typeof source === "string" || source instanceof URL) {
    return readFetchResponse(source, maxBytes, onProgress, signal);
  }
  throw new Forge3DError(
    "INVALID_INPUT",
    "unsupported byte source",
  );
}

export async function writeByteSink(
  bytes: BufferSource,
  sink: BrowserByteSink,
): Promise<ByteWriteResult> {
  const data = toBytes(bytes);
  try {
    switch (sink.kind) {
      case "blob":
        return {
          bytesWritten: data.byteLength,
          blob: new Blob([data as BlobPart], blobOptions(sink.type)),
        };
      case "stream": {
        const writer = sink.stream.getWriter();
        try {
          await writer.write(data);
          await writer.close();
        } catch (error) {
          await abortStreamWriter(writer);
          throw error;
        } finally {
          writer.releaseLock();
        }
        return { bytesWritten: data.byteLength };
      }
      case "file-system": {
        const handle =
          sink.handle ??
          (await pickSaveFileHandle(sink.suggestedName, sink.type));
        const writable = await handle.createWritable();
        try {
          await writable.write(
            new Blob([data as BlobPart], blobOptions(sink.type)),
          );
          await writable.close();
        } catch (error) {
          await abortFileWritable(writable);
          throw error;
        }
        return { bytesWritten: data.byteLength, handle };
      }
      case "opfs": {
        const handle = await openOpfsFile(sink.path);
        const writable = await handle.createWritable();
        try {
          await writable.write(
            new Blob([data as BlobPart], blobOptions(sink.type)),
          );
          await writable.close();
        } catch (error) {
          await abortFileWritable(writable);
          throw error;
        }
        return { bytesWritten: data.byteLength };
      }
      case "download": {
        const blob = new Blob([data as BlobPart], blobOptions(sink.type));
        triggerDownload(blob, sink.filename);
        return { bytesWritten: data.byteLength, blob };
      }
      default:
        throw new Forge3DError(
          "INVALID_INPUT",
          `unknown sink kind ${String((sink as { kind?: unknown }).kind)}`,
        );
    }
  } catch (error) {
    if (error instanceof Forge3DError) {
      throw error;
    }
    throw mapPlatformError(error);
  }
}

function toBytes(bytes: BufferSource): Uint8Array {
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new Forge3DError("INVALID_INPUT", "bytes must be a BufferSource");
}

async function readFetchResponse(
  url: string | URL,
  maxBytes: number | undefined,
  onProgress: ((progress: ByteReadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(typeof url === "string" ? url : url.href, {
      credentials: "same-origin",
      signal: signal ?? null,
    });
  } catch (error) {
    throw mapPlatformError(error);
  }
  if (!response.ok) {
    throw new Forge3DError(
      "IO_ERROR",
      `HTTP request failed with status ${response.status}`,
      { status: response.status, url: String(url) },
    );
  }
  const total = parseContentLength(response.headers.get("content-length"));
  if (response.body !== null) {
    return readStream(response.body, total, maxBytes, onProgress, signal);
  }
  try {
    const buffer = await response.arrayBuffer();
    return finishRead(
      [new Uint8Array(buffer)],
      buffer.byteLength,
      maxBytes,
      onProgress,
      signal,
    );
  } catch (error) {
    throw mapPlatformError(error);
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  total: number | undefined,
  maxBytes: number | undefined,
  onProgress: ((progress: ByteReadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      throwIfAborted(signal);
      if (value === undefined) {
        continue;
      }
      const chunk = toBytes(value as BufferSource);
      if (
        maxBytes !== undefined &&
        loaded + chunk.byteLength > maxBytes
      ) {
        try {
          await reader.cancel();
        } catch {}
        throw new Forge3DError(
          "RESOURCE_LIMIT_EXCEEDED",
          `byte source exceeds the ${maxBytes} byte limit`,
        );
      }
      chunks.push(chunk);
      loaded += chunk.byteLength;
      onProgress?.(progressEvent(loaded, total, false));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return finishRead(chunks, total ?? loaded, maxBytes, onProgress, signal);
}

function finishRead(
  chunks: Uint8Array[],
  total: number | undefined,
  maxBytes: number | undefined,
  onProgress: ((progress: ByteReadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Uint8Array {
  throwIfAborted(signal);
  let loaded = 0;
  for (const chunk of chunks) {
    loaded += chunk.byteLength;
  }
  if (maxBytes !== undefined && loaded > maxBytes) {
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      `byte source exceeds the ${maxBytes} byte limit`,
    );
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(progressEvent(loaded, total, true));
  return result;
}

function progressEvent(
  loaded: number,
  total: number | undefined,
  done: boolean,
): ByteReadProgress {
  return total === undefined
    ? { loaded, done }
    : { loaded, total, done };
}

function normalizeMaxBytes(maxBytes: number | undefined): number | undefined {
  if (maxBytes === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "maxBytes must be a positive safe integer",
    );
  }
  return maxBytes;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Forge3DError("REQUEST_CANCELLED", "Read was cancelled");
  }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === "function"
  );
}

async function pickSaveFileHandle(
  suggestedName: string | undefined,
  type: string | undefined,
): Promise<FileSystemFileHandle> {
  const picker = (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== "function") {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "File System Access API is not available",
    );
  }
  const options: Record<string, unknown> = {};
  if (suggestedName !== undefined) {
    options.suggestedName = suggestedName;
  }
  if (type !== undefined) {
    options.types = [
      { accept: { [type]: [] as string[] } },
    ];
  }
  return picker(options);
}

async function openOpfsFile(
  path: string,
): Promise<FileSystemFileHandle> {
  const storage = (
    globalThis as typeof globalThis & {
      navigator?: Navigator & {
        storage?: { getDirectory?: () => Promise<DirectoryHandleLike> };
      };
    }
  ).navigator?.storage;
  if (typeof storage?.getDirectory !== "function") {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "OPFS is not available",
    );
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "opfs path must not contain '.' or '..' segments",
    );
  }
  if (segments.length === 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "opfs path must name a file",
    );
  }
  let directory = await storage.getDirectory();
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, {
      create: true,
    });
  }
  return directory.getFileHandle(segments[segments.length - 1]!, {
    create: true,
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const documentLike = (
    globalThis as typeof globalThis & {
      document?: {
        createElement(tag: string): {
          href: string;
          download: string;
          click(): void;
          remove(): void;
        };
      };
      URL?: typeof URL & { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
    }
  );
  const createObjectURL = documentLike.URL?.createObjectURL;
  const revokeObjectURL = documentLike.URL?.revokeObjectURL;
  const documentRef = documentLike.document;
  if (
    documentRef === undefined ||
    typeof createObjectURL !== "function" ||
    typeof revokeObjectURL !== "function"
  ) {
    return;
  }
  const anchor = documentRef.createElement("a");
  const url = createObjectURL.call(documentLike.URL, blob);
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    revokeObjectURL.call(documentLike.URL, url);
    anchor.remove();
  }
}

async function abortStreamWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  try {
    await writer.abort();
  } catch {}
}

async function abortFileWritable(
  writable: WritableFileHandle,
): Promise<void> {
  try {
    await writable.abort?.();
  } catch {}
  try {
    await writable.close();
  } catch {}
}

function mapPlatformError(error: unknown): Forge3DError {
  if (error instanceof Forge3DError) {
    return error;
  }
  const name =
    typeof error === "object" && error !== null
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError") {
    return new Forge3DError("RESOURCE_LIMIT_EXCEEDED", message, error);
  }
  if (name === "AbortError") {
    return new Forge3DError("REQUEST_CANCELLED", message, error);
  }
  return new Forge3DError("IO_ERROR", message, error);
}
