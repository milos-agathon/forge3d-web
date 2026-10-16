import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { W16_LANES, resolveW16Lane } from '../../scripts/w16-lanes.mjs';
import { validateHardwareDispatch } from '../../scripts/hardware-orchestration.mjs';
import { validateHardwareMatrix } from '../../scripts/validate-hardware-matrix.mjs';
import { resolveLaneRuntime } from '../../scripts/browser-lane-runtime.mjs';
import { validateW16Proof, qualifyW16Proof } from '../../scripts/w16-hardware-proof-validator.mjs';
import { resolveFixtureResponse } from '../../scripts/serve-browser-fixture.mjs';
import { createAutomatedMatrixRecord, finalizeMatrixRecord } from '../../scripts/create-browser-matrix-record.mjs';
import { executeHardwareBrowserLane } from '../../scripts/browser-lane-runtime.mjs';
import { exactHostInventory } from './host-inventory-fixture.mjs';
import { captureW16HostSample, startW16HostStateCapture, captureW16Soak, validateW16HostState } from '../../scripts/w16-host-state.mjs';
const matrix = JSON.parse(readFileSync(new URL('hardware-matrix.json', import.meta.url)));
for (const [lane, expected] of Object.entries(W16_LANES)) {
  const inputs = { lane, assetId: expected.assetId, required: true, trustedSha: 'a'.repeat(40), packageRunId: '10', labReadinessRunId: '20' };
  test(`${lane} uses the existing exact-host promotion and headed Chrome runtime`, () => {
    assert.equal(validateHardwareDispatch(inputs, matrix).hostId, expected.assetId);
    assert.equal(resolveLaneRuntime({ ...inputs, platform: expected.platform }).profile, expected.profile);
    assert.throws(() => validateHardwareDispatch({ ...inputs, required: false }, matrix), /required:true/);
    assert.throws(() => validateHardwareDispatch({ ...inputs, assetId: 'FW-MAC-M2-01' }, matrix), /exact physical host/);
    assert.throws(() => validateHardwareDispatch({ ...inputs, labReadinessRunId: undefined }, matrix), /requires labReadinessRunId/);
    assert.throws(() => resolveW16Lane({ ...inputs, platform: 'darwin' }), /exact physical host/);
  });
}
test('W16 matrix remains pending and rejects reassignment to a different host', () => {
  validateHardwareMatrix(matrix);
  assert.throws(() => validateHardwareMatrix(matrix, { requireProvisioned: true }), /not provisioned/);
  const copy = structuredClone(matrix);
  copy.hosts[0].acceptanceLanes = ['w16-reference-discrete'];
  assert.throws(() => validateHardwareMatrix(copy), /exact single host/);
});
const binding = { lane: 'w16-reference-discrete', assetId: 'FW-LNX-NV-01', platform: 'linux', runId: 10, jobId: 20, commit: 'a'.repeat(40), packageSha256: 'b'.repeat(64) };
const observedHostSample = () => ({ startedAt: '2026-10-10T00:00:00.000Z', capturedAt: '2026-10-10T00:00:00.010Z',
  cpuLoad: { percent: 10, logicalCpus: 8, source: 'node-os-cpu-time-delta' },
  powerPlan: { available: true, stdout: 'performance' }, gpu: { source: 'nvidia-smi',
    gpu: { available: true, stdout: 'RTX 3070, P8, 210, 405, 1' }, processes: { available: true, stdout: 'Graphics process: chrome' } } });
function hostProof(b = binding) {
  return { schemaVersion: 1, kind: 'forge3d-w16-host-state-v1', binding: b, platform: b.platform,
    startedAt: '2026-10-10T00:00:00.000Z', endedAt: '2026-10-10T00:10:00.001Z',
    durationMs: 600001, intervalMs: 5000, maxObservedGapMs: 5000, sampleCount: 122,
    samples: Array.from({ length: 122 }, (_, index) => ({ ...observedHostSample(),
      elapsedMs: Math.min(index * 5000, 600001), completedElapsedMs: Math.min(index * 5000, 600001) })) };
}
const proof = { schemaVersion: 1, kind: 'forge3d-w16-traversal-v1', binding, soak: {
  targetProfile: 'reference-discrete', durationMs: 600001, frames: 30000, keyframesVisited: 64, totalPoints: 1000000,
  selectionCount: 64, minPoints: 10000, maxPoints: 299000, coveredPixels: 200,
  viewport: [1920, 1080], measurement: { coldStartIncluded: true,
    timedStages: ['layer.update (including fetch/decode misses)', 'render through onSubmittedWorkDone'] },
  frameP95Ms: 12, maxCpuBytes: 42000000, stats: { peakGpuBytes: 43000000, memoryBudgetBytes: 268435456 }, disposed: { gpuBytes: 0 },
  hostState: hostProof(),
}};
test('W16 failing, short, missing and wrong-package results cannot become passes', () => {
  assert.equal(validateW16Proof(proof, binding).referenceHardwareQualified, false);
  for (const mutate of [p => p.soak.frameP95Ms = 22.3, p => p.soak.durationMs = 60000,
    p => p.soak.frames = NaN, p => p.soak.maxCpuBytes = 2e9, p => p.soak.stats.peakGpuBytes = 4e9,
    p => p.binding.packageSha256 = 'c'.repeat(64), p => p.soak.keyframesVisited = 63, p => p.soak.disposed.gpuBytes = 100,
    p => p.soak.viewport = [960, 540], p => p.soak.measurement.coldStartIncluded = false,
    p => delete p.soak.hostState, p => p.soak.hostState.binding.packageSha256 = 'c'.repeat(64),
    p => p.soak.hostState.samples.splice(20, 3)]) {
    const p = structuredClone(proof); mutate(p); assert.throws(() => validateW16Proof(p, binding));
  }
  assert.throws(() => qualifyW16Proof(proof, binding, null, null), /hardware attestation/);
  const attestation = { result: 'PASS', required: true, binding, page: { isFallbackAdapter: false },
    host: { hostId: binding.assetId, expectedGpuPresent: true, headedSessionAvailable: true,
      commandEvidence: { nvidiaSmi: 'NVIDIA GeForce RTX 3070, 580.82.09', driver: 'OpenGL renderer', vulkan: 'Vulkan 1.4.313' } } };
  const inventory = { assetId: binding.assetId, platform: 'linux', osVersion: '6.8.0-79-generic', osBuild: 'Ubuntu 24.04.3 LTS' };
  assert.equal(qualifyW16Proof(proof, binding, attestation, inventory).referenceHardwareQualified, true);
  assert.throws(() => qualifyW16Proof(proof, binding, attestation, { ...inventory, osVersion: '6.8.0-80-generic' }), /pinned W00/);
  const missingVulkan = structuredClone(attestation);
  delete missingVulkan.host.commandEvidence.vulkan;
  assert.throws(() => qualifyW16Proof(proof, binding, missingVulkan, inventory), /pinned W00/);
});
test('the existing nonce-bound fixture server serves W16 modules and exact byte ranges', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge3d-w16-routes-'));
  mkdirSync(join(root, 'tests/fixtures/w16/workload-ept/ept-data'), { recursive: true });
  writeFileSync(join(root, 'tests/fixtures/w16/workload-ept/ept-data/0-0-0-0.bin'), Buffer.from([1, 2, 3, 4]));
  const basePath = '/runs/10/20/' + 'a'.repeat(32) + '/';
  const result = resolveFixtureResponse({ role: 'application', fixtureRoot: root,
    applicationHost: 'test.webgpu-ci.forge3d.dev', assetHost: 'assets-test.webgpu-ci.forge3d.dev', basePath,
    request: { host: 'test.webgpu-ci.forge3d.dev', method: 'GET', url: basePath + 'tests/fixtures/w16/workload-ept/ept-data/0-0-0-0.bin', range: 'bytes=1-2' } });
  assert.equal(result.status, 206); assert.deepEqual([...result.body], [2, 3]);
});

test('W16 Windows qualification requires the pinned Iris Xe driver and OS build', () => {
  const b = { ...binding, lane: 'w16-reference-integrated', assetId: 'FW-WIN-I12-01', platform: 'win32' };
  const p = structuredClone(proof);
  p.binding = b;
  p.soak.hostState.binding = b;
  p.soak.hostState.platform = b.platform;
  p.soak.targetProfile = 'reference-integrated';
  const inventory = { assetId: b.assetId, platform: b.platform,
    osBuild: JSON.stringify({ buildNumber: '26200', ubr: 6584, displayVersion: '25H2', editionId: 'Professional' }) };
  const attestation = { result: 'PASS', required: true, binding: b, page: { isFallbackAdapter: false },
    host: { hostId: b.assetId, expectedGpuPresent: true, headedSessionAvailable: true,
      commandEvidence: { videoControllers: { Name: 'Intel Iris Xe Graphics', DriverVersion: '32.0.101.6987' } } } };
  assert.equal(qualifyW16Proof(p, b, attestation, inventory).referenceHardwareQualified, true);
  const differentDriver = structuredClone(attestation);
  differentDriver.host.commandEvidence.videoControllers.DriverVersion = '32.0.101.9999';
  assert.throws(() => qualifyW16Proof(p, b, differentDriver, inventory), /pinned W00/);
  assert.throws(() => qualifyW16Proof(p, b, attestation, { ...inventory, osBuild: '{}' }), /pinned W00/);
});

test('W16 dry runtime and artifact finalization retain proof and reject a failing p95', async () => {
  const inventory = { ...exactHostInventory(matrix, binding.assetId),
    osVersion: '6.8.0-79-generic', osBuild: 'Ubuntu 24.04.3 LTS' };
  const adapter = { secureContext: true, deviceCreated: true, surfacePresented: true,
    presentedFrameLumaSamples: [0.1, 0.8], presentedFrameLumaDelta: 0.7,
    lumaChanged: true, isFallbackAdapter: false };
  let measured = structuredClone(proof), calls = 0;
  const directory = mkdtempSync(join(tmpdir(), 'forge3d-w16-dry-runtime-'));
  const request = { ...binding, hostId: binding.assetId, required: true, binding, inventory,
    route: { applicationUrl: 'https://test.webgpu-ci.forge3d.dev/runs/10/20/' + 'c'.repeat(32) + '/' },
    browserPolicy: { prohibitedLaunchArguments: [], tools: { playwright: '1.56.1' } },
    deviceMatrix: { devices: [] }, outputPath: join(directory, 'runtime.json'),
    dependencies: { openSession: async () => ({
      browser: { name: 'chrome', channel: 'stable', version: '150.0.0.0' }, driverVersion: '1.56.1',
      effectiveLaunchArguments: [], launchArgumentsObserved: true,
      launchArgumentSource: 'chromium-cdp-browser-command-line',
      runPage: async () => ({ adapter, assertions: { passed: true, supportAssertionsExecuted: true } }),
      runW16: async () => { calls++; return measured; }, close: async () => ({ ok: true }),
    }) },
  };
  await executeHardwareBrowserLane(request);
  const runtime = JSON.parse(readFileSync(request.outputPath, 'utf8'));
  assert.equal(calls, 1);
  assert.deepEqual(runtime.w16Proof, proof);
  measured = structuredClone(proof);
  measured.soak.frameP95Ms = 22.3;
  await assert.rejects(() => executeHardwareBrowserLane(request), /failed frameP95Ms/);
  const failed = JSON.parse(readFileSync(request.outputPath, 'utf8'));
  assert.equal(failed.result, 'FAIL');
  assert.equal(failed.w16Proof.soak.frameP95Ms, 22.3);
  assert.deepEqual(failed.w16Proof.soak.hostState, measured.soak.hostState);

  const labReadiness = { runId: 9, manifestSha256: '9'.repeat(64), labInfrastructureDigest: 'c'.repeat(64) };
  const promotion = { lane: binding.lane, mode: 'automated', hostId: binding.assetId, assetId: binding.assetId,
    trustedSha: binding.commit, packageRunId: 8, packageManifestSha256: 'd'.repeat(64),
    labInfrastructureDigest: labReadiness.labInfrastructureDigest, labReadiness };
  const attestation = { result: 'PASS', required: true, binding, page: adapter,
    host: { hostId: binding.assetId, expectedGpuPresent: true, headedSessionAvailable: true,
      commandEvidence: { nvidiaSmi: 'NVIDIA GeForce RTX 3070, 580.82.09', vulkan: 'Vulkan 1.4.313' } } };
  const source = createAutomatedMatrixRecord({ promotion, run: { id: 10, attempt: 1 }, hostInventory: inventory,
    attestation, evidence: { ...runtime, result: 'PASS', jobId: binding.jobId, trustedSha: binding.commit,
      packageSha256: binding.packageSha256, packageManifestSha256: promotion.packageManifestSha256 } });
  const finalization = { artifactId: 30, attestation: { verified: true, denySelfHostedRunners: true },
    selectedRun: { id: 10, attempt: 1, path: '.github/workflows/browser-hardware.yml' } };
  assert.equal(finalizeMatrixRecord({ source, ...finalization }).w16Qualification.referenceHardwareQualified, true);
  const changed = structuredClone(source);
  changed.w16Proof.soak.frameP95Ms = 22.3;
  assert.throws(() => finalizeMatrixRecord({ source: changed, ...finalization }), /failed frameP95Ms/);
});

test('W16 host capture measures actual gaps and rejects forged, incomplete or stale captures', () => {
  assert.equal(validateW16HostState(hostProof(), { durationMs: 600001, binding }).sampleCount, 122);
  for (const mutate of [h => h.samples.splice(10, 3), h => h.durationMs = 600000,
    h => h.samples[10].cpuLoad.percent = null, h => h.samples[10].gpu.processes.available = false,
    h => h.binding = { ...binding, jobId: 21 }, h => h.maxObservedGapMs = 1,
    h => h.samples[10].captureError = { message: 'probe timed out' }]) {
    const h = hostProof(); mutate(h);
    assert.throws(() => validateW16HostState(h, { durationMs: 600001, binding }));
  }
  const gap = hostProof();
  gap.samples.splice(10, 3);
  gap.sampleCount = gap.samples.length;
  gap.maxObservedGapMs = 20000;
  assert.throws(() => validateW16HostState(gap), /sample gap exceeds 10000/);
});

test('W16 NVIDIA samples include graphics processes and fallback never fabricates unsupported metrics', async () => {
  const commands = [];
  const nvidia = await captureW16HostSample({ platform: 'win32', runCommand: async (command, args) => {
    commands.push({ command, args });
    return { available: true, stdout: command === 'nvidia-smi' && args.length ? '0, gpu, RTX 3070, driver, P8, 210, 210, 405, 2, 1, 12, 9' : 'Graphics process: chrome' };
  } });
  assert.equal(nvidia.gpu.source, 'nvidia-smi');
  assert(commands.some(c => c.command === 'nvidia-smi' && c.args.length === 0));
  assert(commands.some(c => c.command === 'powercfg.exe'));
  const fallback = await captureW16HostSample({ platform: 'win32', runCommand: async (command) =>
    ({ available: command !== 'nvidia-smi', stdout: command === 'nvidia-smi' ? '' : 'observed Iris Xe GPU counters' }) });
  assert.equal(fallback.gpu.source, 'host-capture-fallback');
  assert.match(fallback.gpu.commandEvidence.videoControllers.stdout, /Iris Xe/);
  assert.match(fallback.gpu.performanceProbe.stdout, /GPU counters/);
  assert(fallback.gpu.unavailableMetrics.some(metric => metric.includes('P-state')));
});

test('W16 sampling spans the workload and retains host evidence when the workload throws', async () => {
  let elapsed = 0, cpu = 0, tick, cleared = false;
  const options = { binding, now: () => elapsed, wallNow: () => new Date(Date.parse('2026-10-10T00:00:00Z') + elapsed),
    readCpu: () => ({ idle: ++cpu * 90, total: cpu * 100 }),
    sample: async () => observedHostSample(), schedule: callback => { tick = callback; return 1; },
    unschedule: () => { cleared = true; } };
  const capture = await startW16HostStateCapture(options);
  elapsed = 5000; tick();
  elapsed = 9000;
  const host = await capture.stop();
  assert(cleared);
  assert.equal(host.samples[0].elapsedMs, 0);
  assert.equal(host.samples.at(-1).elapsedMs, 9000);
  validateW16HostState(host, { durationMs: 9000, binding: { jobId: binding.jobId } });
  await assert.rejects(() => captureW16Soak(async () => {
    elapsed += 1000; throw new Error('GPU failure');
  }, options), error => {
    assert.equal(error.w16Observation.soakError.message, 'GPU failure');
    assert.equal(error.w16Observation.hostState.samples.length, 2);
    return true;
  });
});
