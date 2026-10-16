import { type BrowserByteSink } from './index.js';
/** Abortable output with stream backpressure and staged filesystem writes. */
export declare function writeBundleOutput(bytes: Uint8Array, sink: BrowserByteSink, signal?: AbortSignal): Promise<void>;
