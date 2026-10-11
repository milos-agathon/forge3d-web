import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function w16MeasuredPass(report) {
  return Number.isFinite(report.frameP95Ms) && report.frameP95Ms >= 0 &&
    report.frameP95Ms <= report.budgets?.p95Ms && report.durationMs >= 600000 &&
    report.frames > 1000 && report.keyframesVisited === 64 && report.totalPoints === 1000000 &&
    report.selectionCount >= 32 && report.minPoints > 0 && report.minPoints < report.maxPoints &&
    report.maxPoints <= 300000 && report.coveredPixels > 150 &&
    Number.isFinite(report.maxCpuBytes) && report.maxCpuBytes > 0 &&
    report.maxCpuBytes <= report.budgets.cpuBudgetBytes &&
    Number.isFinite(report.stats?.peakGpuBytes) && report.stats.peakGpuBytes > 0 &&
    report.stats.peakGpuBytes <= report.budgets.gpuBudgetBytes &&
    report.stats.peakGpuBytes <= report.stats.memoryBudgetBytes && report.disposed?.gpuBytes === 0;
}

export function w16CpuSummary(report) {
  const samples = report.hostState?.samples;
  if (!samples?.length) return null;
  const values = samples.map(sample => sample.cpuLoad?.percent);
  assert(values.every(value => Number.isFinite(value) && value >= 0 && value <= 100),
    'CPU summary requires measured host samples');
  return { min: Math.min(...values), max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length, samples: values.length,
    source: 'retained hostState.samples[].cpuLoad.percent' };
}

// GPU process tables and aggregate CPU percentages cannot prove the absence of
// all concurrent builds/tests. An operator attestation is a separate claim.
export function w16ConcurrencyProvenance() {
  return { status: 'unknown', source: 'not measured by the W16 host sampler',
    statement: 'Aggregate CPU load and GPU process tables do not establish whether other tests or builds ran.' };
}

/** Discover all retained summaries, rather than trusting one manually selected predecessor. */
export function readW16PerformanceHistory(docsRoot) {
  const files = [
    ...readdirSync(docsRoot).filter(file => /^w16-(?:local|oct\d+)-evidence\.json$/u.test(file)),
    ...readdirSync(join(docsRoot, 'w16-runs')).filter(file => /^evidence-[0-9TZ]+\.json$/u.test(file))
      .map(file => `w16-runs/${file}`),
  ].sort();
  return files.flatMap(evidenceFile => {
    const evidence = JSON.parse(readFileSync(join(docsRoot, evidenceFile), 'utf8'));
    if (!evidence.runtimeBinding || !Array.isArray(evidence.optimizedRuns)) return [];
    const bindings = JSON.parse(readFileSync(join(docsRoot, evidence.runtimeBinding.file), 'utf8'));
    assert.equal(sha256(Buffer.from(JSON.stringify(bindings))), evidence.runtimeBinding.sha256,
      `${evidenceFile}: runtime digest mismatch`);
    assert.equal(bindings.length, evidence.runtimeBinding.fileCount, `${evidenceFile}: runtime file count mismatch`);
    return evidence.optimizedRuns.map(run => {
      const bytes = readFileSync(join(docsRoot, run.file)), report = JSON.parse(bytes);
      assert.equal(sha256(bytes), run.sha256, `${run.file}: retained report hash mismatch`);
      assert.equal(report.frameP95Ms, run.frameP95Ms, `${run.file}: p95 summary mismatch`);
      assert.equal(w16MeasuredPass(report), run.measuredPass, `${run.file}: pass summary mismatch`);
      for (const key of ['fixtureSha256', 'cameraHarnessSha256'])
        assert.equal(report[key], evidence.runtimeBinding[key], `${run.file}: ${key} mismatch`);
      return { evidenceFile, file: run.file, sha256: run.sha256,
        runtimeSha256: evidence.runtimeBinding.sha256, verifiedAt: report.verifiedAt,
        frameP95Ms: report.frameP95Ms, limitMs: report.budgets.p95Ms,
        measuredPass: run.measuredPass, cpuPercent: w16CpuSummary(report) };
    });
  });
}

/** Deterministic derived fields; historical corrections may include later retained observations. */
export function deriveW16PerformanceEvidence(runs, runtimeBinding, history) {
  assert(runs.length > 0, 'Performance evidence requires at least one run');
  const currentFiles = new Set(runs.map(run => run.file));
  const retained = new Map(history.filter(run => run.runtimeSha256 === runtimeBinding.sha256)
    .map(run => [run.file, run]));
  for (const run of runs) {
    const previous = retained.get(run.file);
    retained.set(run.file, { evidenceFile: runtimeBinding.evidenceFile ?? previous?.evidenceFile,
      file: run.file, sha256: run.sha256, runtimeSha256: runtimeBinding.sha256,
      verifiedAt: run.verifiedAt, frameP95Ms: run.frameP95Ms, limitMs: run.limitMs,
      measuredPass: run.measuredPass,
      cpuPercent: run.cpuPercent ?? run.hostState?.cpuPercent ?? previous?.cpuPercent ?? null });
  }
  const observations = [...retained.values()].sort((a, b) =>
    a.verifiedAt.localeCompare(b.verifiedAt) || a.file.localeCompare(b.file));
  const others = observations.filter(run => !currentFiles.has(run.file));
  const failures = observations.filter(run => !run.measuredPass);
  const passes = observations.filter(run => run.measuredPass);
  const passed = runs.every(run => run.measuredPass);
  const unresolvedVariation = failures.length > 0 && passes.length > 0;
  const failed = failures.at(-1), passing = passes.filter(run => !currentFiles.has(run.file)).at(-1);
  const cpu = observations.filter(run => currentFiles.has(run.file)).map(run => run.cpuPercent).filter(Boolean);
  const totalSamples = cpu.reduce((sum, summary) => sum + summary.samples, 0);
  return {
    evidenceStatus: passed
      ? (unresolvedVariation
        ? 'Current local installed-package runs pass with unchanged runtime; retained failure remains unexplained; hardware and security acceptance pending'
        : 'Current local installed-package conformance and performance verified; hardware and security acceptance pending')
      : 'Local installed-package performance gate failed; retained failures remain valid; hardware and security acceptance pending',
    openAcceptance: [
      ...(!passed ? ['Current local ten-minute performance gate failed'] : []),
      ...(unresolvedVariation ? [`Unexplained local p95 variation with unchanged dist/asset bytes; retained failures at ${[...new Set(failures.map(run => Number(run.frameP95Ms.toFixed(1))))].join('/')} ms remain valid`] : []),
      'Independent laz-perf security sign-off; reviewer and date are unset',
      'FW-LNX-NV-01 w16-reference-discrete: not provisioned, no attested report',
      'FW-WIN-I12-01 w16-reference-integrated: INF-00 blocked, no attested report',
    ],
    performanceReproducibility: {
      runtimeSha256: runtimeBinding.sha256, unchangedDistAndAssets: others.length > 0,
      previousFailure: failures.some(run => !currentFiles.has(run.file)), unresolvedVariation,
      explanationEstablished: false,
      ...(failed ? { previousEvidence: failed.evidenceFile } : {}),
      ...(passing ? { previousPassingEvidence: passing.evidenceFile } : {}),
      meanCpuPercent: { current: totalSamples ? cpu.reduce((sum, summary) => sum + summary.mean * summary.samples, 0) / totalSamples : null,
        previousFailed: failed?.cpuPercent?.mean ?? null, previousPassing: passing?.cpuPercent?.mean ?? null },
      matchingRuntimeRuns: observations,
      statement: 'Derived from every retained report with matching dist/asset bytes, including later observations when correcting a historical summary. Passing observations do not withdraw failures, prove causation, or establish a performance fix. CPU means derive only from retained samples; null means unavailable.',
    },
  };
}

export function replaceUnmeasuredW16Concurrency(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'concurrentTestsOrBuilds' && typeof child === 'boolean')
      value[key] = { ...w16ConcurrencyProvenance(), legacyReportedValue: child,
        legacyProvenance: 'Historical assertion without recorded verification; original JSON is retained separately.' };
    else replaceUnmeasuredW16Concurrency(child);
  }
}
