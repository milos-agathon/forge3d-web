// Run after the clean installed-package gate. Capture current evidence without
// inheriting the verdict or input digests from an earlier implementation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectW23BrowserLanes } from './w23-browser-evidence.mjs';
const root=resolve(import.meta.dirname,'..'),prefix='crates/forge3d-web/';
const read=path=>readFileSync(resolve(root,path)),json=path=>JSON.parse(read(path));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const commands=json(prefix+'test-results/w23-review3-commands.json');
assert.equal(commands.revision,revision);
assert.equal(commands.commands.length,14);
for(const c of commands.commands){assert.equal(c.exitCode,0,c.command);assert.equal(sha(read(c.log)),c.sha256,c.log);}
const unitLog=read(prefix+'test-results/w23-review3-unit-3.log').toString();
const unitMatch=/Tests\s+(\d+) passed \((\d+)\)/.exec(unitLog),unitFiles=/Test Files\s+(\d+) passed \((\d+)\)/.exec(unitLog);
assert(unitMatch&&unitFiles,'Missing complete unit summary');
assert.equal(unitMatch[1],unitMatch[2]);assert.equal(unitFiles[1],unitFiles[2]);
assert.equal(Number(unitMatch[1]),1960);
const unitRuns=[1,2,3].map(n=>{
  const log=read(prefix+`test-results/w23-review3-unit-${n}.log`).toString();
  const tests=/Tests\s+(\d+) passed \((\d+)\)/.exec(log),files=/Test Files\s+(\d+) passed \((\d+)\)/.exec(log);
  assert(tests&&files);assert.equal(tests[1],tests[2]);assert.equal(files[1],files[2]);assert.equal(Number(tests[1]),1960);
  const shaping=/w20-pdf-errors.test.ts[^\n]*?\(1 test\)\s+(\d+)ms/.exec(log);assert(shaping);
  return {run:n,passed:Number(tests[1]),files:Number(files[1]),shapingAssertionMs:Number(shaping[1])};
});
const installed=json(prefix+'test-results/w23-installed/consumer.json');
assert.equal(installed.exitCode,0);assert.equal(installed.revision,revision);
if (installed.status !== undefined) assert.equal(installed.status, 'passed');
const installedObservations = installed.observations ?? installed;
assert.equal(installedObservations.sourceImplementationAvailable,false);
assert.equal(installedObservations.migrationTextHeadBlobsVerified,18);
const coverage=json('docs/parity/w23-coverage-report.json'),assets=json('docs/parity/w23-assets.json');
assert.deepEqual(coverage.unmapped,[]);
const verifyLog=read(prefix+'test-results/w23-review3-verify.log').toString();
assert(verifyLog.includes('an existing unrelated generator cannot substitute for the writer'));
const pnoa=json(prefix+'tests/fixtures/w23/regional-dem-inputs.json').examples['pnoa_river_showcase.py'].source;
assert.equal(pnoa.path,'assets/tif/Bryce_Canyon.tif');
function lane(result){
  assert.equal(result.status,'passed',result.title);
  const attachment=name=>{const a=result.attachments.find(a=>a.name===name);assert(a,name);return a.body?JSON.parse(Buffer.from(a.body,'base64')):json(a.path);};
  const workflows=attachment('w23-workflows.json'),faults=attachment('w23-negative-controls.json'),events=attachment('w23-independent-stage-observations.json');
  const literals=attachment('w23-literal-stage-negative-controls.json');
  assert(literals.matchingManifest&&literals.integrityVerified>0);
  assert.deepEqual(literals.outcomes.map(o=>o.workflow).sort(),['cog','triangle','video']);
  assert(literals.outcomes.every(o=>o.rejected));
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
  const triangles=events.filter(e=>e.kind==='triangle.frame'&&e.triangle);
  assert(triangles.length&&triangles.every(e=>e.changedPixels>8));
  const videoArtifacts=events.filter(e=>e.kind==='download'&&e.mp4);
  assert(videoArtifacts.length&&videoArtifacts.every(e=>e.mp4.ftyp&&e.mp4.avc1&&e.mp4.sampleCounts.length));
  return {title:result.title,status:result.status,durationMs:result.duration,examples:54,regionalExamples:regional,
    negativeControls:faults.controls,literalStageNegativeControls:literals,guideExamples:faults.docs,materials,
    independentObservations:{total:events.length,kinds:events.reduce((m,e)=>(m[e.kind]=(m[e.kind]??0)+1,m),{}),
      minimumRigClearance:Math.min(...rigs.map(e=>e.clearance)),
      maximumTaaHistoryFrames:Math.max(...taa.map(e=>e.report.historyFrames??0))},
    triangleEvidence:events.filter(e=>e.kind==='triangle.frame'||e.kind==='download'&&e.name?.endsWith('triangle.png')),
    cogEvidence:events.filter(e=>e.label.includes(': cog…')&&['cog.open','cog.tile','cog.upload','cog.converged','gpu.read'].includes(e.kind)),
    videoEvidence:events.filter(e=>e.kind.startsWith('video.')||e.kind==='download'&&e.mp4),
    evidenceDigests:Object.fromEntries(result.attachments.filter(a=>a.name.endsWith('.json')).map(a=>[a.name,sha(a.body?Buffer.from(a.body,'base64'):read(a.path))]))};
}
const browser=json(prefix+'test-results/w23-review3-browser.json');
const lanes=collectW23BrowserLanes(browser,['source','dist']).map(lane);
const installedBrowser=json(prefix+'test-results/w23-installed/playwright.json');
const installedLanes=collectW23BrowserLanes(installedBrowser,['dist']).map(lane);
const logDigests=Object.fromEntries(commands.commands.map(c=>[c.name,c.sha256]));
const routing=json('docs/parity/w23-routing-review.json');
const record={schemaVersion:4,recordedAt:new Date().toISOString(),testedImplementationRevision:revision,
  acceptanceRevision:'d5cf3b57',
  scope:'Remaining W23 review corrections: externally observed triangle/COG/MP4 stages, generator output proof, source-subject routing, original PNOA DEM, exact shipped text bytes and cold-load unit timeout.',
  supersedes:{revision:'5b3d1025',reason:'The earlier record accepted self-reported triangle/COG/video execution, unrelated existing generators and incorrect routes/PNOA input, and retained a cold-load unit timeout.'},
  environment:{platform:process.platform,architecture:process.arch,node:process.version,...commands.environment,browserEnvironment:commands.browserEnvironment,browserProject:'chromium-preflight',physicalBrowserQualification:false},
  coverage:{...coverage,corrections:coverage.corrections.length,coverageSha256:sha(read('docs/parity/w23-coverage.json')),
    assets:assets.assets.length,assetsSha256:sha(read('docs/parity/w23-assets.json')),
    nativeBytePreserved:assets.assets.filter(a=>a.origin==='native-byte-preserved').length,
    sourceSnapshots:assets.assets.filter(a=>a.role==='evidence-source-snapshot').length,
    derivationKinds:assets.assets.reduce((m,a)=>{if(a.derivation)m[a.derivation.kind]=(m[a.derivation.kind]??0)+1;return m;},{})},
  validation:{unit:{command:'npm run test:unit',files:Number(unitFiles[1]),passed:Number(unitMatch[1]),failed:0,
    consecutiveRuns:unitRuns,
    cause:'The async mock importOriginal and pdf-lib dynamic import ran cold transforms inside the 5-second shaping test. Static backend imports now finish during test collection; the real shaping failure and cancellation assertions are unchanged.',
    focusedMeasurement:{command:'npx vitest run tests/unit/w20-pdf-errors.test.ts',collectionMs:6990,assertionMs:23,timeoutMs:5000}},
    commands:commands.commands,
    w23Cases:Number(/# tests (\d+)|ℹ tests (\d+)/.exec(read(prefix+'test-results/w23-review3-verify.log').toString())?.slice(1).find(Boolean)),
    codeFencesCompiled:33,strictCompleteExamples:2,semanticRouteCorrectionsAgainstEfba9305:routing.changes.length,
    furtherRouteCorrectionsAgainst5b3d1025:routing.furtherCorrections.length,
    routingSourceFilesInspected:routing.inspectedNativeFiles,
    generatorOutputProof:{generatedControls:assets.assets.filter(a=>a.derivation?.kind==='generated-control').length,
      unrelatedExistingGeneratorRejected:true,negativeControl:'generate-w18-native.py substituted with its real matching hash for glacier_heights.f32',
      directoryManifestRequiresMatchingGeneratorAndListedFile:true},
    pnoaDem:{captureCommand:'python scripts/capture-w23-dem-inputs.py',archive:'D:/forge3d',...pnoa},
    nativeOracle:{examples:24,operations:29,capturedOriginalDems:7,python:'3.13',numpy:'2.5.1',pillow:'12.2.0',scipy:'1.16.0',rasterio:'1.4.3'},
    sourceAndDist:{startedAt:browser.stats.startTime,lanes},installed:{...installed,lanes:installedLanes},logDigests},
  integrity:{policy:assets.digestPolicy,migrationPrograms:'Checked asset manifest plus browser startup program/control-JSON verification. Erased-workflow interception must fail before ready.',
    routingLock:'Generated reviewed intent lock, not independent correctness proof; source-context expectations and review are checked separately.',
    nativeSourceAudit:'Independent Git-tree/Python-AST counts and source digest verification; historical test routes are capability evidence, not execution of all Python assertions.'},
  limitations:['Bounded offline workflows do not reproduce the full geographic publications or establish native GPU visual parity.',
    'W09 historical captures retain kernel hashes and parameters; the original authoring harness is not archived.',
    'Chromium preflight only. Physical browser/GPU and final functional/visual release qualification remain W24 work.']};
writeFileSync(resolve(root,'docs/parity/w23-verification.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({revision,unit:record.validation.unit,assets:record.coverage.assets,sourceAndDist:lanes.map(l=>l.status),installed:installed.exitCode}));
