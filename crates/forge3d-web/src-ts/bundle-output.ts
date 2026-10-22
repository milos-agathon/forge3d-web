import { type BrowserByteSink } from "./index.js";
import { Forge3DError } from "./runtime-failure.js";
import { writeByteSink } from './browser-io.js';
import { bundleCancelled, bundlePath } from './bundle-archive.js';
/** Abortable output with stream backpressure and staged filesystem writes. */
export async function writeBundleOutput(bytes: Uint8Array, sink: BrowserByteSink, signal?: AbortSignal): Promise<void> {
    const filename = (name: string) => { const leaf = name.split(/[\\/]/).at(-1)!; return leaf.lastIndexOf('.') > 0 && !leaf.endsWith('.') ? name : name + '.forge3d'; };
    // Bundle-specific names mirror native suffix inference. W02 generic sinks
    // and explicit OPFS paths keep their existing byte-output contract.
    if (sink.kind === 'download') sink = { ...sink, filename: filename(sink.filename) };
    if (sink.kind === 'file-system' && !sink.handle && sink.suggestedName) sink = { ...sink, suggestedName: filename(sink.suggestedName) };
    try { await writeOutput(bytes, sink, signal); } catch (e) {
        bundleCancelled(signal);
        if (e instanceof Forge3DError) throw e;
        if (e instanceof DOMException && e.name === 'QuotaExceededError') throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle storage quota exceeded', { reason: 'quota-exceeded' });
        throw new Forge3DError('IO_ERROR', `Bundle output failed: ${String(e)}`);
    }
}
async function writeOutput(bytes: Uint8Array, sink: BrowserByteSink, signal?: AbortSignal): Promise<void> {
    bundleCancelled(signal);
    if (sink.kind === 'blob' || sink.kind === 'download' || sink.kind === 'file-system' && !sink.handle) { await writeByteSink(bytes.slice().buffer, sink); bundleCancelled(signal); return; }
    let handle: FileSystemFileHandle | undefined;
    if (sink.kind === 'opfs') {
        bundlePath(sink.path);
        if (typeof globalThis.navigator?.storage?.getDirectory !== 'function') throw new Forge3DError('UNSUPPORTED_FEATURE', 'OPFS is unavailable');
        let directory = await navigator.storage.getDirectory();
        const parts = sink.path.split('/'); for (const name of parts.slice(0, -1)) { bundleCancelled(signal); directory = await directory.getDirectoryHandle(name, { create: true }); }
        handle = await directory.getFileHandle(parts.at(-1)!, { create: true });
    } else if (sink.kind === 'file-system') handle = sink.handle;
    bundleCancelled(signal);
    const writer = sink.kind === 'stream' ? sink.stream.getWriter() : await handle!.createWritable();
    let reject!: (error: unknown) => void;
    const aborted = new Promise<never>((_, r) => { reject = r; });
    const error = () => new Forge3DError('REQUEST_CANCELLED', 'Bundle output cancelled');
    const abort = () => { void writer.abort(error()).catch(() => undefined); reject(error()); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        bundleCancelled(signal);
        for (let i = 0; i < bytes.length; i += 64 * 1024) { bundleCancelled(signal); await Promise.race([writer.write(bytes.slice(i, i + 64 * 1024)), aborted]); }
        bundleCancelled(signal); await Promise.race([writer.close(), aborted]);
    } catch (e) { const cleanup = writer.abort(e).catch(() => undefined); if (sink.kind !== 'stream') await cleanup; throw e; }
    finally { signal?.removeEventListener('abort', abort); if ('releaseLock' in writer) writer.releaseLock(); }
}
