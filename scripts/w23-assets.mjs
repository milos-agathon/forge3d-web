import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { root, filesBelow, sha256, inventory, baseline } from './w23-coverage.mjs';
import { packagePrefix as prefix } from './w23-catalog.mjs';

export const assetManifestPath = 'docs/parity/w23-assets.json';
const directories = ['assets', 'tests/fixtures', 'tests/golden', 'docs/native-assets', 'examples/migration'];
const textExtensions = new Set(['.json', '.txt', '.md', '.py', '.rs', '.wgsl', '.js', '.mjs', '.ts', '.svg', '.obj', '.mtl', '.csv', '.html', '.cpt', '.npy.json']);
const selected = path => !/\.(html|js|ts)$/.test(path) || !path.includes('/examples/migration/');
export function assetFiles() { return directories.flatMap(d => filesBelow(prefix + d)).filter(selected).sort(); }
export function assetBytes(path, repositoryRoot = root) {
  const bytes = readFileSync(join(repositoryRoot, path));
  return textExtensions.has(extname(path)) ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n')) : bytes;
}
function provenanceFiles(path) {
  const directory = path.slice(0, path.lastIndexOf('/'));
  return [directory + '/provenance.json', directory + '/manifest.json', directory + '/README.md',
    prefix + 'tests/fixtures/w22/manifest.json', prefix + 'assets/datasets/provenance.json',
    prefix + 'assets/fonts/provenance.json'].filter(p => existsSync(join(root, p)) && (p.startsWith(directory + '/') || readFileSync(join(root, p), 'utf8').includes(path.split('/').at(-1))));
}
export function createAssetManifest() {
  const nativeObjects = new Map();
  for (const layer of baseline().baselineLayers.filter(l => l.id !== 'browser-baseline')) {
    const tree = execFileSync('git', ['ls-tree', '-r', layer.commit, '--', 'tests', 'examples', 'docs', 'python/forge3d/datasets'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    for (const line of tree.split('\n')) {
      const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (match && !nativeObjects.has(match[1])) nativeObjects.set(match[1], { ref: layer.commit, path: match[2] });
    }
  }
  const nativeAssets = new Map(inventory().records.filter(r => r.kind === 'native-doc-asset').map(r => [prefix + 'docs/native-assets/' + r.source.path.slice(5), r.source]));
  return { schemaVersion: 1, digestPolicy: 'UTF-8 text hashes normalize CRLF/lone CR to LF; other assets are exact raw bytes. Native object identities retain exact Git provenance.',
    assets: assetFiles().map(path => {
      const bytes = assetBytes(path), raw = readFileSync(join(root, path));
      const object = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
      const native = nativeAssets.get(path) ?? nativeObjects.get(object);
      const provenance = provenanceFiles(path);
      return { path, sha256: sha256(bytes), bytes: bytes.length, hashMode: textExtensions.has(extname(path)) ? 'utf8-lf' : 'raw',
        role: path.includes('/docs/native-assets/') ? 'historical-native-illustration' : path.includes('/tests/golden/') ? 'regression-control' : path.includes('/tests/fixtures/') ? 'test-input' : 'browser-runtime-or-example-input',
        origin: native ? 'native-byte-preserved' : 'browser-owned-see-provenance',
        ...(native ? { native } : {}), provenance };
    }) };
}
export function validateAssets(data, { repositoryRoot = root, paths = assetFiles() } = {}) {
  const errors = [], seen = new Set();
  for (const a of data.assets) {
    if (seen.has(a.path)) errors.push(`Duplicate asset ${a.path}`);
    seen.add(a.path);
    if (!paths.includes(a.path)) { errors.push(`Unknown asset ${a.path}`); continue; }
    if (a.sha256 !== sha256(assetBytes(a.path, repositoryRoot))) errors.push(`Asset digest mismatch ${a.path}`);
    if (a.bytes !== assetBytes(a.path, repositoryRoot).length) errors.push(`Asset length mismatch ${a.path}`);
    if (!['native-byte-preserved', 'browser-owned-see-provenance'].includes(a.origin)) errors.push(`Missing asset provenance ${a.path}`);
    if (a.origin === 'native-byte-preserved' && !a.native?.ref) errors.push(`Missing native source ${a.path}`);
    for (const p of a.provenance) if (!existsSync(join(repositoryRoot, p))) errors.push(`Missing provenance file ${p}`);
  }
  for (const p of paths) if (!seen.has(p)) errors.push(`Untracked asset ${p}`);
  return errors;
}
export function generateAssetManifest() {
  const data = createAssetManifest();
  writeFileSync(join(root, assetManifestPath), JSON.stringify(data, null, 2) + '\n');
  // Only runtime/example and historical doc assets ship; test controls stay in the repo.
  writeFileSync(join(root, prefix, 'docs/migration-assets.json'), JSON.stringify({ ...data, assets: data.assets.filter(a => !a.path.includes('/tests/')) }, null, 2) + '\n');
  return data;
}
