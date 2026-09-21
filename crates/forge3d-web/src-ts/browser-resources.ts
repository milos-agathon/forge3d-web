import { Forge3DError } from "./index.js";
import type {
  Forge3DMessageCallOptions,
  Forge3DMessageContext,
  Forge3DWorkerPoolOptions,
  WorkerExecutionMode,
  WorkerPoolDiagnostics,
} from "./index.js";
import { Forge3DMessageClient } from "./message-protocol.js";

export function selectWorkerExecutionMode(input?: {
  workerAvailable?: boolean;
  crossOriginIsolated?: boolean;
  sharedArrayBufferAvailable?: boolean;
  preferSharedArrayBuffer?: boolean;
}): WorkerExecutionMode {
  const workerAvailable =
    input?.workerAvailable ??
    typeof (globalThis as typeof globalThis & { Worker?: unknown }).Worker !==
      "undefined";
  const crossOriginIsolated =
    input?.crossOriginIsolated ?? globalThis.crossOriginIsolated === true;
  const sharedArrayBufferAvailable =
    input?.sharedArrayBufferAvailable ??
    typeof (
      globalThis as typeof globalThis & { SharedArrayBuffer?: unknown }
    ).SharedArrayBuffer !== "undefined";
  const preferSharedArrayBuffer = input?.preferSharedArrayBuffer ?? false;
  if (
    workerAvailable &&
    crossOriginIsolated &&
    sharedArrayBufferAvailable &&
    preferSharedArrayBuffer
  ) {
    return "shared-array-buffer";
  }
  if (workerAvailable) {
    return "transferable";
  }
  return "main-thread";
}

interface PoolRun {
  id: number;
  payload: unknown;
  options: Forge3DMessageCallOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  onAbort: (() => void) | undefined;
}

interface PoolWorker {
  client: Forge3DMessageClient;
  busy: boolean;
}

export class Forge3DWorkerPool {
  readonly #mode: WorkerExecutionMode;
  readonly #size: number;
  readonly #maxQueued: number;
  readonly #handler: Forge3DWorkerPoolOptions["mainThreadHandler"];
  readonly #workers: PoolWorker[] = [];
  readonly #queue: PoolRun[] = [];
  #mainBusy = false;
  #mainAbort: AbortController | undefined;
  #mainRun: PoolRun | undefined;
  #requestId = 0;
  #disposed = false;

  constructor(options: Forge3DWorkerPoolOptions) {
    if (typeof options !== "object" || options === null) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "pool options must be an object",
      );
    }
    if (typeof options.mainThreadHandler !== "function") {
      throw new Forge3DError(
        "INVALID_INPUT",
        "mainThreadHandler must be a function",
      );
    }
    this.#handler = options.mainThreadHandler;
    const size =
      options.size ??
      Math.min(
        Math.max(
          Math.trunc(
            (
              globalThis as typeof globalThis & {
                navigator?: { hardwareConcurrency?: number };
              }
            ).navigator?.hardwareConcurrency ?? 1,
          ),
          1,
        ),
        4,
      );
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "size must be a positive safe integer",
      );
    }
    this.#maxQueued = options.maxQueued ?? 64;
    if (!Number.isSafeInteger(this.#maxQueued) || this.#maxQueued <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "maxQueued must be a positive safe integer",
      );
    }
    if (options.workerFactory === undefined) {
      this.#mode = "main-thread";
      this.#size = 1;
      return;
    }
    this.#mode = selectWorkerExecutionMode({
      workerAvailable: true,
      preferSharedArrayBuffer: options.preferSharedArrayBuffer ?? false,
    });
    this.#size = size;
    for (let index = 0; index < size; index += 1) {
      const port = options.workerFactory(index);
      this.#workers.push({
        client: new Forge3DMessageClient(port),
        busy: false,
      });
    }
  }

  run<T = unknown>(
    payload: unknown,
    options: Forge3DMessageCallOptions = {},
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(
        new Forge3DError("RUNTIME_DISPOSED", "Worker pool is disposed"),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new Forge3DError("REQUEST_CANCELLED", "Work was cancelled"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const unit: PoolRun = {
        id: this.#requestId,
        payload,
        options,
        resolve: resolve as (value: unknown) => void,
        reject,
        settled: false,
        onAbort: undefined,
      };
      this.#requestId += 1;
      this.#dispatchOrQueue(unit);
    });
  }

  getDiagnostics(): WorkerPoolDiagnostics {
    return {
      mode: this.#mode,
      size: this.#size,
      active:
        this.#workers.filter((worker) => worker.busy).length +
        (this.#mainBusy ? 1 : 0),
      queued: this.#queue.length,
      disposed: this.#disposed,
    };
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const error = new Forge3DError(
      "RUNTIME_DISPOSED",
      "Worker pool is disposed",
    );
    for (const unit of this.#queue.splice(0)) {
      this.#settleUnit(unit, () => unit.reject(error));
    }
    const active = this.#mainRun;
    this.#mainAbort?.abort();
    if (active !== undefined) {
      this.#settleUnit(active, () => active.reject(error));
    }
    for (const worker of this.#workers) {
      worker.client.dispose();
    }
  }

  #settleUnit(unit: PoolRun, action: () => void): void {
    if (unit.settled) {
      return;
    }
    unit.settled = true;
    if (unit.onAbort !== undefined) {
      unit.options.signal?.removeEventListener("abort", unit.onAbort);
      unit.onAbort = undefined;
    }
    action();
  }

  #dispatchOrQueue(unit: PoolRun): void {
    const signal = unit.options.signal;
    unit.onAbort = () => {
      const index = this.#queue.indexOf(unit);
      if (index >= 0) {
        this.#queue.splice(index, 1);
        this.#settleUnit(unit, () =>
          unit.reject(
            new Forge3DError("REQUEST_CANCELLED", "Work was cancelled"),
          ),
        );
        return;
      }
      if (this.#mainRun === unit) {
        this.#mainAbort?.abort();
        this.#settleUnit(unit, () =>
          unit.reject(
            new Forge3DError("REQUEST_CANCELLED", "Work was cancelled"),
          ),
        );
      }
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", unit.onAbort, { once: true });
    }
    if (this.#tryDispatch(unit)) {
      return;
    }
    if (this.#queue.length >= this.#maxQueued) {
      this.#settleUnit(unit, () =>
        unit.reject(
          new Forge3DError(
            "RESOURCE_LIMIT_EXCEEDED",
            "worker queue is full",
          ),
        ),
      );
      return;
    }
    this.#queue.push(unit);
  }

  #tryDispatch(unit: PoolRun): boolean {
    const worker = this.#workers.find((candidate) => !candidate.busy);
    if (worker !== undefined) {
      worker.busy = true;
      if (unit.onAbort !== undefined) {
        unit.options.signal?.removeEventListener("abort", unit.onAbort);
        unit.onAbort = undefined;
      }
      const dispatch = this.#workerDispatchOptions(unit);
      worker.client
        .call("run", dispatch.payload, dispatch.options)
        .then(
          (result) => this.#settleUnit(unit, () => unit.resolve(result)),
          (error) => this.#settleUnit(unit, () => unit.reject(error)),
        )
        .finally(() => {
          worker.busy = false;
          this.#pump();
        });
      return true;
    }
    if (this.#workers.length === 0 && !this.#mainBusy) {
      this.#mainBusy = true;
      const controller = new AbortController();
      this.#mainAbort = controller;
      this.#mainRun = unit;
      const signal = unit.options.signal;
      const context: Forge3DMessageContext = {
        signal: controller.signal,
        requestId: unit.id,
      };
      Promise.resolve()
        .then(() => this.#handler(unit.payload, context))
        .then(
          (result) => {
            if (signal?.aborted) {
              this.#settleUnit(unit, () =>
                unit.reject(
                  new Forge3DError(
                    "REQUEST_CANCELLED",
                    "Work was cancelled",
                  ),
                ),
              );
              return;
            }
            this.#settleUnit(unit, () => unit.resolve(result));
          },
          (error) => {
            const normalized = Forge3DError.from(error);
            this.#settleUnit(unit, () =>
              unit.reject(
                signal?.aborted && normalized.code !== "REQUEST_CANCELLED"
                  ? new Forge3DError(
                      "REQUEST_CANCELLED",
                      "Work was cancelled",
                    )
                  : normalized,
              ),
            );
          },
        )
        .finally(() => {
          this.#mainAbort = undefined;
          this.#mainRun = undefined;
          this.#mainBusy = false;
          this.#pump();
        });
      return true;
    }
    return false;
  }

  #workerDispatchOptions(unit: PoolRun): {
    payload: unknown;
    options: Forge3DMessageCallOptions;
  } {
    if (this.#mode !== "shared-array-buffer") {
      return { payload: unit.payload, options: unit.options };
    }
    const cloned = new Set<ArrayBuffer>();
    const payload = cloneIntoSharedBuffers(
      unit.payload,
      new WeakMap<object, unknown>(),
      cloned,
    );
    const options: Forge3DMessageCallOptions = {};
    if (unit.options.signal !== undefined) {
      options.signal = unit.options.signal;
    }
    const transfer = (unit.options.transfer ?? []).filter(
      (item) => !(item instanceof ArrayBuffer && cloned.has(item)),
    );
    if (transfer.length > 0) {
      options.transfer = transfer;
    }
    return { payload, options };
  }

  #pump(): void {
    if (this.#disposed) {
      return;
    }
    while (this.#queue.length > 0) {
      const unit = this.#queue[0]!;
      if (!this.#tryDispatch(unit)) {
        return;
      }
      this.#queue.shift();
    }
  }
}

function cloneIntoSharedBuffers(
  value: unknown,
  seen: WeakMap<object, unknown>,
  cloned: Set<ArrayBuffer>,
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof ArrayBuffer) {
    const shared = new SharedArrayBuffer(value.byteLength);
    new Uint8Array(shared).set(new Uint8Array(value));
    seen.set(value, shared);
    cloned.add(value);
    return shared;
  }
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    const shared = new SharedArrayBuffer(source.byteLength);
    new Uint8Array(shared).set(source);
    const view = new (value.constructor as new (
      buffer: SharedArrayBuffer,
    ) => ArrayBufferView)(shared);
    seen.set(value, view);
    if (value.buffer instanceof ArrayBuffer) {
      cloned.add(value.buffer);
    }
    return view;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = cloneIntoSharedBuffers(value[index], seen, cloned);
    }
    return copy;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(record)) {
    copy[key] = cloneIntoSharedBuffers(record[key], seen, cloned);
  }
  return copy;
}

export class PromiseFence {
  #completed = 0;
  readonly #waiters = new Map<
    number,
    Array<{ resolve: () => void; reject: (error: unknown) => void }>
  >();
  #disposed = false;

  get completed(): number {
    return this.#completed;
  }

  complete(fence: number): void {
    if (this.#disposed) {
      return;
    }
    if (fence > this.#completed) {
      this.#completed = fence;
    }
    for (const [target, waiters] of this.#waiters) {
      if (target <= this.#completed) {
        this.#waiters.delete(target);
        for (const waiter of waiters) {
          waiter.resolve();
        }
      }
    }
  }

  wait(fence: number): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        new Forge3DError("RUNTIME_DISPOSED", "Fence is disposed"),
      );
    }
    if (fence <= this.#completed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#waiters.get(fence) ?? [];
      waiters.push({ resolve, reject });
      this.#waiters.set(fence, waiters);
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const error = new Forge3DError("RUNTIME_DISPOSED", "Fence is disposed");
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }
}

interface RingState {
  head: number;
  submittedFence: number | undefined;
  inFlightBytes: number;
}

export interface StagingSlice {
  ringIndex: number;
  offset: number;
  size: number;
}

export interface StagingStats {
  bytesInFlight: number;
  stalls: number;
  ringCount: number;
  capacityPerRing: number;
}

export class BrowserStagingRing {
  readonly #rings: RingState[];
  readonly #capacityPerRing: number;
  #current = 0;
  #stalls = 0;
  #lastSubmittedFence: number | undefined;

  constructor(ringCount: number, capacityPerRing: number) {
    if (!Number.isSafeInteger(ringCount) || ringCount <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "ringCount must be a positive safe integer",
      );
    }
    if (!Number.isSafeInteger(capacityPerRing) || capacityPerRing <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "capacityPerRing must be a positive safe integer",
      );
    }
    this.#capacityPerRing = capacityPerRing;
    this.#rings = Array.from({ length: ringCount }, () => ({
      head: 0,
      submittedFence: undefined,
      inFlightBytes: 0,
    }));
  }

  allocate(
    size: number,
    alignment: number,
    completedFence: number,
  ): StagingSlice {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "size must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(alignment) ||
      alignment <= 0 ||
      (alignment & (alignment - 1)) !== 0
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "alignment must be a nonzero power of two",
      );
    }
    if (size > this.#capacityPerRing) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "allocation exceeds ring capacity",
      );
    }
    assertFenceValue("completedFence", completedFence);
    this.complete(completedFence);
    for (let probe = 0; probe < this.#rings.length; probe += 1) {
      const index = (this.#current + probe) % this.#rings.length;
      const ring = this.#rings[index]!;
      if (ring.submittedFence !== undefined) {
        continue;
      }
      const offset = alignUp(ring.head, alignment);
      const end = offset + size;
      if (!Number.isSafeInteger(end)) {
        throw new Forge3DError(
          "INVALID_INPUT",
          "staging offset overflowed",
        );
      }
      if (end <= this.#capacityPerRing) {
        ring.head = end;
        this.#current = index;
        return { ringIndex: index, offset, size };
      }
    }
    this.#stalls += 1;
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      "all staging rings are in flight or full",
    );
  }

  submitCurrent(fence: number): void {
    assertFenceValue("fence", fence);
    if (
      this.#lastSubmittedFence !== undefined &&
      fence <= this.#lastSubmittedFence
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "submitted fences must increase monotonically",
      );
    }
    const ring = this.#rings[this.#current]!;
    if (ring.submittedFence !== undefined) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "current ring is already submitted",
      );
    }
    ring.submittedFence = fence;
    ring.inFlightBytes = ring.head;
    this.#lastSubmittedFence = fence;
    this.#current = (this.#current + 1) % this.#rings.length;
  }

  complete(completedFence: number): void {
    assertFenceValue("completedFence", completedFence);
    for (const ring of this.#rings) {
      if (
        ring.submittedFence !== undefined &&
        ring.submittedFence <= completedFence
      ) {
        ring.submittedFence = undefined;
        ring.head = 0;
        ring.inFlightBytes = 0;
      }
    }
  }

  stats(): StagingStats {
    return {
      bytesInFlight: this.#rings
        .filter((ring) => ring.submittedFence !== undefined)
        .reduce((total, ring) => total + ring.inFlightBytes, 0),
      stalls: this.#stalls,
      ringCount: this.#rings.length,
      capacityPerRing: this.#capacityPerRing,
    };
  }
}

export class BoundedAsyncQueue<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  readonly #takeWaiters: Array<{
    resolve: (item: T) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }> = [];
  #disposed = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "capacity must be a positive safe integer",
      );
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  push(item: T): void {
    if (this.#disposed) {
      throw new Forge3DError("RUNTIME_DISPOSED", "Queue is disposed");
    }
    const waiter = this.#takeWaiters.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve(item);
      return;
    }
    if (this.#items.length >= this.#capacity) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "queue is full",
      );
    }
    this.#items.push(item);
  }

  take(options?: { signal?: AbortSignal }): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(
        new Forge3DError("RUNTIME_DISPOSED", "Queue is disposed"),
      );
    }
    const item = this.#items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new Forge3DError("REQUEST_CANCELLED", "Take was cancelled"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cleanup: () => {},
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#takeWaiters.indexOf(waiter);
          if (index >= 0) {
            this.#takeWaiters.splice(index, 1);
            signal.removeEventListener("abort", onAbort);
            reject(new Forge3DError("REQUEST_CANCELLED", "Take was cancelled"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#takeWaiters.push(waiter);
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#items.length = 0;
    const error = new Forge3DError("RUNTIME_DISPOSED", "Queue is disposed");
    for (const waiter of this.#takeWaiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}

interface TileCacheEntry {
  bytes: number;
  value: unknown;
}

export interface TileCacheStats {
  entryCount: number;
  bytesUsed: number;
  budgetBytes: number;
}

export class BrowserTileCache<T = unknown> {
  readonly #budgetBytes: number;
  readonly #entries = new Map<string, TileCacheEntry>();
  #bytesUsed = 0;

  constructor(budgetBytes: number) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "budgetBytes must be a positive safe integer",
      );
    }
    this.#budgetBytes = budgetBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value as T;
  }

  insert(key: string, value: T, bytes: number): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "key must be a nonempty string",
      );
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "bytes must be a nonnegative safe integer",
      );
    }
    if (bytes > this.#budgetBytes) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "entry exceeds the tile cache budget",
      );
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytesUsed -= existing.bytes;
      this.#entries.delete(key);
    }
    while (this.#bytesUsed + bytes > this.#budgetBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = this.#entries.get(oldest.value)!;
      this.#entries.delete(oldest.value);
      this.#bytesUsed -= evicted.bytes;
    }
    this.#entries.set(key, { bytes, value });
    this.#bytesUsed += bytes;
  }

  remove(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#entries.delete(key);
    this.#bytesUsed -= entry.bytes;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytesUsed = 0;
  }

  stats(): TileCacheStats {
    return {
      entryCount: this.#entries.size,
      bytesUsed: this.#bytesUsed,
      budgetBytes: this.#budgetBytes,
    };
  }
}

export interface TextureFormatInfo {
  bytesPerBlock: number;
  blockWidth: number;
  blockHeight: number;
  compressed: boolean;
}

const TEXTURE_FORMATS: Record<string, TextureFormatInfo> = {
  r8unorm: { bytesPerBlock: 1, blockWidth: 1, blockHeight: 1, compressed: false },
  rg8unorm: { bytesPerBlock: 2, blockWidth: 1, blockHeight: 1, compressed: false },
  rgba8unorm: { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  "rgba8unorm-srgb": { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  bgra8unorm: { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  "bgra8unorm-srgb": { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  r16float: { bytesPerBlock: 2, blockWidth: 1, blockHeight: 1, compressed: false },
  rg16float: { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  rgba16float: { bytesPerBlock: 8, blockWidth: 1, blockHeight: 1, compressed: false },
  r32float: { bytesPerBlock: 4, blockWidth: 1, blockHeight: 1, compressed: false },
  rg32float: { bytesPerBlock: 8, blockWidth: 1, blockHeight: 1, compressed: false },
  rgba32float: { bytesPerBlock: 16, blockWidth: 1, blockHeight: 1, compressed: false },
  "bc1-rgba-unorm": { bytesPerBlock: 8, blockWidth: 4, blockHeight: 4, compressed: true },
  "bc1-rgba-unorm-srgb": { bytesPerBlock: 8, blockWidth: 4, blockHeight: 4, compressed: true },
  "bc3-rgba-unorm": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
  "bc3-rgba-unorm-srgb": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
  "bc7-rgba-unorm": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
  "bc7-rgba-unorm-srgb": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
  "etc2-rgb8unorm": { bytesPerBlock: 8, blockWidth: 4, blockHeight: 4, compressed: true },
  "etc2-rgb8unorm-srgb": { bytesPerBlock: 8, blockWidth: 4, blockHeight: 4, compressed: true },
  "etc2-rgba8unorm": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
  "etc2-rgba8unorm-srgb": { bytesPerBlock: 16, blockWidth: 4, blockHeight: 4, compressed: true },
};

export function textureFormatInfo(
  format: string,
): TextureFormatInfo | undefined {
  const info = TEXTURE_FORMATS[format];
  return info === undefined ? undefined : { ...info };
}

export function mipLevelCount(width: number, height: number): number {
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
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export function textureByteSize(
  format: string,
  width: number,
  height: number,
  mipLevels: number,
): number {
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
  if (!Number.isSafeInteger(mipLevels) || mipLevels <= 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "mipLevels must be a positive safe integer",
    );
  }
  if (mipLevels > mipLevelCount(width, height)) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "mipLevels exceeds the mip chain length for the size",
    );
  }
  const info = TEXTURE_FORMATS[format];
  if (info === undefined) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `unsupported texture format ${format}`,
    );
  }
  let total = 0;
  for (let level = 0; level < mipLevels; level += 1) {
    const mipWidth = Math.max(1, Math.floor(width / 2 ** level));
    const mipHeight = Math.max(1, Math.floor(height / 2 ** level));
    const blocksWide = Math.ceil(mipWidth / info.blockWidth);
    const blocksHigh = Math.ceil(mipHeight / info.blockHeight);
    const mipBytes = blocksWide * blocksHigh * info.bytesPerBlock;
    total += mipBytes;
    if (!Number.isSafeInteger(total)) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "texture byte size overflowed",
      );
    }
  }
  return total;
}

export function selectTextureTranscodeFallback(
  supported: readonly string[],
  srgb: boolean,
): string | undefined {
  const suffix = srgb ? "-srgb" : "";
  const candidates = [
    `bc7-rgba-unorm${suffix}`,
    `etc2-rgba8unorm${suffix}`,
    `rgba8unorm${suffix}`,
  ];
  return candidates.find((candidate) => supported.includes(candidate));
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function assertFenceValue(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `${name} must be a nonnegative safe integer`,
    );
  }
}
