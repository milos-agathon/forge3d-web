import { codecFailure } from './codec-dispatch.js';
import type { CodecDescriptor, CodecFormat, CodecParameters } from './codec-types.js';

export const CODEC_CACHE_PREFIX = 'forge3d-codec-v1/';
const MAX_HEADER_BYTES = 4096;
export interface CodecCacheHeader {
  schema: 1;
  format: CodecFormat;
  revision: string;
  parameters: CodecParameters;
}
export async function codecDigest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw codecFailure('UNSUPPORTED_FEATURE', 'sha256-unavailable', 'Codec cache keys require secure-context WebCrypto SHA-256');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), n => n.toString(16).padStart(2, '0')).join('');
}
export function packCodecArtifact(codec: CodecDescriptor, parameters: CodecParameters, bytes: Uint8Array): Uint8Array {
  const header: CodecCacheHeader = { schema: 1, format: codec.format, revision: codec.revision, parameters };
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.length > MAX_HEADER_BYTES) throw codecFailure('INVALID_INPUT', 'invalid-cache-header', 'Codec cache header is too large');
  const result = new Uint8Array(4 + json.length + bytes.length);
  new DataView(result.buffer).setUint32(0, json.length, true);
  result.set(json, 4); result.set(bytes, 4 + json.length);
  return result;
}
export async function unpackCodecArtifact(key: string, artifact: Uint8Array, maxInputBytes: number): Promise<{ header: CodecCacheHeader; bytes: Uint8Array }> {
  const corrupt = () => codecFailure('IO_ERROR', 'cache-corrupt', 'Codec cache artifact failed integrity or framing validation');
  if (!(artifact instanceof Uint8Array) || artifact.length < 5 || artifact.length > maxInputBytes + MAX_HEADER_BYTES + 4) throw corrupt();
  if (key !== CODEC_CACHE_PREFIX + await codecDigest(artifact)) throw corrupt();
  const size = new DataView(artifact.buffer, artifact.byteOffset, artifact.byteLength).getUint32(0, true);
  if (size > MAX_HEADER_BYTES || size > artifact.length - 4) throw corrupt();
  let header: CodecCacheHeader;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.subarray(4, 4 + size))); }
  catch { throw corrupt(); }
  if (!header || header.schema !== 1 || typeof header.format !== 'string' || typeof header.revision !== 'string' || !header.parameters || typeof header.parameters !== 'object') throw corrupt();
  const bytes = artifact.slice(4 + size);
  if (bytes.length > maxInputBytes) throw codecFailure('RESOURCE_LIMIT_EXCEEDED', 'input-byte-limit', 'Cached codec input exceeds this registry limit');
  return { header, bytes };
}
