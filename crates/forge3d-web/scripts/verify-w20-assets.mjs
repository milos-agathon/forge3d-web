import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(readFileSync(resolve(root, 'assets/fonts/dejavu-provenance.json'), 'utf8'));
const expected = {
  'assets/fonts/DejaVuSans.ttf': '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954',
  'assets/fonts/DejaVuSans-Bold.ttf': 'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724',
  'assets/fonts/DejaVu-LICENSE': '7a083b136e64d064794c3419751e5c7dd10d2f64c108fe5ba161eae5e5958a93',
};
if (provenance.archiveSha256 !== '7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a') throw Error('DejaVu archive provenance drift');
for (const [path, sha256] of Object.entries(expected)) {
  if (provenance.files.find(f => f.path === path)?.sha256 !== sha256 || createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex') !== sha256) throw Error('DejaVu asset mismatch: ' + path);
}
const packageLock = JSON.parse(readFileSync(resolve(root,'package-lock.json'),'utf8'));
const runtime = packageLock.packages['node_modules/regenerator-runtime'];
if (runtime?.version !== '0.14.1' || runtime.integrity !== 'sha512-dYnhHh0nJoMfnkZs6GmmhFknAGRrLznOu5nc9ML+EJxGvrx6H7teuevqVqCuPcPK//3eDrrjQhehXVx9cnkGdw==') throw Error('Fontkit runtime integrity drift');
if (createHash('sha256').update(readFileSync(resolve(root,'node_modules/regenerator-runtime/runtime.js'))).digest('hex') !== '7beda998b3fd277f3548e12b277bafc3037d243421f007032d38dffee412224c') throw Error('Fontkit runtime source drift');
if (createHash('sha256').update(readFileSync(resolve(root,'src-ts/cartography-font-metrics.ts'),'utf8').replace(/\r\n/g,'\n')).digest('hex') !== 'de0ee7e0318079ffceda28aef657088b4fcb67a2387155e0d33039c0076abf0a') throw Error('Pinned native font metrics drift');
