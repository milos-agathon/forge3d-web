import { codecFailure } from './codec-dispatch.js';

/** Owns admitted work until it drains, independently of caller settlement. */
export class CodecOperations {
  readonly #jobs = new Map<AbortController, Promise<unknown>>();
  #bytes = 0;
  #peak = 0;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  constructor(readonly budget: number, readonly concurrency: number, readonly onDrained: () => void) {}
  stats() { return { disposed: this.#disposed, activeOperations: this.#jobs.size,
    workingBytes: this.#bytes, peakWorkingBytes: this.#peak, workingBudgetBytes: this.budget }; }
  assertLive(): void { if (this.#disposed) throw codecFailure('RUNTIME_DISPOSED', 'registry-disposed', 'Codec registry is disposed'); }
  check(signal: AbortSignal): void {
    this.assertLive();
    if (signal.aborted) throw codecFailure('REQUEST_CANCELLED', 'aborted', 'Codec operation was cancelled');
  }
  run<T>(external: AbortSignal | undefined, work: (signal: AbortSignal, reserve: (bytes: number) => void) => Promise<T>): Promise<T> {
    try { this.assertLive(); } catch (error) { return Promise.reject(error); }
    if (this.#jobs.size >= this.concurrency) return Promise.reject(codecFailure('RESOURCE_LIMIT_EXCEEDED', 'codec-backpressure', 'Codec operation limit reached'));
    const controller = new AbortController();
    let reserved = 0;
    let rejectCaller: (error: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCaller = reject; });
    const abort = () => {
      controller.abort();
      rejectCaller(codecFailure('REQUEST_CANCELLED', 'aborted', 'Codec operation was cancelled; owned work is draining'));
    };
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    const reserve = (bytes: number) => {
      this.check(controller.signal);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.budget - this.#bytes)
        throw codecFailure('RESOURCE_LIMIT_EXCEEDED', 'working-byte-limit', 'Codec transient allocation budget exceeded');
      reserved += bytes; this.#bytes += bytes; this.#peak = Math.max(this.#peak, this.#bytes);
    };
    const owned = Promise.resolve().then(() => {
      this.check(controller.signal); return work(controller.signal, reserve);
    }).then(value => { this.check(controller.signal); return value; }, error => {
      this.check(controller.signal); throw error;
    }).finally(() => {
      external?.removeEventListener('abort', abort);
      this.#bytes -= reserved; this.#jobs.delete(controller);
    });
    this.#jobs.set(controller, owned);
    return Promise.race([owned, cancelled]);
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    for (const controller of this.#jobs.keys()) controller.abort();
    return this.#disposal = Promise.allSettled([...this.#jobs.values()]).then(() => { this.onDrained(); });
  }
}
