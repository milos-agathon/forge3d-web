import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveW16PerformanceEvidence, readW16PerformanceHistory,
  replaceUnmeasuredW16Concurrency, sha256 } from './w16-local-evidence.mjs';

// Reporting correction only: no benchmark, conformance, or host capture runs.
const root = dirname(dirname(fileURLToPath(import.meta.url))), docsRoot = join(root, 'docs');
const files = ['w16-local-evidence.json', 'w16-oct09-evidence.json',
  'w16-runs/evidence-20261010T135319734Z.json', 'w16-runs/evidence-20261010T182246586Z.json',
  'w16-runs/evidence-20261010T203221986Z.json'];
const history = readW16PerformanceHistory(docsRoot);
const generatorSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
const helperSha256 = sha256(readFileSync(join(root, 'scripts/w16-local-evidence.mjs')));
mkdirSync(join(docsRoot, 'w16-runs/original-evidence'), { recursive: true });
for (const file of files) {
  const path = join(docsRoot, file), bytes = readFileSync(path), evidence = JSON.parse(bytes);
  const originalFile = `w16-runs/original-evidence/${file.split('/').at(-1)}`;
  if (!evidence.reportingCorrection) writeFileSync(join(docsRoot, originalFile), bytes, { flag: 'wx' });
  const original = readFileSync(join(docsRoot, originalFile));
  if (evidence.reportingCorrection) assert.equal(sha256(original), evidence.reportingCorrection.original.sha256);
  Object.assign(evidence, deriveW16PerformanceEvidence(evidence.optimizedRuns,
    { ...evidence.runtimeBinding, evidenceFile: file }, history));
  replaceUnmeasuredW16Concurrency(evidence);
  evidence.reportingCorrection = {
    kind: 'reporting-only correction; no new run',
    original: { file: originalFile, sha256: sha256(original), bytes: original.length },
    generator: { file: 'scripts/repair-w16-evidence-reporting.mjs', sha256: generatorSha256 },
    helper: { file: 'scripts/w16-local-evidence.mjs', sha256: helperSha256 },
    changedFields: ['evidenceStatus', 'openAcceptance', 'performanceReproducibility', 'concurrentTestsOrBuilds (all nested historical claims)'],
    statement: 'Original JSON bytes and every original field are preserved in the bound archive. Derived reporting now considers every retained matching-runtime run, including later contradictions to historical passes. Historical assertions about absent concurrent work lack measurement provenance and are marked unknown. No measured value, raw report, runtime binding, stdout hash, CI result or acceptance qualification was changed.',
  };
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(file);
}
