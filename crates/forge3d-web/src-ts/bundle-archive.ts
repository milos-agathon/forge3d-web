import { Unzip, UnzipInflate, zipSync, type Zippable } from 'fflate';
import { Forge3DError } from "./runtime-failure.js";
export interface BundleLimits { maxBytes?: number; maxExpandedBytes?: number; maxEntries?: number; }
export function bundleLimits(input: BundleLimits = {}) {
    const result = { maxBytes: input.maxBytes ?? 128 * 1024 * 1024, maxExpandedBytes: input.maxExpandedBytes ?? 256 * 1024 * 1024, maxEntries: input.maxEntries ?? 4096 };
    for (const n of Object.values(result)) if (!Number.isSafeInteger(n) || n < 1) throw new Forge3DError('INVALID_INPUT', 'Invalid bundle limits');
    return result;
}
export function bundlePath(path: string): string {
    if (!path || path.length > 1024 || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Forge3DError('IO_ERROR', 'Unsafe bundle path', { reason: 'unsafe-bundle-path', path });
    return path;
}
export function bundleFailure(message: string, reason = 'invalid-bundle'): never { throw new Forge3DError('IO_ERROR', message, { reason }); }
function zipPath(path: string): string { return path.endsWith('/') ? bundlePath(path.slice(0, -1)) + '/' : bundlePath(path); }
export function bundleCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Forge3DError('REQUEST_CANCELLED', 'Bundle operation cancelled'); }
export async function bundleHash(data: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data).buffer)), n => n.toString(16).padStart(2, '0')).join(''); }
/** Reject ZIP64, duplicate names, oversized central declarations and malformed/trailing data before inflate. */
export function decodeBundleArchive(bytes: Uint8Array, input: BundleLimits = {}, signal?: AbortSignal): Record<string, Uint8Array> {
    const limits = bundleLimits(input); bundleCancelled(signal);
    if (bytes.byteLength > limits.maxBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds compressed byte limit');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    if (end < 0) bundleFailure('ZIP end record missing');
    const count = dv.getUint16(end + 10, true), size = dv.getUint32(end + 12, true), offset = dv.getUint32(end + 16, true);
    if (dv.getUint16(end + 4, true) || dv.getUint16(end + 6, true) || count !== dv.getUint16(end + 8, true) || count === 65535 || offset + size !== end) bundleFailure('Unsupported or malformed ZIP directory');
    if (count > limits.maxEntries) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds entry limit');
    let cursor = offset, total = 0; const declared = new Map<string, number>();
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || dv.getUint32(cursor, true) !== 0x02014b50) bundleFailure('Malformed ZIP entry');
        const flags = dv.getUint16(cursor + 8, true), method = dv.getUint16(cursor + 10, true), expanded = dv.getUint32(cursor + 24, true), compressed = dv.getUint32(cursor + 20, true), n = dv.getUint16(cursor + 28, true), extra = dv.getUint16(cursor + 30, true), comment = dv.getUint16(cursor + 32, true), local = dv.getUint32(cursor + 42, true);
        if (cursor + 46 + n + extra + comment > end || flags & 1 || ![0, 8].includes(method) || expanded === 0xffffffff || compressed === 0xffffffff || local + 30 > offset) bundleFailure('Unsupported ZIP entry');
        const name = zipPath(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + n)));
        if (name.endsWith('/') && expanded !== 0) bundleFailure('ZIP directory contains payload data');
        if (declared.has(name)) bundleFailure('Duplicate ZIP entry', 'duplicate-bundle-entry');
        if (dv.getUint32(local, true) !== 0x04034b50 || dv.getUint16(local + 8, true) !== method) bundleFailure('ZIP local header mismatch');
        const localName = dv.getUint16(local + 26, true), localExtra = dv.getUint16(local + 28, true);
        if (local + 30 + localName + localExtra + compressed > offset || new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(local + 30, local + 30 + localName)) !== name) bundleFailure('ZIP local payload mismatch');
        total += expanded;
        if (total > limits.maxExpandedBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds expanded byte limit');
        declared.set(name, expanded); cursor += 46 + n + extra + comment;
    }
    if (cursor !== end) bundleFailure('ZIP directory size mismatch');
    const files: Record<string, Uint8Array> = Object.create(null), discovered = new Set<string>(); let produced = 0;
    const unzip = new Unzip(file => {
        const name = zipPath(file.name);
        if (!declared.has(name) || discovered.has(name)) bundleFailure('Undeclared or duplicate local entry');
        discovered.add(name); const chunks: Uint8Array[] = []; let length = 0;
        file.ondata = (error, chunk, final) => {
            if (error) bundleFailure(error.message);
            bundleCancelled(signal); length += chunk.byteLength; produced += chunk.byteLength;
            if (produced > limits.maxExpandedBytes || length > declared.get(name)!) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Inflated bundle exceeds declared bounds');
            chunks.push(chunk);
            if (final) { if (length !== declared.get(name)) bundleFailure('ZIP expanded size mismatch'); if (name.endsWith('/')) return; const data = new Uint8Array(length); let pos = 0; for (const c of chunks) { data.set(c, pos); pos += c.length; } files[name] = data; }
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    try { for (let i = 0; i < bytes.length; i += 16384) { bundleCancelled(signal); unzip.push(bytes.subarray(i, i + 16384), i + 16384 >= bytes.length); } }
    catch (e) { if (e instanceof Forge3DError) throw e; bundleFailure(String(e)); }
    if (Object.keys(files).length !== [...declared.keys()].filter(p => !p.endsWith('/')).length || discovered.size !== declared.size) bundleFailure('ZIP archive truncated');
    return files;
}
export function encodeBundleArchive(files: Record<string, Uint8Array>, input: BundleLimits = {}): Uint8Array {
    const limits = bundleLimits(input), entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > limits.maxEntries || entries.reduce((n, [, b]) => n + b.length, 0) > limits.maxExpandedBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds allocation limits');
    const data: Zippable = Object.fromEntries(entries.map(([path, bytes]) => [bundlePath(path), [bytes, { level: 0 as const, mtime: new Date('2000-01-01T00:00:00Z') }]]));
    const archive = zipSync(data);
    if (archive.byteLength > limits.maxBytes) throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED', 'Bundle exceeds compressed byte limit');
    return archive;
}
