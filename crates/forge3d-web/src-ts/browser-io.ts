import { ByteReadPlan } from "./byte-materialization.js";
import { Forge3DError } from "./runtime-failure.js";
import type {
  BrowserByteSink,
  BrowserByteSource,
  ByteReadOptions,
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
  return new ByteReadPlan(source, options).read();
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
