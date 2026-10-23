import { accumulateRecord, decodeTraceRecords } from './trace-cpu.js';
/** Float32 accumulation is advanced independently from owned output snapshots. */
export class TraceAccumulation {
  #records: Float32Array;
  #samples = 0;
  constructor(readonly width: number, readonly height: number) { this.#records = new Float32Array(width * height * 28); }
  get records(): Float32Array { return this.#records; }
  get samples(): number { return this.#samples; }
  add(record: Float32Array, pixel: number): void { accumulateRecord(this.#records, record, pixel, this.#samples); }
  acceptGpu(records: Float32Array): void { this.#records = records; }
  complete(): void { this.#samples++; }
  reset(): void { this.#records.fill(0); this.#samples = 0; }
  restore(records: Float32Array, samples: number): void { this.#records = records.slice(); this.#samples = samples; }
  dispose(): void { this.#records = new Float32Array(0); this.#samples = 0; }
  resolveUpdate(completed: number, total: number, cadence: number) {
    if (completed % cadence !== 0 && completed !== total) return undefined;
    return decodeTraceRecords(this.#records, this.width, this.height, this.#samples);
  }
}
