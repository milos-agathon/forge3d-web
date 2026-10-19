// Run after the clean installed-package gate. Capture current evidence without
// inheriting the verdict or input digests from an earlier implementation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),prefix='crates/forge3d-web/';
const read=path=>readFileSync(resolve(root,path)),json=path=>JSON.parse(read(path));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const unitLog=read(prefix+'test-results/w23-review2-unit.log').toString();
const unitMatch=/Tests\s+(\d+) passed \((\d+)\)/.exec(unitLog),unitFiles=/Test Files\s+(\d+) passed \((\d+)\)/.exec(unitLog);
assert(unitMatch&&unitFiles,'Missing complete unit summary');
assert.equal(unitMatch[1],unitMatch[2]);assert.equal(unitFiles[1],unitFiles[2]);
assert.equal(Number(unitMatch[1]),1960);
const installed=json(prefix+'test-results/w23-installed/consumer.json');
assert.equal(installed.exitCode,0);assert.equal(installed.revision,revision);
assert.equal(installed.sourceImplementationAvailable,false);
const coverage=json('docs/parity/w23-coverage-report.json'),assets=json('docs/parity/w23-assets.json');
assert.deepEqual(coverage.unmapped,[]);
const results=report=>report.suites.flatMap(function visit(s){return [...(s.specs??[]).flatMap(x=>x.tests.flatMap(t=>t.results.map(r=>({...r,title:x.title})))),...(s.suites??[]).flatMap(visit)];});
function lane(result){
  assert.equal(result.status,'passed',result.title);
  const attachment=name=>{const a=result.attachments.find(a=>a.name===name);assert(a,name);return a.body?JSON.parse(Buffer.from(a.body,'base64')):json(a.path);};
  const workflows=attachment('w23-workflows.json'),faults=attachment('w23-negative-controls.json'),events=attachment('w23-independent-stage-observations.json');
  assert.equal(workflows.examples.length,54);
  assert(workflows.examples.every(e=>e.status==='executed'));
  assert.equal(faults.controls.length,10);assert(faults.controls.every(c=>c.rejected));
  const regional=workflows.examples.flatMap(e=>e.steps.filter(s=>s.workflow==='application').map(s=>({name:e.name,source:s.result.source,inputs:s.result.inputSource,operations:s.result.operations})));
  assert.equal(regional.length,24);
  const materials=workflows.examples.flatMap(e=>e.steps.filter(s=>s.workflow==='materials').map(s=>({name:e.name,sceneShadowPixels:s.result.sceneShadowPixels,shadowControlPixels:s.result.shadowControlPixels})));
  assert(materials.every(m=>m.shadowControlPixels>8));
  const rigs=events.filter(e=>e.kind==='rig.bake'),taa=events.filter(e=>e.kind==='postfx.report');
  assert(rigs.length&&rigs.every(r=>r.clearance>=1.99));
  assert(taa.some(e=>e.report.historyValid&&e.report.historyFrames>=3));
  return {title:result.title,status:result.status,durationMs:result.duration,examples:54,regionalExamples:regional,
    negativeControls:faults.controls,guideExamples:faults.docs,materials,
    independentObservations:{total:events.length,kinds:events.reduce((m,e)=>(m[e.kind]=(m[e.kind]??0)+1,m),{}),
      minimumRigClearance:Math.min(...rigs.map(e=>e.clearance)),
      maximumTaaHistoryFrames:Math.max(...taa.map(e=>e.report.historyFrames??0))},
    evidenceDigests:Object.fromEntries(result.attachments.filter(a=>a.name.endsWith('.json')).map(a=>[a.name,sha(a.body?Buffer.from(a.body,'base64'):read(a.path))]))};
}
const browser=json(prefix+'test-results/w23-review2-browser.json');
assert.equal(browser.stats.expected,2);assert.equal(browser.stats.unexpected,0);
const lanes=results(browser).map(lane);
const installedBrowser=json(prefix+'test-results/w23-installed/playwright.json');
assert.equal(installedBrowser.stats.expected,1);assert.equal(installedBrowser.stats.unexpected,0);
const logs=['verify','parity','api','native-audit','semantic-audit','single-tile-oracle','regional-oracle','unit','unit-initial','unit-focused','package','example-build','installed'];
const logDigests=Object.fromEntries(logs.map(name=>[name,sha(read(prefix+`test-results/w23-review2-${name}.log`))]));
const record={schemaVersion:3,recordedAt:new Date().toISOString(),testedImplementationRevision:revision,
  scope:'W23 second-review corrections: original regional computations, independent execution evidence, semantic ownership and derivation provenance.',
  supersedes:{revision:'efba9305',reason:'Earlier green gates did not prove per-example regional computations or IBL/effects/rig execution, and accepted substring routes and storage-history-only provenance.'},
  environment:{platform:process.platform,architecture:process.arch,node:process.version,browserProject:'chromium-preflight',physicalBrowserQualification:false},
  coverage:{...coverage,corrections:coverage.corrections.length,coverageSha256:sha(read('docs/parity/w23-coverage.json')),
    assets:assets.assets.length,assetsSha256:sha(read('docs/parity/w23-assets.json')),
    nativeBytePreserved:assets.assets.filter(a=>a.origin==='native-byte-preserved').length,
    sourceSnapshots:assets.assets.filter(a=>a.role==='evidence-source-snapshot').length,
    derivationKinds:assets.assets.reduce((m,a)=>{if(a.derivation)m[a.derivation.kind]=(m[a.derivation.kind]??0)+1;return m;},{})},
  validation:{unit:{command:'npm run test:unit',files:Number(unitFiles[1]),passed:Number(unitMatch[1]),failed:0,
    earlierAttempt:'One w20-pdf-errors font-shaping case timed out at 5 seconds under the default parallel run. It passed alone in 305 ms; a fresh full default run passed all 1960 tests. PowerShell/npm swallowed attempted worker/reporter overrides; no timeout or test implementation was changed.'},
    commands:['npm run verify:w23','npm run verify:parity','npm run test:api','npm run test:package','npm run build:example',
      'python scripts/audit-w23-native.py','node scripts/audit-w23-semantics.mjs',
      'python scripts/generate-w23-goldens.py --check','python scripts/generate-w23-application-fixtures.py --check'],
    w23Cases:63,codeFencesCompiled:33,strictCompleteExamples:2,semanticRouteCorrectionsAgainstEfba9305:171,
    nativeOracle:{examples:24,operations:29,capturedOriginalDems:7,python:'3.13',numpy:'2.5.1',pillow:'12.2.0',scipy:'1.16.0',rasterio:'1.4.3'},
    sourceAndDist:{startedAt:browser.stats.startTime,lanes},installed:{...installed,lanes:results(installedBrowser).map(lane)},logDigests},
  integrity:{policy:assets.digestPolicy,migrationPrograms:'Checked asset manifest plus browser startup program/control-JSON verification. Erased-workflow interception must fail before ready.',
    routingLock:'Generated reviewed intent lock, not independent correctness proof; source-context expectations and review are checked separately.',
    nativeSourceAudit:'Independent Git-tree/Python-AST counts and source digest verification; historical test routes are capability evidence, not execution of all Python assertions.'},
  limitations:['Bounded offline workflows do not reproduce the full geographic publications or establish native GPU visual parity.',
    'W09 historical captures retain kernel hashes and parameters; the original authoring harness is not archived.',
    'Chromium preflight only. Physical browser/GPU and final functional/visual release qualification remain W24 work.']};
writeFileSync(resolve(root,'docs/parity/w23-verification.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({revision,unit:record.validation.unit,assets:record.coverage.assets,sourceAndDist:lanes.map(l=>l.status),installed:installed.exitCode}));
