import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { root, filesBelow, sha256, inventory, baseline } from './w23-coverage.mjs';
import { packagePrefix as prefix } from './w23-catalog.mjs';
import { assetDerivation, resetDerivationInputs } from './w23-provenance.mjs';

export const assetManifestPath = 'docs/parity/w23-assets.json';
const directories = ['assets', 'tests/fixtures', 'tests/golden', 'docs/native-assets', 'docs/evidence-sources', 'examples/migration'];
const textExtensions = new Set(['.json', '.txt', '.md', '.py', '.rs', '.wgsl', '.js', '.mjs', '.ts', '.svg', '.obj', '.mtl', '.csv', '.html', '.cpt', '.npy.json']);
export function assetFiles() { return directories.flatMap(d => filesBelow(prefix + d)).sort(); }
export function assetBytes(path, repositoryRoot = root) {
  const bytes = readFileSync(join(repositoryRoot, path));
  return textExtensions.has(extname(path)) ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n')) : bytes;
}
function provenanceFiles(path) {
  const directory = path.slice(0, path.lastIndexOf('/'));
  const ancestors = []; let parent = directory;
  while (parent.startsWith(prefix)) { ancestors.push(...['provenance.json', 'manifest.json', 'README.md'].map(n => parent + '/' + n)); parent = parent.slice(0, parent.lastIndexOf('/')); }
  const generator = path.includes('w05-camera-native') ? 'generate-w05-camera-fixture.py' : /w06-aov-native|w04-terrain-pbr-native/.test(path) ? 'generate-w06-aov-fixture.py' : null;
  return [...new Set([...(generator ? [prefix + 'scripts/' + generator] : []), ...(path.includes('applications')?[directory+'/applications-provenance.json',prefix+'scripts/generate-w23-application-fixtures.py']:[]), ...ancestors,
    prefix + 'tests/fixtures/w22/manifest.json', prefix + 'assets/datasets/provenance.json',
    prefix + 'assets/fonts/provenance.json'])].filter(p => existsSync(join(root, p)) && (ancestors.includes(p) || p.endsWith(generator ?? '\0') || path.includes('applications')&&p.includes('application') || readFileSync(join(root, p), 'utf8').includes(path.split('/').at(-1))));
}
export function createAssetManifest() {
  resetDerivationInputs();
  // History is a concrete byte-source for browser-authored controls; it does
  // not turn those controls into native oracles. Resolve it in one Git walk.
  const history = execFileSync('git', ['log', '--format=commit:%H', '--name-only', '--', ...directories.map(d => prefix + d)], {cwd: root, encoding:'utf8', maxBuffer:64*1024*1024});
  const revisions = new Map(); let revision;
  for (const line of history.split(/\r?\n/)) { if (line.startsWith('commit:')) revision = line.slice(7); else if (line && revision && !revisions.has(line)) revisions.set(line, revision); }
  const nativeObjects = new Map();
  for (const layer of baseline().baselineLayers.filter(l => l.id !== 'browser-baseline')) {
    const tree = execFileSync('git', ['ls-tree', '-r', layer.commit, '--', 'tests', 'examples', 'docs', 'python', 'src', 'assets'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    for (const line of tree.split('\n')) {
      const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (match && !nativeObjects.has(match[1])) nativeObjects.set(match[1], { ref: layer.commit, path: match[2] });
    }
  }
  const nativeAssets = new Map(inventory().records.filter(r => r.kind === 'native-doc-asset').map(r => [prefix + 'docs/native-assets/' + r.source.path.slice(5), r.source]));
  const sourceObjects=[...nativeObjects].filter(([,s])=>textExtensions.has(extname(s.path)));
  const normalizedNative = new Map();
  const rawSources=execFileSync('git',['cat-file','--batch'],{cwd:root,input:sourceObjects.map(([id])=>id).join('\n')+'\n',maxBuffer:128*1024*1024});let offset=0;
  for(const [gitBlob,source]of sourceObjects){const end=rawSources.indexOf(10,offset),size=Number(rawSources.subarray(offset,end).toString().split(' ')[2]),raw=rawSources.subarray(end+1,end+1+size);offset=end+size+2;normalizedNative.set(sha256(Buffer.from(raw.toString('utf8').replace(/\r\n?/g,'\n'))),{...source,gitBlob,sha256:sha256(raw),normalization:'utf8-lf'});}
  const nativeByDigest=new Map([...normalizedNative.values()].map(s=>[s.sha256,s]));
  return { schemaVersion: 1, digestPolicy: 'UTF-8 text hashes normalize CRLF/lone CR to LF; other assets are exact raw bytes. Native object identities retain exact Git provenance. Derivation inputs and generators are separate from storage history.',
    assets: assetFiles().map(path => {
      const bytes = assetBytes(path), raw = readFileSync(join(root, path));
      const object = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
      const preserved = nativeAssets.get(path) ?? nativeObjects.get(object);
      const native = preserved ?? (textExtensions.has(extname(path)) ? normalizedNative.get(sha256(bytes)) : undefined);
      const provenance = provenanceFiles(path).filter(p=>p.includes('/scripts/')||readFileSync(join(root,p),'utf8').includes(path.split('/').at(-1)));
      const derivation=native?undefined:assetDerivation(path,{root,nativeByDigest});
      if(derivation){for(const input of [...(derivation.inputs??[]),...(derivation.generator?[derivation.generator]:[])])if(!input.ref&&!provenance.includes(input.path))provenance.push(input.path);}
      const sourceRevision = revisions.get(path);
      if (sourceRevision) provenance.push(`git:${sourceRevision}:${path}`);
      else if (!native && !provenance.length && !derivation) throw Error(`New asset needs an explicit generator/provenance manifest before admission: ${path}`);
      return { path, sha256: sha256(bytes), bytes: bytes.length, hashMode: textExtensions.has(extname(path)) ? 'utf8-lf' : 'raw',
        role: path.includes('/docs/native-assets/') ? 'historical-native-illustration' : path.includes('/docs/evidence-sources/') ? 'evidence-source-snapshot' : path.includes('/tests/golden/') ? 'regression-control' : path.includes('/tests/fixtures/') ? 'test-input' : 'browser-runtime-or-example-input',
        origin: native ? preserved ? 'native-byte-preserved' : 'native-text-normalized' : /w05-camera-native|w06-aov-native|w04-terrain-pbr-native|terrain-single-tile|single-tile-oracle|applications(-provenance)?\.json/.test(path) || path.includes('/tests/golden/w23/') || /tests\/golden\/w07\//.test(path) || derivation.kind==='native-kernel-capture' || derivation.kind==='converted-native-data' ? 'native-derived' : 'browser-owned-see-provenance',
        ...(native ? { native } : {derivation}), provenance };
    }) };
}
export function validateAssets(data, { repositoryRoot = root, paths = assetFiles() } = {}) {
  const errors = [], seen = new Set(), gitSources = new Set(), inputDigests=new Map(),derivationDigests=new Map();
  for (const a of data.assets) {
    if (seen.has(a.path)) errors.push(`Duplicate asset ${a.path}`);
    seen.add(a.path);
    if (!paths.includes(a.path)) { errors.push(`Unknown asset ${a.path}`); continue; }
    if (a.sha256 !== sha256(assetBytes(a.path, repositoryRoot))) errors.push(`Asset digest mismatch ${a.path}`);
    if (a.bytes !== assetBytes(a.path, repositoryRoot).length) errors.push(`Asset length mismatch ${a.path}`);
    if (!['native-byte-preserved', 'native-text-normalized', 'native-derived', 'browser-owned-see-provenance'].includes(a.origin)) errors.push(`Missing asset provenance ${a.path}`);
    if (!a.native && !a.provenance?.length) errors.push(`Missing concrete provenance ${a.path}`);
    if(!a.native&&!a.derivation)errors.push(`Missing asset derivation ${a.path}`);
    if(a.derivation){
      const d=a.derivation;
      if(!d.kind||!(d.recipe??d.purpose)?.trim()||!d.inputs?.length&&!d.generator)errors.push(`Incomplete asset derivation ${a.path}`);
      for(const input of [...(d.inputs??[]),...(d.generator?[d.generator]:[])]){
        if(input.ref){const key=`${input.ref}:${input.path}`;gitSources.add(key);derivationDigests.set(key,input.sha256);continue;}
        const full=join(repositoryRoot,input.path??'');
        if(!input.path||input.path===a.path||!existsSync(full)){errors.push(`Missing derivation input ${a.path}: ${input.path}`);continue;}
        const key=input.path+':'+input.hashMode;
        if(!inputDigests.has(key)){const raw=readFileSync(full),bytes=input.hashMode==='raw'?raw:Buffer.from(raw.toString('utf8').replace(/\r\n?/g,'\n'));inputDigests.set(key,sha256(bytes));}
        if(inputDigests.get(key)!==input.sha256)errors.push(`Derivation input digest mismatch ${a.path}: ${input.path}`);
      }
      if(d.kind==='source-copy'&&a.sha256!==d.inputs[0]?.sha256)errors.push(`Evidence snapshot differs from its source ${a.path}`);
      if(d.kind==='native-kernel-capture'){
        const value=JSON.parse(readFileSync(join(repositoryRoot,a.path),'utf8')),digests=typeof value.sourceSha256==='string'?[value.sourceSha256]:Object.values(value.sourceSha256??{});
        if(!digests.length||d.inputs.some(i=>!digests.includes(i.sha256)))errors.push(`Unrelated native kernel derivation ${a.path}`);
      }
    }
    if(a.native && !a.origin.startsWith('native-'))errors.push(`Native asset mislabeled as browser-owned ${a.path}`);
    if(['native-byte-preserved','native-text-normalized'].includes(a.origin)&&!a.native?.ref)errors.push(`Missing native source ${a.path}`);
    if (a.origin === 'native-byte-preserved' && !a.native?.ref) errors.push(`Missing native source ${a.path}`);
    if(a.native?.ref && a.native?.path)gitSources.add(`${a.native.ref}:${a.native.path}`);
    for (const p of a.provenance) {
      if (p.startsWith('git:')) { if (!/^git:[a-f0-9]{40}:crates\/forge3d-web\//.test(p)) errors.push(`Invalid Git provenance ${p}`); else gitSources.add(p.slice(4)); }
      else if (!existsSync(join(repositoryRoot, p))) errors.push(`Missing provenance file ${p}`);
    }
  }
  if(gitSources.size){
    const sources=[...gitSources],results=execFileSync('git',['cat-file','--batch-check'],{cwd:repositoryRoot,input:sources.join('\n')+'\n',encoding:'utf8',maxBuffer:4*1024*1024}).trim().split('\n'),objects=new Map();
    results.forEach((value,i)=>{if(!/^[a-f0-9]{40} blob \d+$/.test(value))errors.push(`Missing Git asset provenance ${sources[i]}`);else objects.set(sources[i],value.split(' ')[0]);});
    for(const a of data.assets.filter(a=>a.origin==='native-byte-preserved'&&a.native&&seen.has(a.path))){const bytes=readFileSync(join(repositoryRoot,a.path)),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(blob!==objects.get(`${a.native.ref}:${a.native.path}`))errors.push(`Native source bytes mismatch ${a.path}`);}
    const normalized=data.assets.filter(a=>a.origin==='native-text-normalized'&&a.native),keys=[...new Set(normalized.map(a=>`${a.native.ref}:${a.native.path}`).filter(k=>objects.has(k)))];
    if(keys.length){const raw=execFileSync('git',['cat-file','--batch'],{cwd:repositoryRoot,input:keys.join('\n')+'\n',maxBuffer:128*1024*1024}),digests=new Map();let offset=0;for(const key of keys){const end=raw.indexOf(10,offset),size=Number(raw.subarray(offset,end).toString().split(' ')[2]),content=raw.subarray(end+1,end+1+size);offset=end+size+2;digests.set(key,sha256(content.toString('utf8').replace(/\r\n?/g,'\n')));}for(const a of normalized)if(a.sha256!==digests.get(`${a.native.ref}:${a.native.path}`))errors.push(`Normalized native source bytes mismatch ${a.path}`);}
    const derived=[...derivationDigests.keys()].filter(k=>objects.has(k));
    if(derived.length){const raw=execFileSync('git',['cat-file','--batch'],{cwd:repositoryRoot,input:derived.join('\n')+'\n',maxBuffer:64*1024*1024});let offset=0;for(const key of derived){const end=raw.indexOf(10,offset),size=Number(raw.subarray(offset,end).toString().split(' ')[2]),content=raw.subarray(end+1,end+1+size);offset=end+size+2;if(sha256(content)!==derivationDigests.get(key))errors.push(`Native derivation source bytes mismatch ${key}`);}}
  }
  for (const p of paths) if (!seen.has(p)) errors.push(`Untracked asset ${p}`);
  return errors;
}
export function generateAssetManifest() {
  const data = createAssetManifest();
  writeFileSync(join(root, assetManifestPath), JSON.stringify(data, null, 2) + '\n');
  // Only runtime/example and historical doc assets ship; test controls stay in the repo.
  writeFileSync(join(root, prefix, 'docs/migration-assets.json'), JSON.stringify({ ...data, assets: data.assets.filter(a => !a.path.startsWith(prefix + 'tests/')) }, null, 2) + '\n');
  return data;
}
