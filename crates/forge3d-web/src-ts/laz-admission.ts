import { Forge3DError } from "./index.js";
import { pointCancelled, pointInteger } from "./pointcloud-common.js";

// One native heap can grow to the codec's 2 GiB ceiling. Bound native work
// across direct calls and dataset pools in this JavaScript realm before dispatch.
export const LAZ_MAX_ACTIVE_JOBS = 1;
export const LAZ_MAX_QUEUED_JOBS = 16;
export const LAZ_MAX_ADMITTED_BYTES = 512 * 1024 * 1024;
export const LAZ_DEFAULT_TIMEOUT_MS = 30_000;
interface AdmissionOptions { signal?: AbortSignal; timeoutMs?: number }
interface Job {
  start(): void;
  cancel(error: Forge3DError): void;
}
interface AdmissionState { queue: Job[]; active: number; admittedBytes: number }
// Duplicate package graphs (including source and dist) must share the same
// ceiling. Each worker has a separate global object and therefore its own realm.
const registryKey = Symbol.for("@forge3d/web/laz-admission/v1"),
  registry = globalThis as unknown as Record<symbol, AdmissionState | undefined>,
  state = registry[registryKey] ??= { queue: [], active: 0, admittedBytes: 0 },
  queue = state.queue;
function pump(): void {
  while (state.active < LAZ_MAX_ACTIVE_JOBS && queue.length) queue.shift()!.start();
}
function deadline(timeoutMs: number): Forge3DError {
  return new Forge3DError("RESOURCE_LIMIT_EXCEEDED", "LAZ decode deadline exceeded",
    { reason: "worker-deadline-exceeded", timeoutMs });
}
/** Caller/worker/native input copies, raw records and worker/caller point copies.
 * Codec module memory and opaque native allocations retain their separate 2 GiB ceiling.
 */
export function lazAdmissionBytes(
  inputBytes: number, recordLength: number, count: number, inputBackingBytes = inputBytes,
): number {
  // Structured clone retains/clones the entire backing buffer of a subview;
  // native allocation copies only the view's bytes.
  return inputBackingBytes * 2 + inputBytes + recordLength + 64 + count * (recordLength + 60);
}
/** Deadline starts before admission; cancelling a waiter never creates a worker. */
export function withLazAdmission<T>(
  bytes: number, options: AdmissionOptions,
  run: (signal: AbortSignal, remainingMs: number) => Promise<T>,
): Promise<T> {
  try {
    pointCancelled(options.signal);
    pointInteger(bytes, "LAZ admission bytes");
    const timeoutMs = options.timeoutMs ?? LAZ_DEFAULT_TIMEOUT_MS;
    pointInteger(timeoutMs, "LAZ timeoutMs", 1, 2 ** 31 - 1);
    if (queue.length >= LAZ_MAX_QUEUED_JOBS || state.admittedBytes + bytes > LAZ_MAX_ADMITTED_BYTES)
      throw new Forge3DError("RESOURCE_LIMIT_EXCEEDED", "LAZ decode admission limit exceeded",
        { reason: "laz-admission-limit", queued: queue.length,
          maxQueued: LAZ_MAX_QUEUED_JOBS, bytes, admittedBytes: state.admittedBytes, maxBytes: LAZ_MAX_ADMITTED_BYTES });
    state.admittedBytes += bytes;
    const expires = performance.now() + timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false, finished = false, cancelled: Forge3DError | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        state.admittedBytes -= bytes;
      };
      const job: Job = {
        start: () => {
          const remaining = Math.ceil(expires - performance.now());
          if (remaining <= 0) { job.cancel(deadline(timeoutMs)); return; }
          started = true; state.active++;
          // Keep the permit until the worker's hard-stop has finished. Rejecting
          // a race early could admit a new native heap while the old job runs.
          Promise.resolve().then(() => {
            pointCancelled(controller.signal);
            return run(controller.signal, remaining);
          }).then(
            (result) => cancelled ? reject(cancelled) : resolve(result),
            (error: unknown) => reject(cancelled ?? error),
          ).finally(() => {
            finished = true; state.active--; cleanup(); pump();
          });
        },
        cancel: (error) => {
          if (finished || cancelled) return;
          cancelled = error;
          if (started) controller.abort();
          else {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            finished = true; cleanup(); reject(error); pump();
          }
        },
      };
      const abort = () => job.cancel(new Forge3DError("REQUEST_CANCELLED", "LAZ decode cancelled"));
      const timer = setTimeout(() => job.cancel(deadline(timeoutMs)), timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      queue.push(job); pump();
    });
  } catch (error) { return Promise.reject(error); }
}
