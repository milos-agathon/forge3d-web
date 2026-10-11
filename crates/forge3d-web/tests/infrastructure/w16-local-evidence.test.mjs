import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deriveW16PerformanceEvidence, readW16PerformanceHistory, replaceUnmeasuredW16Concurrency,
  sha256, w16ConcurrencyProvenance, w16CpuSummary, w16MeasuredPass } from '../../scripts/w16-local-evidence.mjs';

const docsRoot = fileURLToPath(new URL('../../docs/', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const binding = { sha256: 'a'.repeat(64), evidenceFile: 'current.json' };
function run(file, frameP95Ms, runtimeSha256 = binding.sha256) {
  return { file, sha256: 'b'.repeat(64), evidenceFile: `${file}-evidence.json`, runtimeSha256,
    verifiedAt: file === 'old' ? '2026-10-10T10:00:00Z' : '2026-10-10T11:00:00Z',
    frameP95Ms, limitMs: 16.7, measuredPass: frameP95Ms <= 16.7,
    cpuPercent: { min: 10, max: 30, mean: 20, samples: 2, source: 'test' } };
}

test('a new passing batch finds a matching failure even when the manually chosen predecessor has other bytes', () => {
  const current = run('new', 10.5);
  const result = deriveW16PerformanceEvidence([current], binding,
    [run('manual-predecessor', 18.3, 'c'.repeat(64)), run('old', 33.7)]);
  assert.match(result.evidenceStatus, /failure remains unexplained/u);
  assert.match(result.openAcceptance.join(' '), /33\.7/u);
  assert.equal(result.performanceReproducibility.meanCpuPercent.current, 20);
  assert.equal(result.performanceReproducibility.matchingRuntimeRuns.length, 2);
});

test('a new failure stays failed and records variation with a previous pass', () => {
  const result = deriveW16PerformanceEvidence([run('new', 33.7)], binding, [run('old', 10)]);
  assert.match(result.evidenceStatus, /performance gate failed/u);
  assert.equal(result.performanceReproducibility.unresolvedVariation, true);
  assert.equal(result.performanceReproducibility.explanationEstablished, false);
});

test('a later retained same-runtime failure corrects an earlier passing summary without inventing a rerun', () => {
  const result = deriveW16PerformanceEvidence([run('old', 10)], binding, [run('new', 33.7)]);
  assert.match(result.evidenceStatus, /failure remains unexplained/u);
  assert.equal(result.performanceReproducibility.matchingRuntimeRuns[0].file, 'old');
  assert.match(result.performanceReproducibility.statement, /including later observations/u);
});

test('unrelated-runtime failures and duplicate historical references do not affect a current pass', () => {
  const current = run('new', 10);
  const result = deriveW16PerformanceEvidence([current], binding,
    [current, current, run('old', 33.7, 'c'.repeat(64))]);
  assert.match(result.evidenceStatus, /performance verified/u);
  assert.equal(result.performanceReproducibility.matchingRuntimeRuns.length, 1);
  assert.equal(result.performanceReproducibility.previousFailure, false);
  const noCpu = deriveW16PerformanceEvidence([{ ...current, cpuPercent: null }], binding, []);
  assert.equal(noCpu.performanceReproducibility.meanCpuPercent.current, null);
});

test('CPU means are computed from retained samples and no absence of concurrent work is inferred', () => {
  assert.deepEqual(w16CpuSummary({ hostState: { samples: [{ cpuLoad: { percent: 10 } }, { cpuLoad: { percent: 30 } }] } }),
    { min: 10, max: 30, mean: 20, samples: 2, source: 'retained hostState.samples[].cpuLoad.percent' });
  assert.equal(w16CpuSummary({}), null);
  assert.throws(() => w16CpuSummary({ hostState: { samples: [{ cpuLoad: { percent: null } }] } }), /measured host samples/u);
  assert.equal(w16ConcurrencyProvenance().status, 'unknown');
  const historical = { nested: [{ concurrentTestsOrBuilds: false }] };
  replaceUnmeasuredW16Concurrency(historical);
  assert.equal(historical.nested[0].concurrentTestsOrBuilds.status, 'unknown');
  assert.equal(historical.nested[0].concurrentTestsOrBuilds.legacyReportedValue, false);
});

test('retained run metrics and every correction reproduce from unchanged raw reports', () => {
  const history = readW16PerformanceHistory(docsRoot);
  assert(history.some(run => run.frameP95Ms > 33.6 && !run.measuredPass));
  for (const file of ['w16-local-evidence.json', 'w16-oct09-evidence.json',
    'w16-runs/evidence-20261010T135319734Z.json', 'w16-runs/evidence-20261010T182246586Z.json',
    'w16-runs/evidence-20261010T203221986Z.json']) {
    const evidence = JSON.parse(readFileSync(join(docsRoot, file), 'utf8'));
    const originalBytes = readFileSync(join(docsRoot, evidence.reportingCorrection.original.file));
    assert.equal(sha256(originalBytes), evidence.reportingCorrection.original.sha256);
    for (const source of ['generator', 'helper'])
      assert.equal(sha256(readFileSync(join(packageRoot, evidence.reportingCorrection[source].file))),
        evidence.reportingCorrection[source].sha256, `${file}: ${source} source binding`);
    const original = JSON.parse(originalBytes);
    assert.deepEqual(evidence.runtimeBinding, original.runtimeBinding);
    assert.deepEqual(evidence.conformance, original.conformance);
    assert.deepEqual(evidence.checks, original.checks);
    assert.deepEqual(evidence.optimizedRuns.map(({ concurrentTestsOrBuilds, ...measured }) => measured),
      original.optimizedRuns.map(({ concurrentTestsOrBuilds, ...measured }) => measured));
    const derived = deriveW16PerformanceEvidence(evidence.optimizedRuns, { ...evidence.runtimeBinding, evidenceFile: file }, history);
    for (const [key, value] of Object.entries(derived)) assert.deepEqual(evidence[key], value, `${file}: ${key}`);
  }
});

test('a blank, short, leaking or over-budget soak cannot become a measured pass', () => {
  const report = JSON.parse(readFileSync(join(docsRoot, 'w16-runs/installed-20261010T203221986Z-1.json'), 'utf8'));
  assert.equal(w16MeasuredPass(report), true);
  for (const change of [r => r.coveredPixels = 0, r => r.durationMs = 60000,
    r => r.disposed.gpuBytes = 1, r => r.frameP95Ms = 33.7, r => r.maxCpuBytes = Infinity]) {
    const failed = structuredClone(report); change(failed);
    assert.equal(w16MeasuredPass(failed), false);
  }
});

test('history discovery rejects changed raw bytes, runtime digests and invented pass summaries', () => {
  const fixture = fileURLToPath(new URL('../../docs/w16-runs/', import.meta.url));
  const original = JSON.parse(readFileSync(join(fixture, 'evidence-20261010T203221986Z.json'), 'utf8'));
  const docs = mkdtempSync(join(tmpdir(), 'forge3d-w16-evidence-test-'));
  mkdirSync(join(docs, 'w16-runs'));
  const evidencePath = join(docs, 'w16-runs/evidence-20261010T203221986Z.json');
  const raw = readFileSync(join(docsRoot, original.optimizedRuns[0].file));
  const runtime = readFileSync(join(docsRoot, original.runtimeBinding.file));
  const restore = () => {
    writeFileSync(evidencePath, JSON.stringify(original));
    writeFileSync(join(docs, original.optimizedRuns[0].file), raw);
    writeFileSync(join(docs, original.runtimeBinding.file), runtime);
  };
  restore();
  assert.equal(readW16PerformanceHistory(docs).length, 1);
  writeFileSync(join(docs, original.optimizedRuns[0].file), Buffer.concat([raw, Buffer.from(' ')]));
  assert.throws(() => readW16PerformanceHistory(docs), /report hash mismatch/u);
  restore();
  writeFileSync(join(docs, original.runtimeBinding.file), '[]');
  assert.throws(() => readW16PerformanceHistory(docs), /runtime digest mismatch/u);
  restore();
  const invented = structuredClone(original);
  invented.optimizedRuns[0].measuredPass = false;
  writeFileSync(evidencePath, JSON.stringify(invented));
  assert.throws(() => readW16PerformanceHistory(docs), /pass summary mismatch/u);
});
