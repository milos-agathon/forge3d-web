import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../../docs/parity/dependency-lock.json', root), 'utf8'));
const definitions = [
  ['tiff', 'geotiff', 'W08', ['geotiff'], ['src-ts/cog.ts']],
  ['laz', 'laz-perf', 'W16', ['laz-perf'], ['src-ts/laz-decoder.ts', 'src-ts/laz-decoder-local.ts']],
  ['ktx2', 'ktx2-basis', 'W04', ['ktx-parse', 'basis-universal'], ['src-ts/textures.ts']],
  ['hdr', 'radiance-rgbe', 'W04/W15', [], ['src-ts/ibl.ts']],
  ['exr', 'exr-wasm', 'W06', ['exr'], ['../forge3d-core/src/codecs/exr.rs']],
  ['glb', 'gltf2', 'W15', [], ['src-ts/mesh-gltf.ts']],
  ['glyph-pbf', 'mapbox-glyph-pbf', 'W13/W19', [], ['src-ts/style-assets.ts']],
];
const codecs = definitions.map(([format, id, owner, ids, sources]) => {
  const dependencies = ids.map(id => {
    const asset = lock.assets.find(asset => asset.id === id);
    if (!asset || !asset.consumingTasks.includes('W22')) throw Error(`Missing W22 lock: ${id}`);
    return { id, version: asset.version, sha256: asset.source.sha256 };
  });
  const hash = createHash('sha256');
  for (const file of ['src-ts/codec-dispatch.ts', ...sources]) hash.update(readFileSync(new URL(file, root), 'utf8').replace(/\r\n?/g, '\n'));
  hash.update(JSON.stringify(dependencies));
  return { id, format, owner, revision: hash.digest('hex'), dependencies };
});
const denoiser = createHash('sha256');
for (const file of ['src-ts/codec-denoiser.ts', 'src/runtime/offline_denoise.wgsl', 'src/runtime/offline.rs']) denoiser.update(readFileSync(new URL(file, root), 'utf8').replace(/\r\n?/g, '\n'));
const output = '// Generated from feature implementations and the W00 dependency lock.\n' +
  "import type { CodecDescriptor } from './codec-types.js';\n" +
  `export const CODEC_CATALOG: readonly CodecDescriptor[] = ${JSON.stringify(codecs, null, 2)};\n` +
  `export const DENOISER_REVISION = '${denoiser.digest('hex')}';\n`;
const target = new URL('src-ts/codec-catalog.ts', root);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw Error('Codec catalog is stale; run npm run generate:codecs');
} else writeFileSync(fileURLToPath(target), output);
