import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dependency = JSON.parse(readFileSync(new URL('../../docs/parity/dependency-lock.json', root), 'utf8'))
  .assets.find(asset => asset.id === 'proj-wasm');
const artifact = dependency.build.artifacts.find(asset => asset.name === 'assets/proj/proj-emscripten.js');
const provenance = JSON.parse(readFileSync(new URL('assets/proj/provenance.json', root), 'utf8'))
  .assets.find(asset => asset.name === 'proj-emscripten.js');
const exportStatement = 'export default PROJModule;\n';
const marker = '\n// W14 verified PROJ factory\n';

// Verify before parsing, embedding or evaluating any third-party JavaScript.
export function verifiedProjFactory(bytes = readFileSync(new URL('assets/proj/proj-emscripten.js', root))) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256 || digest !== provenance.sha256 || bytes.length !== provenance.byteLength)
    throw Error('W14 asset mismatch: proj-emscripten.js');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!source.startsWith('async function PROJModule(') || !source.endsWith(exportStatement))
    throw Error('Pinned PROJ module must contain the factory declaration and export');
  return source.slice(0, -exportStatement.length);
}

export function embedProjWorker(workerSource) {
  const embedded = marker + verifiedProjFactory() + '\n';
  if (workerSource.endsWith(embedded)) return workerSource;
  if (workerSource.includes(marker)) throw Error('Previously embedded PROJ factory changed');
  return workerSource + embedded;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = new URL('dist/crs-worker.js', root);
  writeFileSync(worker, embedProjWorker(readFileSync(worker, 'utf8')));
}
