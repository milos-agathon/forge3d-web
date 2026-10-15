import './verify-w13-assets.mjs';
import './verify-w14-assets.mjs';
import './verify-w20-assets.mjs';
import { build as buildVendorModule } from 'vite';
import './prepare-laz-assets.mjs';
import { embedProjWorker } from './embed-proj-worker.mjs';
import { createRequire } from 'node:module';
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(root, "..", "..");
const dist = join(root, "dist");
for (const file of ['diagnostic-style','diagnostics','diagnostic-paths','diagnostic-templates','map-scene-types','map-scene','map-recipe','map-support']) {
  const declarations = readRequired(join(dist,file+'.d.ts')).replace(/from (["'])\.\/(frames|scene|camera)\.js\1/g,'from "./index.js"');
  writeFileSync(join(root,'types',file+'.d.ts'),declarations);
}
const pkg = join(root, "pkg");

mkdirSync(dist, { recursive: true });
const projWorkerPath = join(dist, 'crs-worker.js');
writeFileSync(projWorkerPath, embedProjWorker(readRequired(projWorkerPath)));

copyRequired(join(pkg, "forge3d_web.js"), join(dist, "forge3d_web.js"));
copyRequired(join(pkg, "forge3d_web_bg.wasm"), join(dist, "forge3d_web_bg.wasm"));
copyRequired(join(repoRoot, "LICENSE"), join(root, "LICENSE"));
copyRequired(join(repoRoot, "LICENSE-APACHE"), join(root, "LICENSE-APACHE"));

const facadePath = join(dist, "index.js");
let facade = readRequired(facadePath);
facade = facade.replace(
  "\"../pkg/forge3d_web.js\"",
  "\"./forge3d_web.js\""
);
if (facade.includes("../pkg/forge3d_web.js")) {
  throw new Error("dist/index.js still references unpublished pkg directory");
}
writeFileSync(facadePath, facade);

// ktx-parse is lock-controlled as bundled-self-hosted: ship the exact
// integrity-verified 1.1.0 module under dist/ so the package resolves it
// from 'self' without a bundler or import-map entry.
const ktxRoot = join(root, "node_modules", "ktx-parse");
const ktxVersion = JSON.parse(readRequired(join(ktxRoot, "package.json"))).version;
if (ktxVersion !== "1.1.0") {
  throw new Error(`ktx-parse must be 1.1.0 per the dependency lock, found ${ktxVersion}`);
}
const vendor = join(dist, "vendor");
mkdirSync(vendor, { recursive: true });
const nobleRoot = join(root, 'node_modules', '@noble', 'ed25519');
if (JSON.parse(readRequired(join(nobleRoot,'package.json'))).version !== '3.2.0') throw Error('noble-ed25519 version mismatch');
copyVendoredScript(join(nobleRoot,'index.js'),join(vendor,'noble-ed25519.js'));
copyRequired(join(nobleRoot,'LICENSE'),join(vendor,'noble-ed25519.LICENSE'));
const hashesRoot = join(root,'node_modules','@noble','hashes');
if (JSON.parse(readRequired(join(hashesRoot,'package.json'))).version !== '2.0.1') throw Error('noble-hashes version mismatch');
mkdirSync(join(vendor,'noble-hashes'),{recursive:true});
for (const file of ['sha2.js','_md.js','_u64.js','utils.js']) copyVendoredScript(join(hashesRoot,file),join(vendor,'noble-hashes',file));
copyRequired(join(hashesRoot,'LICENSE'),join(vendor,'noble-hashes','LICENSE'));
// W20: exact W00-pinned browser bundles; no bare imports or runtime CDN.
for (const [name,version,source,output] of [['pdf-lib','1.17.1','dist/pdf-lib.esm.min.js','pdf-lib']]) {
  const dependencyRoot=join(root,'node_modules',name);
  if(JSON.parse(readRequired(join(dependencyRoot,'package.json'))).version!==version) throw Error(name+' differs from the W00 lock');
  copyVendoredScript(join(dependencyRoot,source),join(vendor,output+'.js'));
  if(name==='pdf-lib') copyRequired(join(dependencyRoot,'LICENSE.md'),join(vendor,'pdf-lib.LICENSE'));

}

// Remove the obsolete global UMD wrapper from incremental builds.
if (existsSync(join(vendor, 'fontkit.umd.js'))) unlinkSync(join(vendor, 'fontkit.umd.js'));
const fontkitRoot=join(root,'node_modules','@pdf-lib/fontkit');
if(JSON.parse(readRequired(join(fontkitRoot,'package.json'))).version!=='1.1.1') throw Error('fontkit differs from W00 lock');
const pakoRoot = dirname(createRequire(join(fontkitRoot, 'package.json')).resolve('pako/package.json'));
if(JSON.parse(readRequired(join(pakoRoot, 'package.json'))).version !== '1.0.11') throw Error('fontkit pako differs from npm lock');
// Bundle the real upstream ESM entry and its lock-pinned pako dependency.
await buildVendorModule({configFile:false,publicDir:false,logLevel:'error',build:{lib:{entry:join(root,'src-ts/vendor/fontkit-entry.ts'),formats:['es'],fileName:()=> 'fontkit.js'},outDir:vendor,emptyOutDir:false,minify:true}});
copyRequired(join(root,'assets/licenses/fontkit.LICENSE'),join(vendor,'fontkit.LICENSE'));
copyRequired(join(pakoRoot,'LICENSE'),join(vendor,'pako.LICENSE'));
const regeneratorRoot = join(root, 'node_modules/regenerator-runtime');
if (JSON.parse(readRequired(join(regeneratorRoot,'package.json'))).version !== '0.14.1') throw Error('fontkit runtime differs from npm lock');
copyRequired(join(regeneratorRoot,'LICENSE'),join(vendor,'regenerator-runtime.LICENSE'));
// The entry is published only as the complete self-hosted fontkit module.
for (const file of ['fontkit-entry.js','fontkit-entry.d.ts']) if (existsSync(join(vendor,file))) unlinkSync(join(vendor,file));
const fflateRoot = join(root, 'node_modules', 'fflate');
if (JSON.parse(readRequired(join(fflateRoot, 'package.json'))).version !== '0.8.3') throw Error('fflate must match the W00 lock: 0.8.3');
copyVendoredScript(join(fflateRoot, 'esm', 'browser.js'), join(vendor, 'fflate.js'));
copyRequired(join(fflateRoot, 'LICENSE'), join(vendor, 'fflate.LICENSE'));
copyVendoredScript(join(ktxRoot, "dist", "ktx-parse.modern.js"), join(vendor, "ktx-parse.js"));
copyRequired(join(ktxRoot, "LICENSE"), join(vendor, "ktx-parse.LICENSE"));
// mediabunny is lock-controlled as bundled-self-hosted too: the exact
// integrity-verified 1.58.0 ESM bundle (MPL-2.0) is loaded lazily by video.js.
const mediabunnyRoot = join(root, "node_modules", "mediabunny");
const mediabunnyVersion = JSON.parse(readRequired(join(mediabunnyRoot, "package.json"))).version;
if (mediabunnyVersion !== "1.58.0") {
  throw new Error(`mediabunny must be 1.58.0 per the dependency lock, found ${mediabunnyVersion}`);
}
copyRequired(
  join(mediabunnyRoot, "dist", "bundles", "mediabunny.min.mjs"),
  join(vendor, "mediabunny.js"),
);
copyRequired(join(mediabunnyRoot, "LICENSE"), join(vendor, "mediabunny.LICENSE"));
// geotiff is lock-controlled as bundled-self-hosted too (consumer task W08):
// the exact integrity-verified 3.0.5 browser bundle is vendored with its code
// unchanged (only the dangling source-map comment is dropped),
// wrapped by a tiny generated ESM shim that re-exports the UMD globals.
const geotiffRoot = join(root, "node_modules", "geotiff");
const geotiffVersion = JSON.parse(readRequired(join(geotiffRoot, "package.json"))).version;
if (geotiffVersion !== "3.0.5") {
  throw new Error(`geotiff must be 3.0.5 per the dependency lock, found ${geotiffVersion}`);
}
const geotiffUmdPath = join(vendor, "geotiff.umd.js");
copyVendoredScript(join(geotiffRoot, "dist-browser", "geotiff.js"), geotiffUmdPath);
copyRequired(join(geotiffRoot, "LICENSE"), join(vendor, "geotiff.LICENSE"));
writeFileSync(
  join(vendor, "geotiff.js"),
  `${[
    "// Generated by scripts/prepare-dist.mjs -- do not edit.",
    "// ESM wrapper over the vendored geotiff@3.0.5 UMD bundle.",
    'import "./geotiff.umd.js";',
    // The namespace binding must not be named `GeoTIFF`: the destructured
    // `GeoTIFF` class export below would redeclare it (a SyntaxError).
    "const geotiff = globalThis.GeoTIFF;",
    "if (geotiff === undefined) {",
    '  throw new Error("vendored geotiff.umd.js did not populate globalThis.GeoTIFF");',
    "}",
    "export default geotiff;",
    "export const {",
    "  BaseClient,",
    "  BaseDecoder,",
    "  BaseResponse,",
    "  GeoTIFF,",
    "  GeoTIFFImage,",
    "  ImageFileDirectory,",
    "  MultiGeoTIFF,",
    "  Pool,",
    "  addDecoder,",
    "  fromArrayBuffer,",
    "  fromBlob,",
    "  fromCustomClient,",
    "  fromFile,",
    "  fromUrl,",
    "  fromUrls,",
    "  getDecoder,",
    "  globals,",
    "  registerTag,",
    "  rgb,",
    "  setLogger,",
    "  writeArrayBuffer,",
    "} = geotiff;",
    "",
  ].join("\n")}`,
);
for (const file of readdirSync(dist)) {
  if (!file.endsWith(".js")) continue;
  const path = join(dist, file);
  const source = readFileSync(path, "utf8");
  const rewritten = source
    .replaceAll("from '@noble/ed25519'", "from './vendor/noble-ed25519.js'")
    .replaceAll("from '@noble/hashes/sha2.js'", "from './vendor/noble-hashes/sha2.js'")
    .replaceAll("import('pdf-lib')", "import('./vendor/pdf-lib.js')")
    .replaceAll("import('./vendor/fontkit-entry.js')", "import('./vendor/fontkit.js')")
    .replaceAll("from 'fflate'", "from './vendor/fflate.js'")
    .replaceAll('from "fflate"', 'from "./vendor/fflate.js"')
    .replaceAll("from \"ktx-parse\"", "from \"./vendor/ktx-parse.js\"")
    .replaceAll("import(\"mediabunny\")", "import(\"./vendor/mediabunny.js\")")
    .replaceAll("import(\"geotiff\")", "import(\"./vendor/geotiff.js\")");
  if (/from\s+["']ktx-parse["']/u.test(rewritten)) {
    throw new Error(`dist/${file} still imports the bare ktx-parse specifier`);
  }
  if (/import\(\s*["']mediabunny["']\s*\)/u.test(rewritten)) {
    throw new Error(`dist/${file} still imports the bare mediabunny specifier`);
  }
  if (
    /import\(\s*["']geotiff["']\s*\)/u.test(rewritten) ||
    /from\s+["']geotiff["']/u.test(rewritten) ||
    /import\s+["']geotiff["']/u.test(rewritten)
  ) {
    throw new Error(`dist/${file} still imports the bare geotiff specifier`);
  }
  if (rewritten !== source) writeFileSync(path, rewritten);
}

// Package asset manifest: SHA-256 of every emitted self-hosted third-party asset.
const assetManifest = [
  ...['noble-ed25519.js','noble-ed25519.LICENSE'].map(file=>['dist/vendor/'+file,'@noble/ed25519@3.2.0']),
  ...['sha2.js','_md.js','_u64.js','utils.js','LICENSE'].map(file=>['dist/vendor/noble-hashes/'+file,'@noble/hashes@2.0.1']),
  ['dist/vendor/pako.LICENSE','pako@1.0.11'],
  ['dist/cartography-font-metrics.js','dejavu-fonts@2.37 / Pillow BASIC metrics'],
  ['dist/vendor/regenerator-runtime.LICENSE','regenerator-runtime@0.14.1'],
  ...['DejaVuSans.ttf','DejaVuSans-Bold.ttf','DejaVu-LICENSE'].map(file=>['assets/fonts/'+file,'dejavu-fonts@2.37']),
  ...['pdf-lib','fontkit'].flatMap(name=>[['dist/vendor/'+name+'.js',name==='pdf-lib'?'pdf-lib@1.17.1':'@pdf-lib/fontkit@1.1.1'],['dist/vendor/'+name+'.LICENSE',name==='pdf-lib'?'pdf-lib@1.17.1':'@pdf-lib/fontkit@1.1.1']]),
  ['dist/vendor/fflate.js', 'fflate@0.8.3'],
  ['dist/vendor/fflate.LICENSE', 'fflate@0.8.3'],
  ...['laz-perf.js','laz-perf.wasm','laz-perf.LICENSE'].map(file=>['assets/laz/'+file,'laz-perf@0.0.7']),
  ['dist/crs-worker.js', 'proj-wasm@0.1.0-alpha9 (verified embedded factory)'],
  ...['proj-emscripten.js','proj-emscripten.wasm','proj.db','proj.ini'].map(file=>['assets/proj/'+file,'proj-wasm@0.1.0-alpha9']),
  ['assets/proj/us_noaa_conus.tif','proj-data-conus-v1'],
  ...['mini_dem.npy','sample_boundaries.geojson'].map(file=>['assets/datasets/'+file,'native@1f4084af428dc699bdcd108b029736cb73903926']),
  ["dist/vendor/ktx-parse.js", "ktx-parse@1.1.0"],
  ["dist/vendor/mediabunny.js", "mediabunny@1.58.0"],
  ["dist/vendor/geotiff.umd.js", "geotiff@3.0.5"],
  ["dist/vendor/geotiff.js", "geotiff@3.0.5"],
  ["assets/basis/basis_transcoder.js", "basis_universal@2.0.3"],
  ["assets/basis/basis_transcoder.wasm", "basis_universal@2.0.3"],
  ...["index.mjs","harfbuzz.js","harfbuzz.wasm"].map(file => ["assets/harfbuzz/" + file, "harfbuzzjs@1.6.0"]),
  ...["NotoSans","NotoSansArabic","NotoSansDevanagari"].map(font => ["assets/fonts/" + font + "-Regular.ttf", "noto-fonts@ffebf8c1ee449e544955a7e813c54f9b73848eac"]),
].map(([path, source]) => ({
  path,
  source,
  sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
}));
writeFileSync(
  join(dist, "asset-manifest.json"),
  `${JSON.stringify({ assets: assetManifest }, undefined, 2)}\n`,
);

function copyRequired(from, to) {
  if (!existsSync(from)) {
    throw new Error(`Missing required package source: ${from}`);
  }
  copyFileSync(from, to);
}

// Vendored bundles keep their code bytes but drop the trailing
// sourceMappingURL: the upstream .map files are not shipped, and a dangling
// reference makes consumer dev servers and devtools report missing maps.
function copyVendoredScript(from, to) {
  const text = readRequired(from);
  writeFileSync(to, text.replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/u, "\n"));
}

function readRequired(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required package source: ${path}`);
  }
  return readFileSync(path, "utf8");
}

for (const file of ["label-features", "label-declutter", "label-types", "label-diagnostics", "label-candidates", "label-cases", "label-plan", "label-mesh", "typography", "labels"]) {
  const declaration = readRequired(join(dist, file + ".d.ts")).replace(/from (["'])\.\/(scene|camera)\.js\1/g, 'from "./index.js"');
  writeFileSync(join(root, "types", file + ".d.ts"), declaration);
}
for (const file of ['crs','crs-types','crs-layers','dataset-types','datasets','vector-types','vector-layers']) {
  copyRequired(join(dist,file+'.d.ts'),join(root,'types',file+'.d.ts'));
}
copyRequired(join(repoRoot, "docs", "parity", "label-case-contract.json"), join(root, "docs", "label-case-contract.json"));
for (const file of ['mesh','geometry','mesh-processing','mesh-obj','mesh-stl','mesh-gltf','mesh-io','image-io','mesh-worker','buildings','building-materials','building-diagnostics','scatter-types']) {
  writeFileSync(join(root,'types',file+'.d.ts'),readRequired(join(dist,file+'.d.ts')).replace(/from (["'])\.\/(terrain-scatter|range-scheduler|byte-cache)\.js\1/g,'from "./index.js"'));
}
for (const file of ['pointcloud-types','pointcloud-common','pointcloud-octree','pointcloud-buffer','pointcloud-las','pointcloud-source','pointcloud','laz-decoder','copc','ept','pointcloud-layer','pointcloud-renderer','tiles3d-bounds','tiles3d-content','tiles3d','tiles3d-layer']) {
  writeFileSync(join(root,'types',file+'.d.ts'),readRequired(join(dist,file+'.d.ts')).replace(/from (["'])\.\/(terrain-scatter|range-scheduler|byte-cache)\.js\1/g,'from "./index.js"'));
}

for (const file of ['trace-types','trace-math','bvh-build','bvh','bvh-gpu','sdf-primitive','sdf','trace-scene','trace-cpu','trace-bsdf','trace-light','trace-sampling','trace-compute','trace-gpu','path-tracer','trace-worker','trace-output']) {
  writeFileSync(join(root,'types',file+'.d.ts'),readRequired(join(dist,file+'.d.ts')).replace(/from (["'])\.\/frames\.js\1/g,'from "./index.js"'));
}
for (const file of ['style-native-values','bundle-style-assets','style-expressions','map-style','style-assets','scene-review','bundle','bundle-archive','bundle-output','bundle-migration']) {
  copyRequired(join(dist,file+'.d.ts'),join(root,'types',file+'.d.ts'));
}

for (const file of ['license','image-array','png-decode','benchmark']) writeFileSync(join(root,'types',file+'.d.ts'),readRequired(join(dist,file+'.d.ts')).replaceAll('./renderer-config.js','./index.js'));
for (const file of ['cartography-common','cartography-fonts','cartography-canvas','colormaps','colormap-io','map-layout','map-legend','map-scale-bar','map-north-arrow','map-plate','vector-export-scene','vector-export','vector-pdf']) {
  writeFileSync(join(root,'types',file+'.d.ts'),readRequired(join(dist,file+'.d.ts')).replace(/from (["'])\.\/(frames)\.js\1/g,'from "./index.js"'));
}
