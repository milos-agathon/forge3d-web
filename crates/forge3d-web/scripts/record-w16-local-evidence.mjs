import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateW16HostState } from './w16-host-state.mjs';

// Run after retained official soaks, before a test runner clears test-results.
// Preserve the historical/reviewer reports and bind current runtime bytes to
// the actual installed tarball, rather than a later documentation-only pack.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = readJson('docs/w16-local-evidence.json');
const conformance = readJson('test-results/w16-package-consumer.json');
// Historical checks describe their own run, not this newly measured package.
// Record only checks this consumer executed; bind other fresh gates separately.
evidence.previousChecks = { file: 'w16-local-evidence.json',
  statement: 'Historical gate counts are retained in the original report and are not fresh measurements for this batch.' };
evidence.checks = { installedPackage: { conformance: 'passed' }, api: 'passed as part of installed consumer' };
const runs = readdirSync(join(root, 'docs/w16-runs'))
  .filter(name => /^installed-(?:[0-9TZ]+-)?[1-3]\.json$/u.test(name)).sort()
  .map(name => ({ file: `w16-runs/${name}`, report: readJson(`docs/w16-runs/${name}`) }))
  .filter(({ report }) => report.packageSha256 === conformance.packageSha256);
assert(runs.length > 0, 'At least one complete retained run is required');
const batchId = runs.at(-1).report.batchId;
assert(/^[0-9TZ]+$/u.test(batchId ?? ''), 'A new batch with sampled host state is required');
const runtimeFile = `w16-runs/runtime-files-${batchId}.json`;
const conformanceFile = `w16-runs/conformance-${batchId}.json`;
const evidenceFile = `w16-runs/evidence-${batchId}.json`;
let installed;
for (const name of readdirSync(tmpdir()).filter(name => name.startsWith('forge3d-w16-consumer-'))) {
  const pack = join(tmpdir(), name, 'pack');
  try {
    if (readdirSync(pack).some(name => hash(readFileSync(join(pack, name))) === conformance.packageSha256))
      installed = join(tmpdir(), name, 'consumer/node_modules/@forge3d/web');
  } catch { /* Other temporary consumer directories may be incomplete. */ }
}
assert(installed, 'The observed installed tarball must still be available');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const bindings = [...files(join(root, 'dist')), ...files(join(root, 'assets'))].map(path => {
  const name = relative(root, path).replaceAll('\\', '/'), bytes = readFileSync(path);
  assert(bytes.equals(readFileSync(join(installed, name))), `${name} changed after verification`);
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
}).sort((a, b) => a.path.localeCompare(b.path));
const fixtureSha256 = hash(readFileSync(join(root, 'tests/fixtures/w16/copc-ept-tiles-v1.json')));
const cameraHarnessSha256 = hash(readFileSync(join(root, 'examples/w16-pointcloud.js')));
evidence.optimizedRuns = runs.map(({ file, report }) => {
  assert.equal(report.packageSha256, conformance.packageSha256);
  assert.equal(report.fixtureSha256, fixtureSha256);
  assert.equal(report.cameraHarnessSha256, cameraHarnessSha256);
  assert(report.durationMs >= 600000 && report.frames > 1000);
  assert.equal(report.keyframesVisited, 64);
  const hostCapture = validateW16HostState(report.hostState, { durationMs: report.durationMs,
    binding: { packageSha256: report.packageSha256, runIndex: report.runIndex, batchId: report.batchId,
      targetProfile: report.targetProfile, fixtureSha256, cameraHarnessSha256 } });
  const measuredPass = Number.isFinite(report.frameP95Ms) && report.frameP95Ms >= 0 &&
    report.frameP95Ms <= report.budgets.p95Ms && report.totalPoints === 1000000 &&
    report.selectionCount >= 32 && report.minPoints > 0 && report.minPoints < report.maxPoints &&
    report.maxPoints <= 300000 && report.coveredPixels > 150 &&
    Number.isFinite(report.maxCpuBytes) && report.maxCpuBytes > 0 &&
    report.maxCpuBytes <= report.budgets.cpuBudgetBytes &&
    Number.isFinite(report.stats.peakGpuBytes) && report.stats.peakGpuBytes > 0 &&
    report.stats.peakGpuBytes <= report.budgets.gpuBudgetBytes &&
    report.stats.peakGpuBytes <= report.stats.memoryBudgetBytes && report.disposed.gpuBytes === 0;
  return { file, sha256: hash(readFileSync(join(root, 'docs', file))),
    verifiedAt: report.verifiedAt, browserVersion: report.browserVersion,
    durationMs: report.durationMs, frames: report.frames, frameP95Ms: report.frameP95Ms,
    limitMs: report.budgets.p95Ms, measuredPass,
    selectionCount: report.selectionCount, keyframesVisited: report.keyframesVisited,
    maxCpuBytes: report.maxCpuBytes, peakGpuBytes: report.stats.peakGpuBytes,
    phases: report.phases, hostState: { ...hostCapture, startedAt: report.hostState.startedAt,
      endedAt: report.hostState.endedAt, sources: [...new Set(report.hostState.samples.map(sample => sample.gpu.source))] },
    concurrentTestsOrBuilds: false, referenceHardwareQualified: false };
});
const passed = evidence.optimizedRuns.every(run => run.measuredPass);
const previous = evidence.previousOptimizationEvidence
  ? readJson(`docs/${evidence.previousOptimizationEvidence.file}`) : undefined;
const runtimeSha256 = hash(Buffer.from(JSON.stringify(bindings)));
const previousFailure = previous?.optimizedRuns.some(run => !run.measuredPass);
const sameRuntime = previous?.runtimeBinding.sha256 === runtimeSha256;
const unresolvedVariation = passed && previousFailure && sameRuntime;
evidence.evidenceStatus = passed
  ? (unresolvedVariation
    ? 'Current local installed-package runs pass with unchanged runtime; earlier failure remains unexplained; hardware and security acceptance pending'
    : 'Current local installed-package conformance and performance verified; hardware and security acceptance pending')
  : 'Local performance failure remains after optimization; hardware and security acceptance pending';
evidence.openAcceptance = [
  ...(!passed ? ['Local discrete-target ten-minute p95 remains above 16.7 ms'] : []),
  ...(unresolvedVariation ? ['Unexplained local p95 variation with unchanged dist/asset bytes; earlier 18.3 ms failure remains valid'] : []),
  'FW-WIN-I12-01: INF-00 blocked', 'FW-LNX-NV-01: not provisioned', 'Mandatory laz-perf security review',
];
if (previous) evidence.performanceReproducibility = {
  previousEvidence: evidence.previousOptimizationEvidence.file,
  unchangedDistAndAssets: sameRuntime,
  previousFailure,
  explanationEstablished: false,
  statement: 'Current observations do not withdraw earlier failures or establish a performance fix. Current reports retain sampled host state; earlier reports cannot establish matching host conditions.',
};
evidence.checks.installedPackage.soak = passed ? 'passed in current batch' : 'failed';
evidence.checks.installedPackage.repeatRequest = {
  requested: Number(process.env.FORGE3D_W16_RUNS ?? runs.length), completed: runs.length,
  ...(!passed ? { aborted: 'First failing run stopped the strict acceptance harness' } : {}),
};
evidence.runtimeBinding = { packageSha256: conformance.packageSha256, fileCount: bindings.length,
  sha256: runtimeSha256, file: runtimeFile,
  fixtureSha256, cameraHarnessSha256,
  statement: 'Every current dist/asset file matches the measured installed tarball. Later documentation edits do not change these runtime bytes.' };
evidence.conformance = { file: conformanceFile, verifiedAt: conformance.verifiedAt,
  browserVersion: conformance.browserVersion, platform: conformance.platform,
  rangeFraction: conformance.ranges.fraction, tileCoverage: conformance.tileReferences.coverage,
  deviceLoss: conformance.rendering.lost, pageErrors: conformance.pageErrors,
  externalRequests: conformance.externalRequests };
// The full report repeats the entire fixture manifest twice. Retain observed
// hashes/counts and bind the full temporary JSON without shipping those copies.
const { manifest: ioManifest, ...io } = conformance.io;
const { manifest: workloadManifest, cameras, ...workload } = conformance.workload;
const compact = { ...conformance, io,
  workload: { ...workload, cameraRecords: cameras.length, camerasSha256: hash(Buffer.from(JSON.stringify(cameras))) },
  tileReferences: { coverage: conformance.tileReferences.coverage,
    actualSha256: hash(Buffer.from(JSON.stringify(conformance.tileReferences.actual))),
    expectedSha256: hash(Buffer.from(JSON.stringify(conformance.tileReferences.expected))) },
  fullTemporaryReportSha256: hash(readFileSync(join(root, 'test-results/w16-package-consumer.json'))),
  statement: 'Compact retained conformance report; exhaustive assertions passed before the soak. Repeated fixture manifests and selection arrays are represented by their hashes.' };
assert.equal(compact.tileReferences.actualSha256, compact.tileReferences.expectedSha256);
writeFileSync(join(root, 'docs', conformanceFile), JSON.stringify(compact, null, 2) + '\n', { flag: 'wx' });
evidence.conformance.sha256 = hash(readFileSync(join(root, 'docs', conformanceFile)));
writeFileSync(join(root, 'docs', runtimeFile), JSON.stringify(bindings, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(root, 'docs', evidenceFile), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ evidenceFile, runtimeBinding: evidence.runtimeBinding, runs: evidence.optimizedRuns.map(run =>
  ({ frames: run.frames, p95Ms: run.frameP95Ms, measuredPass: run.measuredPass })) }, null, 2));
