// W08/T09 priority HTTP range scheduler (F1).
//
// `RangeScheduler.request(source, offset, length, { priority, signal })`
// dedupes identical in-flight/queued ranges, coalesces queued ranges of the
// same URL within `coalesceGapBytes` into one HTTP Range request (in-flight
// requests are never merged), honours a `maxConcurrent` fetch budget and
// per-subscriber cancellation, and serves memory -> persistent -> network
// lookups with offline fallback to persistent bytes. Every 206 must carry a
// `Content-Range` matching the requested span; a known strong ETag is sent
// as `If-Match`, and a 412 (or a 200 to that conditional request) drops the
// stale validator and its cache entries before one retry.

import { Forge3DError } from "./index.js";
import type {
  MemoryByteCacheLike,
  PersistentByteCache,
  RangeSchedulerStats,
} from "./index.js";

export type RangeFetchLike = (
  input: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface RangeSchedulerOptions {
  fetch?: RangeFetchLike;
  maxConcurrent?: number;
  coalesceGapBytes?: number;
  maxCoalescedBytes?: number;
  memoryCache?: MemoryByteCacheLike;
  persistentCache?: PersistentByteCache;
}

interface Subscriber {
  /** The unit currently fetching this subscriber's bytes. Re-pointed to
   * the merged unit when its range is coalesced. */
  owner: RangeUnit;
  offset: number;
  length: number;
  signal: AbortSignal | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
}

interface RangeUnit {
  key: string;
  source: string | URL | Blob;
  sourceKey: string;
  offset: number;
  length: number;
  priority: number;
  sequence: number;
  subscribers: Subscriber[];
  state: "queued" | "in-flight";
  controller?: AbortController;
  /** Member units folded into a coalesced span; `undefined` for singles. */
  members?: RangeUnit[];
}

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_COALESCE_GAP = 16384;
const DEFAULT_MAX_COALESCED = 4 * 1024 * 1024;
const VALIDATOR_META_PREFIX = "forge3d:v:";
const RANGE_KEY_PREFIX = "forge3d:r:";

function invalid(field: string, message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", `Invalid ${field}: ${message}`);
}

function cancelledError(): Forge3DError {
  return new Forge3DError("REQUEST_CANCELLED", "Range request was cancelled");
}

function sourceKeyFor(source: string | URL | Blob): string {
  if (source instanceof URL) {
    return `url:${source.href}`;
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const lastModified =
      "lastModified" in source && typeof source.lastModified === "number"
        ? `:${source.lastModified}`
        : "";
    return `blob:${source.size}:${source.type}${lastModified}`;
  }
  return `url:${String(source)}`;
}

function rangeCacheKey(
  sourceKey: string,
  validator: string | undefined,
  offset: number,
  length: number,
): string {
  return `${RANGE_KEY_PREFIX}${sourceKey}|${validator ?? "none"}|${offset}:${length}`;
}

function validatorFromHeaders(headers: Headers): string | undefined {
  const etag = headers.get("etag");
  if (etag !== null && etag.length > 0) {
    return `etag:${etag}`;
  }
  const lastModified = headers.get("last-modified");
  if (lastModified !== null && lastModified.length > 0) {
    return `last-modified:${lastModified}`;
  }
  return undefined;
}

interface ContentRange {
  first: number;
  last: number;
  total: number | undefined;
}

function parseContentRange(raw: string | null): ContentRange | undefined {
  if (raw === null) {
    return undefined;
  }
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/iu.exec(raw);
  if (match === null) {
    return undefined;
  }
  const first = Number(match[1]);
  const last = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    last < first ||
    (total !== undefined && (!Number.isSafeInteger(total) || last >= total))
  ) {
    return undefined;
  }
  return { first, last, total };
}

/** Strong ETag usable in `If-Match` (weak ETags never match there). */
function strongEtag(validator: string | undefined): string | undefined {
  if (validator === undefined || !validator.startsWith("etag:")) {
    return undefined;
  }
  const etag = validator.slice("etag:".length);
  return etag.startsWith("W/") ? undefined : etag;
}

function contentRangeMismatch(
  unit: { offset: number; length: number },
  raw: string | null,
): Forge3DError {
  const expected = `bytes ${unit.offset}-${unit.offset + unit.length - 1}`;
  const got = raw === null ? "is missing" : `is '${raw}'`;
  return new Forge3DError(
    "IO_ERROR",
    `Range response Content-Range ${got}; expected ${expected}`,
    { reason: "content-range-mismatch", contentRange: raw },
  );
}

export class RangeScheduler {
  readonly #fetch: RangeFetchLike | undefined;
  readonly #maxConcurrent: number;
  readonly #coalesceGapBytes: number;
  readonly #maxCoalescedBytes: number;
  readonly #memoryCache: MemoryByteCacheLike | undefined;
  readonly #persistentCache: PersistentByteCache | undefined;
  readonly #queue: RangeUnit[] = [];
  readonly #inFlight = new Set<RangeUnit>();
  readonly #byKey = new Map<string, RangeUnit>();
  readonly #validators = new Map<string, string>();
  readonly #fileSizes = new Map<string, number>();
  /** Cache keys written per source, so a stale validator's entries can be
   * dropped. */
  readonly #writtenKeys = new Map<string, Set<string>>();
  #sequence = 0;
  #disposed = false;
  #requested = 0;
  #deduplicated = 0;
  #coalesced = 0;
  #httpRequests = 0;
  #bytesRequested = 0;
  #bytesTransferred = 0;
  #memoryHits = 0;
  #persistentHits = 0;
  #misses = 0;
  #cancelled = 0;
  #failed = 0;
  #peakInFlight = 0;
  #offlineServed = 0;

  constructor(options: RangeSchedulerOptions = {}) {
    this.#fetch = options.fetch;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#coalesceGapBytes =
      options.coalesceGapBytes ?? DEFAULT_COALESCE_GAP;
    this.#maxCoalescedBytes =
      options.maxCoalescedBytes ?? DEFAULT_MAX_COALESCED;
    this.#memoryCache = options.memoryCache;
    this.#persistentCache = options.persistentCache;
    for (const [field, value] of [
      ["maxConcurrent", this.#maxConcurrent],
      ["coalesceGapBytes", this.#coalesceGapBytes],
      ["maxCoalescedBytes", this.#maxCoalescedBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw invalid(field, "must be a positive safe integer");
      }
    }
  }

  async request(
    source: string | URL | Blob,
    offset: number,
    length: number,
    options: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    if (this.#disposed) {
      throw new Forge3DError(
        "RUNTIME_DISPOSED",
        "RangeScheduler is disposed",
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw invalid("offset", "must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw invalid("length", "must be a positive safe integer");
    }
    const signal = options.signal;
    if (signal?.aborted) {
      throw cancelledError();
    }
    this.#requested += 1;
    this.#bytesRequested += length;

    const sourceKey = sourceKeyFor(source);
    const validator = await this.#validatorFor(sourceKey);
    const cacheKey = rangeCacheKey(sourceKey, validator, offset, length);

    const memory = this.#memoryCache?.get(cacheKey);
    if (memory !== undefined) {
      this.#memoryHits += 1;
      return memory;
    }
    const persistent = await this.#persistentGet(cacheKey);
    if (persistent !== undefined) {
      this.#persistentHits += 1;
      this.#memoryCache?.put(cacheKey, persistent);
      return persistent;
    }
    this.#misses += 1;

    const unitKey = `${sourceKey}|${offset}:${length}`;
    if (signal?.aborted) {
      throw cancelledError();
    }
    const existing = this.#byKey.get(unitKey);
    if (existing !== undefined) {
      this.#deduplicated += 1;
      if (options.priority !== undefined && options.priority < existing.priority) {
        existing.priority = options.priority;
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        const subscriber: Subscriber = {
          owner: existing,
          offset,
          length,
          signal,
          resolve,
          reject,
        };
        existing.subscribers.push(subscriber);
        this.#watchSubscriber(subscriber);
      });
    }

    const unit: RangeUnit = {
      key: unitKey,
      source,
      sourceKey,
      offset,
      length,
      priority: options.priority ?? 0,
      sequence: this.#sequence,
      subscribers: [],
      state: "queued",
    };
    this.#sequence += 1;
    this.#byKey.set(unitKey, unit);
    this.#queue.push(unit);
    let subscriber!: Subscriber;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      subscriber = { owner: unit, offset, length, signal, resolve, reject };
      unit.subscribers.push(subscriber);
    });
    this.#watchSubscriber(subscriber);
    this.#pump();
    return promise;
  }

  stats(): RangeSchedulerStats {
    return {
      requested: this.#requested,
      deduplicated: this.#deduplicated,
      coalesced: this.#coalesced,
      httpRequests: this.#httpRequests,
      bytesRequested: this.#bytesRequested,
      bytesTransferred: this.#bytesTransferred,
      memoryHits: this.#memoryHits,
      persistentHits: this.#persistentHits,
      misses: this.#misses,
      cancelled: this.#cancelled,
      failed: this.#failed,
      inFlight: this.#inFlight.size,
      peakInFlight: this.#peakInFlight,
      queued: this.#queue.length,
      offlineServed: this.#offlineServed,
    };
  }

  /** File size learned from `Content-Range` totals, when known. */
  fileSize(source: string | URL | Blob): number | undefined {
    return this.#fileSizes.get(sourceKeyFor(source));
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const unit of this.#queue.splice(0)) {
      this.#failUnit(unit, cancelledError());
    }
    for (const unit of [...this.#inFlight]) {
      unit.controller?.abort();
      this.#failUnit(unit, cancelledError());
      this.#inFlight.delete(unit);
      this.#byKey.delete(unit.key);
    }
    this.#queue.length = 0;
  }

  #watchSubscriber(subscriber: Subscriber): void {
    const signal = subscriber.signal;
    if (signal === undefined) {
      return;
    }
    const onAbort = () => {
      // Read the owner at abort time: coalescing moves subscribers onto
      // the merged unit.
      const unit = subscriber.owner;
      const index = unit.subscribers.indexOf(subscriber);
      if (index < 0) {
        return;
      }
      unit.subscribers.splice(index, 1);
      this.#cancelled += 1;
      subscriber.reject(cancelledError());
      if (unit.subscribers.length === 0) {
        if (unit.state === "queued") {
          this.#dropQueued(unit);
        } else if (unit.state === "in-flight") {
          unit.controller?.abort();
        }
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  #dropQueued(unit: RangeUnit): void {
    const index = this.#queue.indexOf(unit);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
    this.#byKey.delete(unit.key);
  }

  async #validatorFor(sourceKey: string): Promise<string | undefined> {
    const known = this.#validators.get(sourceKey);
    if (known !== undefined) {
      return known;
    }
    const stored = await this.#persistentGet(
      `${VALIDATOR_META_PREFIX}${sourceKey}`,
    );
    if (stored !== undefined) {
      const validator = new TextDecoder().decode(stored);
      this.#validators.set(sourceKey, validator);
      return validator;
    }
    return undefined;
  }

  async #rememberValidator(
    sourceKey: string,
    headers: Headers,
    total: number | undefined,
  ): Promise<void> {
    if (total !== undefined) {
      this.#fileSizes.set(sourceKey, total);
    }
    const fromHeaders = validatorFromHeaders(headers);
    const validator =
      fromHeaders ??
      (total !== undefined ? `size:${total}` : undefined);
    if (validator === undefined) {
      return;
    }
    const previous = this.#validators.get(sourceKey);
    if (previous === validator) {
      return;
    }
    this.#validators.set(sourceKey, validator);
    try {
      await this.#persistentCache?.put(
        `${VALIDATOR_META_PREFIX}${sourceKey}`,
        new TextEncoder().encode(validator),
      );
    } catch {
      // Validator persistence is best-effort.
    }
  }

  /** Persistent reads are best-effort: a failing store is a miss. */
  async #persistentGet(key: string): Promise<Uint8Array | undefined> {
    try {
      return await this.#persistentCache?.get(key);
    } catch {
      return undefined;
    }
  }

  /**
   * Forget a validator the server no longer honours (412, or a 200 to an
   * `If-Match` request) together with every cache entry written under it.
   */
  async #dropValidator(sourceKey: string): Promise<void> {
    this.#validators.delete(sourceKey);
    this.#fileSizes.delete(sourceKey);
    const keys = [
      `${VALIDATOR_META_PREFIX}${sourceKey}`,
      ...(this.#writtenKeys.get(sourceKey) ?? []),
    ];
    this.#writtenKeys.delete(sourceKey);
    for (const key of keys) {
      this.#memoryCache?.delete?.(key);
      try {
        await this.#persistentCache?.delete(key);
      } catch {
        // Deletion is best-effort; the validator is part of the key.
      }
    }
  }

  #pump(): void {
    if (this.#disposed) {
      return;
    }
    while (
      this.#inFlight.size < this.#maxConcurrent &&
      this.#queue.length > 0
    ) {
      const merged = this.#takeNextUnit();
      if (merged === undefined) {
        return;
      }
      merged.state = "in-flight";
      merged.controller = new AbortController();
      this.#inFlight.add(merged);
      this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight.size);
      void this.#dispatch(merged).catch((error: unknown) => {
        // Last resort: #dispatch handles its own failures, but a throw
        // here must never leak the concurrency slot.
        if (this.#inFlight.has(merged)) {
          this.#failed += 1;
          this.#failUnit(merged, Forge3DError.from(error));
        }
      });
    }
  }

  /**
   * Dequeue the highest-priority queued unit and merge any queued unit on
   * the same source whose range extends the span within the coalesce gap
   * and total size limits. Returns a synthetic unit covering the merged
   * span; member units are removed from the queue and their subscribers
   * transferred.
   */
  #takeNextUnit(): RangeUnit | undefined {
    this.#queue.sort(
      (a, b) => a.priority - b.priority || a.sequence - b.sequence,
    );
    const anchor = this.#queue.shift();
    if (anchor === undefined) {
      return undefined;
    }
    if (
      typeof Blob !== "undefined" &&
      anchor.source instanceof Blob
    ) {
      return anchor;
    }
    let spanOffset = anchor.offset;
    let spanEnd = anchor.offset + anchor.length;
    const members: RangeUnit[] = [anchor];
    let index = 0;
    while (index < this.#queue.length) {
      const candidate = this.#queue[index]!;
      const candidateEnd = candidate.offset + candidate.length;
      // Both sides of the gap test: ranges queued in reverse order must be
      // within the gap of the span start, not just before its end.
      if (
        candidate.sourceKey === anchor.sourceKey &&
        !(candidate.source instanceof Blob) &&
        candidate.offset <= spanEnd + this.#coalesceGapBytes &&
        candidateEnd >= spanOffset - this.#coalesceGapBytes &&
        Math.max(spanEnd, candidateEnd) -
          Math.min(spanOffset, candidate.offset) <=
          this.#maxCoalescedBytes
      ) {
        spanEnd = Math.max(spanEnd, candidateEnd);
        spanOffset = Math.min(spanOffset, candidate.offset);
        members.push(candidate);
        this.#queue.splice(index, 1);
        continue;
      }
      index += 1;
    }
    if (members.length === 1) {
      return anchor;
    }
    this.#coalesced += members.length - 1;
    const merged: RangeUnit = {
      key: `merged:${anchor.key}`,
      source: anchor.source,
      sourceKey: anchor.sourceKey,
      offset: spanOffset,
      length: spanEnd - spanOffset,
      priority: anchor.priority,
      sequence: anchor.sequence,
      subscribers: [],
      state: "in-flight",
      members,
    };
    for (const member of members) {
      member.state = "in-flight";
      // Keep member keys registered so identical ranges dedupe onto the
      // in-flight merged unit.
      this.#byKey.set(member.key, merged);
      for (const subscriber of member.subscribers.splice(0)) {
        subscriber.owner = merged;
        merged.subscribers.push(subscriber);
      }
    }
    return merged;
  }

  async #dispatch(unit: RangeUnit): Promise<void> {
    try {
      if (typeof Blob !== "undefined" && unit.source instanceof Blob) {
        const blob = unit.source.slice(
          unit.offset,
          unit.offset + unit.length,
        );
        const buffer = await blob.arrayBuffer();
        if (unit.subscribers.length === 0) {
          this.#finishAbortedUnit(unit);
          return;
        }
        this.#bytesTransferred += buffer.byteLength;
        await this.#resolveUnit(unit, new Uint8Array(buffer));
        return;
      }
      const fetchImpl = this.#fetch ?? globalThis.fetch;
      if (fetchImpl === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "fetch is unavailable for range requests",
        );
      }
      const url =
        unit.source instanceof URL ? unit.source.href : String(unit.source);
      const requestedLast = unit.offset + unit.length - 1;
      let retried = false;
      let response: Response;
      for (;;) {
        const ifMatch = strongEtag(this.#validators.get(unit.sourceKey));
        const headers: Record<string, string> = {
          Range: `bytes=${unit.offset}-${requestedLast}`,
        };
        if (ifMatch !== undefined) {
          headers["If-Match"] = ifMatch;
        }
        this.#httpRequests += 1;
        response = await fetchImpl(url, {
          headers,
          signal: unit.controller!.signal,
        });
        const staleValidator =
          ifMatch !== undefined &&
          (response.status === 412 || response.status === 200);
        if (!staleValidator || retried) {
          break;
        }
        // The resource changed under the known ETag: drop it and every
        // cache entry keyed by it, then retry once unconditionally.
        retried = true;
        this.#cancelBody(response);
        await this.#dropValidator(unit.sourceKey);
        if (unit.subscribers.length === 0) {
          this.#finishAbortedUnit(unit);
          return;
        }
      }
      if (response.status === 200) {
        this.#rejectResponse(
          unit,
          response,
          new Forge3DError(
            "IO_ERROR",
            "Server ignored the Range request (200 instead of 206). COG streaming requires 'Accept-Ranges: bytes' on the response and 'Access-Control-Expose-Headers: Content-Range, Content-Length, ETag' for cross-origin reads",
            { reason: "range-not-supported" },
          ),
        );
        return;
      }
      if (response.status === 416) {
        this.#rejectResponse(
          unit,
          response,
          new Forge3DError(
            "IO_ERROR",
            `Range ${unit.offset}-${requestedLast} is not satisfiable`,
            { reason: "range-not-satisfiable", status: 416 },
          ),
        );
        return;
      }
      if (response.status !== 206) {
        this.#rejectResponse(
          unit,
          response,
          new Forge3DError(
            "IO_ERROR",
            `HTTP range request failed with status ${response.status}`,
            { status: response.status },
          ),
        );
        return;
      }
      const rawContentRange = response.headers.get("content-range");
      const contentRange = parseContentRange(rawContentRange);
      // The served range must start at the requested offset and end at the
      // requested end, or stop short only at end of file.
      if (
        contentRange === undefined ||
        contentRange.first !== unit.offset ||
        (contentRange.last !== requestedLast &&
          !(
            contentRange.last < requestedLast &&
            contentRange.total !== undefined &&
            contentRange.last === contentRange.total - 1
          ))
      ) {
        this.#rejectResponse(
          unit,
          response,
          contentRangeMismatch(unit, rawContentRange),
        );
        return;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      const expected = contentRange.last - contentRange.first + 1;
      if (buffer.byteLength !== expected) {
        this.#rejectResponse(
          unit,
          response,
          new Forge3DError(
            "IO_ERROR",
            `Range response returned ${buffer.byteLength} bytes, expected ${expected}`,
            { expected, received: buffer.byteLength },
          ),
        );
        return;
      }
      this.#bytesTransferred += buffer.byteLength;
      await this.#rememberValidator(
        unit.sourceKey,
        response.headers,
        contentRange.total,
      );
      await this.#resolveUnit(unit, buffer);
    } catch (error) {
      if (unit.controller?.signal.aborted || unit.subscribers.length === 0) {
        this.#finishAbortedUnit(unit);
        return;
      }
      const normalized = Forge3DError.from(error);
      this.#failed += 1;
      let served = false;
      try {
        served = await this.#serveOffline(unit);
      } catch {
        served = false;
      }
      if (!served && this.#inFlight.has(unit)) {
        this.#failUnit(unit, normalized);
      }
    }
  }

  /** Count and reject a response whose body will not be consumed. */
  #rejectResponse(
    unit: RangeUnit,
    response: Response,
    error: Forge3DError,
  ): void {
    this.#abortUnitFetch(unit, response);
    this.#failed += 1;
    this.#failUnit(unit, error);
  }

  #cancelBody(response: Response): void {
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      // Body cancellation is best-effort.
    }
  }

  /**
   * Stop the underlying transfer for a response whose body will not be
   * consumed (range-ignored 200, error statuses, short reads). Aborting the
   * unit's controller cancels the fetch; cancelling the body stream covers
   * transports that do not observe the signal.
   */
  #abortUnitFetch(unit: RangeUnit, response: Response): void {
    unit.controller?.abort();
    this.#cancelBody(response);
  }

  /**
   * Offline fallback: serve every subscriber from bytes stored under the
   * current validator (by a previous session, or by another tab sharing
   * the persistent cache). All-or-nothing; a throwing store is a miss.
   */
  async #serveOffline(unit: RangeUnit): Promise<boolean> {
    if (this.#persistentCache === undefined) {
      return false;
    }
    const validator = this.#validators.get(unit.sourceKey);
    const found = new Map<Subscriber, Uint8Array>();
    for (const subscriber of [...unit.subscribers]) {
      const cached = await this.#persistentGet(
        rangeCacheKey(
          unit.sourceKey,
          validator,
          subscriber.offset,
          subscriber.length,
        ),
      );
      if (cached === undefined) {
        return false;
      }
      found.set(subscriber, cached);
    }
    if (found.size === 0) {
      return false;
    }
    this.#offlineServed += 1;
    this.#persistentHits += 1;
    for (const subscriber of unit.subscribers.splice(0)) {
      const bytes = found.get(subscriber);
      if (bytes === undefined) {
        // Deduplicated onto the unit after the lookup finished.
        this.#failed += 1;
        subscriber.reject(
          new Forge3DError("IO_ERROR", "Range request failed while offline"),
        );
        continue;
      }
      subscriber.resolve(bytes);
    }
    this.#releaseUnit(unit);
    return true;
  }

  async #resolveUnit(
    unit: RangeUnit,
    data: Uint8Array,
    options: { skipCacheWrites?: boolean } = {},
  ): Promise<void> {
    const validator = this.#validators.get(unit.sourceKey);
    for (const subscriber of unit.subscribers.splice(0)) {
      const subStart = subscriber.offset - unit.offset;
      const end = Math.min(subStart + subscriber.length, data.byteLength);
      const slice = data.slice(Math.max(0, subStart), Math.max(0, end));
      if (options.skipCacheWrites !== true) {
        const key = rangeCacheKey(
          unit.sourceKey,
          validator,
          subscriber.offset,
          subscriber.length,
        );
        this.#memoryCache?.put(key, slice);
        let written = this.#writtenKeys.get(unit.sourceKey);
        if (written === undefined) {
          written = new Set();
          this.#writtenKeys.set(unit.sourceKey, written);
        }
        written.add(key);
        try {
          await this.#persistentCache?.put(key, slice);
        } catch {
          // Persistent writes are best-effort.
        }
      }
      subscriber.resolve(slice);
    }
    this.#releaseUnit(unit);
  }

  #releaseUnit(unit: RangeUnit): void {
    for (const member of unit.members ?? []) {
      this.#byKey.delete(member.key);
    }
    this.#inFlight.delete(unit);
    this.#byKey.delete(unit.key);
    this.#pump();
  }

  #failUnit(unit: RangeUnit, error: Forge3DError): void {
    for (const subscriber of unit.subscribers.splice(0)) {
      subscriber.reject(error);
    }
    for (const member of unit.members ?? []) {
      this.#byKey.delete(member.key);
    }
    this.#inFlight.delete(unit);
    this.#byKey.delete(unit.key);
    this.#dropQueued(unit);
    this.#pump();
  }

  #finishAbortedUnit(unit: RangeUnit): void {
    unit.subscribers.splice(0);
    for (const member of unit.members ?? []) {
      this.#byKey.delete(member.key);
    }
    this.#inFlight.delete(unit);
    this.#byKey.delete(unit.key);
    this.#pump();
  }
}
