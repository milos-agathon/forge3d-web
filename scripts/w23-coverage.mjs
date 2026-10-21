import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { exampleWorkflows, families, packagePrefix, rowApis, workflowCapabilities, exportOverrides, rowEvidence, exportNotes } from './w23-catalog.mjs';
import { semanticRoute, sameValues } from './w23-semantics.mjs';
import { applicationKind } from '../crates/forge3d-web/examples/migration/application-analysis.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = 'docs/parity/w23-coverage.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const text = path => readFileSync(join(root, path), 'utf8').replace(/\r\n?/g, '\n');
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
export const inventory = () => json(`${packagePrefix}tests/parity/composite-inventory.json`);
export const baseline = () => json('docs/parity/forge3d-composite-baseline.json');
export const sourceContracts = () => json('docs/parity/w23-source-contracts.json');
let verifyGenerated = false;
const save = (path, value) => {
  if (verifyGenerated) {
    const actual = existsSync(join(root, path)) ? readFileSync(join(root, path)) : Buffer.alloc(0);
    const expected = typeof value === 'string' ? Buffer.from(value) : value;
    const normalized = typeof value === 'string' ? Buffer.from(actual.toString('utf8').replace(/\r\n?/g, '\n')) : actual;
    if (!normalized.equals(expected)) throw Error(`Stale generated W23 artifact: ${path}. Run npm run generate:w23.`);
  } else { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); }
};
const saveJson = (path, value) => save(path, JSON.stringify(value, null, 2) + '\n');
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function filesBelow(path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const p = `${path}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(p) : entry.isFile() ? [p] : [];
  }).sort();
}
function testCases(path) {
  // Store exact declaration strings, including parameterized titles. Execution stays
  // with the owner suite; an inventory mapping is not a per-case port assertion.
  const source = text(path);
  const titles = [...source.matchAll(/\b(?:it|test)(?:\.(?:only|skip|todo))?\s*\(\s*(["'`])([^\n]*?)\1/g)].map(m => m[2]);
  if (!titles.length && !/\b(?:it|test)\.each\(/.test(source)) throw Error(`No test declarations: ${path}`);
  return { path, sha256: sha256(source), declarations: [...new Set(titles)] };
}
function relativeLink(from, to) { return relative(dirname(from), to).replaceAll('\\', '/'); }
function currentSourceLink(path) { return `evidence-sources/${path.slice(packagePrefix.length)}.txt`; }
function sourceLink(record) { return `https://github.com/milos-agathon/forge3d-web/blob/${record.source.ref}/${record.source.path}${record.source.line ? '#L' + record.source.line : ''}`; }

export function createCoverage() {
  const native = inventory(), base = baseline();
  const mappings = new Map(base.mappings.map(m => [m.artifactId, m]));
  const rows = [...base.capabilities, ...base.constraints].map(row => {
    const [guide, suites, example] = families[row.ownerTask] ?? [];
    if (!guide || !rowApis[row.id]) throw Error(`Missing explicit evidence routing: ${row.id}`);
    return { id: row.id, owner: row.ownerTask, title: row.title, baselineStatus: row.status,
      apis: rowApis[row.id], guide: `${packagePrefix}docs/${guide}`, tests: (rowEvidence[row.id] ?? suites).map(p => packagePrefix + p),
      example: packagePrefix + 'examples/' + example, disposition: row.lifecycle === 'DA' ? 'diagnostic-contract' : 'capability-evidence' };
  });
  const examples = native.records.filter(r => r.kind === 'native-example').map(r => {
    const declared = exampleWorkflows[r.name];
    const workflows = declared ? [...(applicationKind(r.name)?['application']:[]),...declared] : null;
    if (!workflows?.length) throw Error(`Unmapped original example ${r.qualifiedName}`);
    return { artifactId: r.id, nativePath: r.source.path, source: r.source, workflows,
      capabilities: [...new Set(workflows.flatMap(w => workflowCapabilities[w] ?? []))],
      browser: `${packagePrefix}examples/migration/index.html?example=${encodeURIComponent(r.name)}`,
      adaptation: r.name === '_import_shim.py' ? 'Package ESM resolution replaces sys.path mutation.' :
        'Bounded offline fixtures exercise the Forge3D workflows; regional downloads and external Python preprocessing are replaced with typed browser inputs.' };
  });
  for (const name of Object.keys(exampleWorkflows)) if (!examples.some(e => e.nativePath.endsWith('/' + name))) throw Error(`Unknown historical example in catalog: ${name}`);
  const records = native.records.map(r => {
    const m = mappings.get(r.id);
    if (!m) throw Error(`W00 has no owner: ${r.id}`);
    const example = examples.find(e => e.artifactId === r.id);
    const route = semanticRoute(r, m, base.tombstones);
    return { artifactId: r.id, ...route, evidenceKind: route.tombstone ? 'tombstone' :
      example ? 'browser-workflow' : r.kind.startsWith('native-test') ? 'capability-test-route' : 'capability-evidence-route',
    };
  });
  const paths = [...new Set(rows.flatMap(r => r.tests))].sort();
  const ts = createRequire(join(root, packagePrefix, 'package.json'))('typescript');
  const entry = join(root, packagePrefix, 'types/index.d.ts');
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const checker = program.getTypeChecker(), publicNames = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry))).map(s => s.name));
  const pythonExports = native.records.filter(r => r.kind === 'package-root-export').map(r => {
    const camel = r.name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const explicit = exportOverrides[r.name];
    const named = publicNames.has(r.name) ? r.name : publicNames.has(camel) ? camel : null;
    const apis = explicit ?? (named ? [named] : rowApis[mappings.get(r.id).capabilityId]);
    return { native: r.name, apis, kind: apis.length === 0 ? 'npm-metadata' : explicit || named ? 'named-browser-entry' : 'capability-workflow',
      note: exportNotes[r.name] ?? (apis.length === 0 ? 'Read the installed npm package version metadata; no Python version function is exported.' :
        explicit || named ? 'Browser entry point; use its typed asynchronous signature and lifecycle.' : 'Follow the capability guide for the equivalent workflow; no same-name alias is claimed.') };
  });
  return { schemaVersion: 1, scope: 'W23 evidence coverage; functional and physical qualification remain with the owning tasks.',
    inventorySha256: sha256(text(`${packagePrefix}tests/parity/composite-inventory.json`)),
    rows, examples, pythonExports, tests: paths.map(testCases), tombstones: base.tombstones, records };
}

export function validateCoverage(data, { repositoryRoot = root } = {}) {
  const errors = [], base = baseline(), native = inventory();
  const check = (ok, message) => { if (!ok) errors.push(message); };
  const local = path => {
    if (typeof path !== 'string' || path.includes('\\') || isAbsolute(path)) return false;
    const rel = relative(repositoryRoot, resolve(repositoryRoot, path));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(resolve(repositoryRoot, path));
  };
  const exactIds = (label, actual, expected) => {
    const seen = new Set(); for (const id of actual) { check(!seen.has(id), `Duplicate ${label}: ${id}`); seen.add(id); }
    for (const id of expected) check(seen.has(id), `Unmapped ${label}: ${id}`);
    for (const id of seen) check(expected.includes(id), `Unknown ${label}: ${id}`);
  };
  check(data.schemaVersion === 1, 'Unsupported W23 schema');
  check(data.inventorySha256 === sha256(text(`${packagePrefix}tests/parity/composite-inventory.json`)), 'Inventory digest mismatch');
  exactIds('row', data.rows.map(r => r.id), [...base.capabilities, ...base.constraints].map(r => r.id));
  exactIds('artifact', data.records.map(r => r.artifactId), native.records.map(r => r.id));
  exactIds('example', data.examples.map(e => e.artifactId), native.records.filter(r => r.kind === 'native-example').map(r => r.id));
  exactIds('tombstone', data.tombstones.map(t => t.id), base.tombstones.map(t => t.id));
  exactIds('Python export', (data.pythonExports ?? []).map(r => r.native), native.records.filter(r => r.kind === 'package-root-export').map(r => r.name));
  for (const r of data.pythonExports ?? []) {
    check(['npm-metadata', 'named-browser-entry', 'capability-workflow'].includes(r.kind), `Unknown export migration ${r.native}`);
    check(r.note?.trim().length > 0 && (r.apis.length > 0 || r.kind === 'npm-metadata'), `Missing export migration ${r.native}`);
  }
  const contract = sourceContracts();
  for (const r of data.pythonExports ?? []) {
    check(sameValues(r.apis, contract.exports[r.native]?.apis), `Semantic API destination mismatch ${r.native}`);
    check(r.kind===contract.exports[r.native]?.kind && r.note===contract.exports[r.native]?.note, `Semantic API adaptation mismatch ${r.native}`);
  }
  const tests = new Map(data.tests.map(t => [t.path, t]));
  for (const t of data.tests) {
    check(local(t.path), `Missing test ${t.path}`);
    if (!local(t.path)) continue;
    const current = readFileSync(resolve(repositoryRoot, t.path), 'utf8').replace(/\r\n?/g, '\n');
    check(t.sha256 === sha256(current), `Stale test digest ${t.path}`);
    check(t.declarations.length > 0, `No exact test declarations ${t.path}`);
    check(sameValues(t.declarations, testCases(t.path).declarations), `Incomplete test declarations ${t.path}`);
    for (const declaration of t.declarations) check(current.includes(declaration), `Missing test declaration ${declaration}`);
  }
  for (const row of data.rows) {
    check(sameValues(row.tests, contract.rows[row.id]?.tests), `Semantic test ownership mismatch ${row.id}`);
    check(sameValues(row.apis, contract.rows[row.id]?.apis), `Semantic row API mismatch ${row.id}`);
    check(row.guide===contract.rows[row.id]?.guide && row.example===contract.rows[row.id]?.example, `Semantic guide/example mismatch ${row.id}`);
    check(local(row.guide), `Missing guide for ${row.id}`);
    check(local(row.example), `Missing example for ${row.id}`);
    check(row.tests.length > 0 && row.tests.every(t => tests.has(t)), `No concrete test evidence for ${row.id}`);
    check(row.apis.length > 0, `No migration API for ${row.id}`);
  }
  const rowIds = new Set(data.rows.map(r => r.id)), tombstones = new Set(data.tombstones.map(t => t.id));
  const originalMappings = new Map(base.mappings.map(m => [m.artifactId, m]));
  const originals = new Map(native.records.map(r => [r.id, r]));
  for (const r of data.records) {
    const original = originals.get(r.artifactId), mapping = originalMappings.get(r.artifactId);
    if (original && mapping) {
      const expected = semanticRoute(original, mapping, base.tombstones);
      check(r.row === expected.row && r.tombstone === expected.tombstone, `Semantic source routing mismatch ${original.qualifiedName}`);
      check(!!expected.tombstone === (r.evidenceKind === 'tombstone'), `Missing tombstone disposition ${original.qualifiedName}`);
      const kind=expected.tombstone?'tombstone':original.kind==='native-example'?'browser-workflow':original.kind.startsWith('native-test')?'capability-test-route':'capability-evidence-route';
      check(r.evidenceKind===kind,`Misrepresented evidence kind ${original.qualifiedName}`);
    }
    check(rowIds.has(r.row), `Unknown evidence row ${r.row}`);
    check(['tombstone', 'browser-workflow', 'capability-test-route', 'capability-evidence-route'].includes(r.evidenceKind), `Unknown evidence kind ${r.artifactId}`);
    if (r.evidenceKind === 'tombstone') check(tombstones.has(r.tombstone), `Unknown tombstone ${r.tombstone}`);
  }
  for (const e of data.examples) {
    check(sameValues(e.workflows, contract.examples[e.nativePath]?.workflows), `Semantic workflow mismatch ${e.nativePath}`);
    check(sameValues(e.capabilities, contract.examples[e.nativePath]?.capabilities), `Semantic workflow capabilities mismatch ${e.nativePath}`);
    check(e.workflows.length > 0 && e.workflows.every(w => workflowCapabilities[w]), `Missing executable workflow ${e.nativePath}`);
    check(local(e.browser.split('?')[0]), `Missing browser example ${e.nativePath}`);
    check(e.capabilities.length > 0 && e.capabilities.every(id => rowIds.has(id)), `Unknown workflow capability ${e.nativePath}`);
    const original = native.records.find(r => r.id === e.artifactId);
    check(original && JSON.stringify(e.source) === JSON.stringify(original.source), `Example provenance mismatch ${e.nativePath}`);
  }
  return errors;
}

export function auditHistoricalSources() {
  const records = inventory().records.filter(r => /^[0-9a-f]{40}$/.test(r.source.ref));
  const sources = [...new Map(records.map(r => [`${r.source.ref}:${r.source.path}`, r.source])).entries()];
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: sources.map(([key]) => key).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  let offset = 0;
  const errors = [];
  for (const [key, s] of sources) {
    const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString(), [object, kind, rawSize] = header.split(' ');
    if (!/^(blob|tree)$/.test(kind)) throw Error(`Missing immutable source: ${key}: ${header}`);
    const size = Number(rawSize), content = bytes.subarray(end + 1, end + 1 + size);
    if (object !== s.gitBlob) errors.push(`Git object mismatch ${key}`);
    if (sha256(kind === 'tree' ? object : content) !== s.sha256) errors.push(`Native source digest mismatch ${key}`);
    offset = end + size + 2;
  }
  if (errors.length) throw Error(errors.join('\n'));
  return { sources: sources.length, records: records.length, immutableObjectsVerified: true };
}

function generatePages(data) {
  const rowById = new Map(data.rows.map(r => [r.id, r]));
  const inv = inventory(), byId = new Map(inv.records.map(r => [r.id, r]));
  const routes = new Map(data.records.map(r => [r.artifactId, r]));
  const featurePath = `${packagePrefix}docs/features.md`;
  save(featurePath, '# Feature and evidence index\n\nGenerated by `npm run generate:w23`. Baseline status is the authoritative roadmap state, not a new runtime or browser support claim. Source links are shipped snapshots of the exact current examples/tests, pinned in [their provenance](evidence-sources/provenance.json). See [platform qualification](support-matrix.md), [migration](migration.md), and [coverage semantics](w23-evidence.md).\n\n| Row | Outcome | Baseline state | Browser API | Guide | Example | Evidence suites |\n|---|---|---|---|---|---|---|\n' + data.rows.map(r => `| ${r.id} | ${escape(r.title)} | ${r.baselineStatus} | ${r.apis.map(a => '`' + a + '`').join(', ')} | [Guide](${relativeLink(featurePath, r.guide)}) | [Source example](${currentSourceLink(r.example)}) | ${r.tests.map(p => `[${p.split('/').at(-1)}](${currentSourceLink(p)})`).join(', ')} |`).join('\n') + '\n');
  const migrationPath = `${packagePrefix}docs/python-api-map.md`;
  save(migrationPath, '# Python to TypeScript API map\n\nGenerated from all 220 final package-root exports. These are outcome migrations, not aliases or signature compatibility. Public definitions and scene methods are individually indexed in [the coverage ledger](migration-coverage.json). Browser values use typed arrays, asynchronous sources and Blobs. See [the migration guide](migration.md) for complete examples.\n\n| Native export | Capability | TypeScript entry points | Guide | Immutable contract |\n|---|---|---|---|---|\n' + inv.records.filter(r => r.kind === 'package-root-export').sort((a,b) => a.name.localeCompare(b.name)).map(r => {
    const row = rowById.get(routes.get(r.id).row), migration = data.pythonExports.find(e => e.native === r.name);
    return `| \`${r.name}\` | ${row.id} | ${migration.apis.map(a => '`' + a + '`').join(', ') || 'npm package version metadata'} (${migration.kind}). ${escape(migration.note)} | [Guide](${relativeLink(migrationPath, row.guide)}) | [Source](${sourceLink(r)}) |`;
  }).join('\n') + '\n');
  const examplePath = `${packagePrefix}docs/examples.md`;
  save(examplePath, '# Native example migrations\n\nAll 54 final example assets have an ordered browser pipeline. Each example executes its own data, analysis, rendering and export stages; results are not borrowed from an unrelated global run. Native numerical helpers supply independent controls for regional analysis ports. Offline inputs replace large network datasets; [the evidence guide](w23-evidence.md) describes the conversions, diagnostics and verification. Individual viewers retain their controls. Pro operations require a valid license and unavailable codecs are reported without claiming execution.\n\n[Open the runnable gallery](../examples/migration/index.html). Serve the installed package over HTTP on localhost or HTTPS.\n\n| Original example | Browser workflow | Capabilities | Native provenance |\n|---|---|---|---|\n' + data.examples.map(e => `| ${escape(e.nativePath)} | [${e.workflows.join(', ')}](${relativeLink(examplePath, e.browser)}) | ${e.capabilities.join(', ')} | [Source](${sourceLink({source:e.source})}) |`).join('\n') + '\n');
  const docsPath = `${packagePrefix}docs/native-documentation.md`;
  const docs = inv.records.filter(r => r.kind === 'native-doc-asset');
  save(docsPath, '# Native documentation migrations\n\nAll 88 documentation assets, including 53 Markdown/RST pages, retain immutable source provenance and a current browser destination. Headings/features are individually routed in the coverage ledger. Historical pictures describe native output; they are not browser goldens or evidence of current visual parity. Build files retain source references because npm replaces Sphinx delivery.\n\n| Original asset | Browser destination | Historical asset |\n|---|---|---|\n' + docs.map(r => {
    const row = rowById.get(routes.get(r.id).row), asset = `${packagePrefix}docs/native-assets/${r.source.path.slice(5)}`;
    return `| [${r.source.path}](${sourceLink(r)}) | [${row.id}: ${escape(row.title)}](${relativeLink(docsPath, row.guide)}) | ${existsSync(join(root, asset)) ? `[Preserved native illustration](${relativeLink(docsPath, asset)})` : 'Text/build source linked at pinned commit'} |`;
  }).join('\n') + '\n');
  saveJson(`${packagePrefix}examples/migration/catalog.json`, data.examples.map(({ nativePath, workflows, capabilities, source, adaptation }) => ({ name: nativePath.split('/').at(-1), nativePath, workflows, capabilities, source, adaptation })));
  const counts = Object.fromEntries([...new Set(inv.records.map(r => r.kind))].map(kind => [kind, inv.records.filter(r => r.kind === kind).length]));
  const routed = new Set(data.records.filter(r => r.row && (r.evidenceKind !== 'tombstone' || r.tombstone)).map(r => r.artifactId));
  const originalMappings = new Map(baseline().mappings.map(m => [m.artifactId,m]));
  saveJson('docs/parity/w23-coverage-report.json', { schemaVersion: 1, coverageMeaning: data.scope, counts, rows: data.rows.length, tombstones: data.tombstones.length, records: data.records.length, unmapped: inv.records.filter(r => !routed.has(r.id)).map(r => r.id), testSuites: data.tests.length,
    testDefinitionsAre: 'Individually routed to capability evidence, not assertions of one-for-one test translation or execution.',
    corrections: data.records.filter(r => { const original = originalMappings.get(r.artifactId); return r.row !== original?.capabilityId || (r.tombstone && !original?.targetId.endsWith(':' + r.tombstone)); }).map(r => ({...r, source: byId.get(r.artifactId).qualifiedName})) });
}

export function restoreDocumentationAssets() {
  for (const r of inventory().records.filter(r => r.kind === 'native-doc-asset' && /\.(png|svg|jpg|jpeg)$/i.test(r.source.path)))
    save(`${packagePrefix}docs/native-assets/${r.source.path.slice(5)}`, git(['show', `${r.source.ref}:${r.source.path}`]));
}
function restoreEvidenceSources(data) {
  const files=[...new Set([...data.rows.flatMap(r=>[r.example,...r.tests]),...['generate-w05-camera-fixture.py','generate-w06-aov-fixture.py','generate-w23-goldens.py','generate-w23-application-fixtures.py','capture-w23-dem-inputs.py','w23_regional_fixtures.py'].map(name=>packagePrefix+'scripts/'+name),...['tests/playwright/w23_migration.spec.ts','tests/browser/w23-stage-observer.ts','tests/parity/w23-review-regressions.test.mjs'].map(name=>packagePrefix+name)])];
  for(const path of files)save(packagePrefix+'docs/'+currentSourceLink(path),text(path));
  saveJson(packagePrefix+'docs/evidence-sources/provenance.json',{generator:'scripts/w23-coverage.mjs',meaning:'Current browser evidence source snapshots, not native output goldens.',files:files.map(path=>({path,sha256:sha256(text(path)),snapshot:currentSourceLink(path)}))});
}
function generateGuideExamples() {
  const path=packagePrefix+'docs/migration.md', source=text(path);
  const snippets=[...source.matchAll(/^```ts checked\n([\s\S]*?)^```/gm)].map(m=>m[1]);
  if(snippets.length!==2)throw Error('Update the executable guide contract when adding checked examples');
  const ts=createRequire(join(root,packagePrefix,'package.json'))('typescript');
  const code=ts.transpileModule(snippets.join('\n').replace(/import\s*\{([^}]+)\}\s*from\s*['"]@forge3d\/web['"];?/g,'const {$1}=api;').replace(/export\s+/g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  save(packagePrefix+'examples/migration/guide-examples.js',`// Generated from docs/migration.md; source SHA-256 ${sha256(snippets.join('\n'))}\nexport async function executeGuideExamples(api,canvas){\n${code}\nconst snapshot=await terrainSnapshot(canvas),roundTrip=await pngRoundTrip();\nif(snapshot.size<100||roundTrip.size<20)throw Error('Documentation examples produced no PNG');\nconst pixels=(await api.pngToArray(snapshot)).data;let coverage=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(pixels[i+c]-pixels[c])))>2)coverage++;\nif(coverage<50)throw Error('Documentation snapshot contains only clear RGB');\nreturn {snapshotBytes:snapshot.size,roundTripBytes:roundTrip.size,snapshotCoverage:coverage};\n}\n`);
}
function restoreExampleInputs() {
  const ref = '1f4084af428dc699bdcd108b029736cb73903926', target = `${packagePrefix}examples/migration/`;
  save(target + 'sample-style.json', git(['show', `${ref}:examples/sample_style.json`]));
  const mapbox = git(['show', `${ref}:tests/fixtures/mapbox_streets_v8.json`]);
  save(`${packagePrefix}tests/fixtures/w23/mapbox_streets_v8.json`, mapbox);
  save(target + 'mapbox-streets-v8.json', mapbox);
  for (const name of ['terrain-single-tile.png', 'provenance.json']) {
    save(target + (name === 'provenance.json' ? 'single-tile-oracle.json' : name), readFileSync(join(root, packagePrefix, 'tests/golden/w23', name)));
  }
  for(const name of ['applications.json','applications-provenance.json'])save(target+name,readFileSync(join(root,packagePrefix,'tests/golden/w23',name)));
  const presets = Object.fromEntries(['baseline_no_vector_overlays.json', 'rainier_showcase.json'].map(name => [`presets/${name}`, JSON.parse(git(['show', `${ref}:examples/presets/${name}`]).toString('utf8'))]));
  saveJson(target + 'presets.json', presets);
  for (const name of ['autzen.laz', 'predictor.tif']) save(target + name, readFileSync(join(root, packagePrefix, 'tests/fixtures/w22', name)));
  for (const name of ['rainier-cog.tif', 'rainier-cog.json']) {const raw=readFileSync(join(root, packagePrefix, 'tests/golden/w08', name));save(target + name,name.endsWith('.json')?raw.toString('utf8').replace(/\r\n?/g,'\n'):raw);}
  saveJson(target + 'provenance.json', { nativeCommit: ref, sourceExamples: ['examples/sample_style.json', 'examples/presets/baseline_no_vector_overlays.json', 'examples/presets/rainier_showcase.json'],
    encodedInputs: '../../tests/fixtures/w22/manifest.json',
    derivedInputs:{'applications.json':'applications-provenance.json','terrain-single-tile.png':'single-tile-oracle.json','rainier-cog.tif':'rainier-cog.json'},
    terrain: 'Bundled mini DEM, COG stream, or bounded native analysis-oracle inputs; simple API-only cases use a seed-free 16x16 Gaussian.', overlay: 'Native bivariate/REM/travel/solar results become raster RGBA; API-only cases use an analytic 4x4 input.' });
}
export function generateCoverage({ check = false } = {}) {
  verifyGenerated = check;
  const data = createCoverage();
  restoreExampleInputs();
  restoreDocumentationAssets();
  restoreEvidenceSources(data);
  generateGuideExamples();
  const violations=validateCoverage(data);if(violations.length)throw Error('Cannot generate a valid coverage report:\n'+violations.join('\n'));
  generatePages(data);
  saveJson(manifestPath, data);
  saveJson(`${packagePrefix}docs/migration-coverage.json`, data);
  save(`${packagePrefix}docs/workflow-support.md`, '# Workflow support and tombstones\n\nGenerated by `npm run generate:w23`. Behavioral suites exist for every row; their presence does not certify execution or physical support. See [the feature index](features.md), [coverage semantics](w23-evidence.md) and [browser qualification](support-matrix.md).\n\n| Row | Required evidence outcome | Browser guide |\n|---|---|---|\n' + data.rows.map(r => `| ${r.id} | ${r.disposition} | [${escape(r.title)}](${relativeLink(`${packagePrefix}docs/workflow-support.md`, r.guide)}) |`).join('\n') + '\n\n## Historical and diagnostic dispositions\n\n| ID | Lifecycle | Disposition |\n|---|---|---|\n' + data.tombstones.map(t => `| ${t.id} | ${t.lifecycle} | ${escape(t.disposition)} |`).join('\n') + '\n');
  return data;
}
