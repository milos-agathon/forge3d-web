// W23_OUTPUTS: ["crates/forge3d-web/tests/fixtures/w22/autzen.laz","crates/forge3d-web/tests/fixtures/w22/glyphs.pbf","crates/forge3d-web/tests/fixtures/w22/linear.exr","crates/forge3d-web/tests/fixtures/w22/linear.hdr","crates/forge3d-web/tests/fixtures/w22/manifest.json","crates/forge3d-web/tests/fixtures/w22/multiband-strips.tif","crates/forge3d-web/tests/fixtures/w22/predictor.tif","crates/forge3d-web/tests/fixtures/w22/rgba.ktx2","crates/forge3d-web/tests/fixtures/w22/triangle.glb"]
import { multibandStripTiff } from './w22-strip-fixture.mjs';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDefaultContainer, write } from 'ktx-parse';
import { initSync, encodeExr } from '../pkg/forge3d_web.js';
const root = new URL('../', import.meta.url), directory = new URL('tests/fixtures/w22/', root);
mkdirSync(directory, { recursive: true });
const fixtures = [];
function record(format, file, provenance, expected) {
  const bytes = readFileSync(new URL(file, directory));
  fixtures.push({ format, file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, provenance, expected });
}
for (const [format, source, target, expected] of [
  ['tiff', 'tests/golden/w08/predictor-deflate-u16.tif', 'predictor.tif', { width:16, height:16, formula:'index * 3 + 7' }],
  ['laz', 'tests/fixtures/w16/autzen_trim.laz', 'autzen.laz', JSON.parse(readFileSync(new URL('tests/fixtures/w16/copc-ept-tiles-v1.json', root))).autzen],
  ['glb', 'tests/fixtures/w15/triangle.glb', 'triangle.glb', { primitives:1, vertices:3 }],
]) {
  copyFileSync(new URL(source, root), new URL(target, directory));
  record(format, target, source, expected);
}
writeFileSync(new URL('multiband-strips.tif', directory), multibandStripTiff());
record('tiff','multiband-strips.tif','Analytic TIFF RGB8 with two strips including a partial final strip; scripts/w22-strip-fixture.mjs', {width:3,height:3,pixels:[1,2,3,4,5,6,7,8,9],crs:'EPSG:4326',nodata:255});
const container = createDefaultContainer();
Object.assign(container, { vkFormat:37, pixelWidth:2, pixelHeight:2, pixelDepth:0, layerCount:0, faceCount:1, levelCount:1 });
const pixels = Uint8Array.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
container.levels = [{ levelData:pixels, uncompressedByteLength:pixels.length }];
writeFileSync(new URL('rgba.ktx2', directory), write(container));
record('ktx2','rgba.ktx2','W04 ktx-parse@1.1.0 uncompressed reference container', { width:2,height:2,pixels:[...pixels] });
record('ktx2','kodim23.ktx2','https://github.com/BinomialLLC/basis_universal/blob/21fb6e242b1e425a7557c5655bb1b475f71933ca/test_files/kodim23.ktx2', { width:768,height:512, supercompression:'basislz',rgbaSha256:'d10f98edbecc601ce319ef357c6483d353fd2f09200a9ffb1154712ba51edcf5' });
const hdr = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n'),Buffer.from([128,64,32,129,32,64,128,129])]);
writeFileSync(new URL('linear.hdr', directory), hdr);
record('hdr','linear.hdr','Radiance RGBE analytic powers of two; 1f4084a:src/formats/hdr.rs', { width:2,height:1, pixels:[1,0.5,0.25,1,0.25,0.5,1,1] });
initSync({ module:readFileSync(new URL('pkg/forge3d_web_bg.wasm', root)) });
const channels = [ {name:'R',data:new Float32Array([0.25,2])}, {name:'G',data:new Float32Array([0.5,4])}, {name:'B',data:new Float32Array([1,8])} ];
writeFileSync(new URL('linear.exr',directory),encodeExr({ width:2,height:1,channels,metadata:{'forge3d:fixture':'E05'},compression:'zip' }));
record('exr','linear.exr','Pinned exr@1.74.2 encoder; explicit analytic channel values; 1f4084a:tests/test_exr_output.py', { width:2,height:1, channels:{ R:[0.25,2],G:[0.5,4],B:[1,8] } });
const vint = n => { const b=[]; do { const x=n&127; n>>>=7; b.push(x|(n?128:0)); } while(n); return Buffer.from(b); };
const field=(tag,data)=>Buffer.concat([vint(tag*8+2),vint(data.length),Buffer.from(data)]);
const num=(tag,n)=>Buffer.concat([vint(tag*8),vint(n)]);
const glyph=Buffer.concat([num(1,65),field(2,Buffer.alloc(49,123)),num(3,1),num(4,1),num(5,0),num(6,2),num(7,8)]);
const range=Buffer.concat([field(1,Buffer.from('Noto Sans')),field(2,Buffer.from('0-255')),field(3,glyph)]);
writeFileSync(new URL('glyphs.pbf', directory),field(1,range));
record('glyph-pbf','glyphs.pbf','W13/W19 Mapbox glyph protocol: U+0041, 1x1 ink plus 3px border', { name:'Noto Sans',range:'0-255',id:65,bitmap:123,advance:8 });
writeFileSync(new URL('manifest.json', directory),JSON.stringify({ schemaVersion:1,capability:'E05',fixtures },null,2)+'\n');
