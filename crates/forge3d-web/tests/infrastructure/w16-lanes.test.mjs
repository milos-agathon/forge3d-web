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
const proof = { schemaVersion: 1, kind: 'forge3d-w16-traversal-v1', binding, soak: {
  targetProfile: 'reference-discrete', durationMs: 600001, frames: 30000, keyframesVisited: 64, totalPoints: 1000000,
  selectionCount: 64, minPoints: 10000, maxPoints: 299000, coveredPixels: 200,
  viewport: [1920, 1080], measurement: { coldStartIncluded: true,
    timedStages: ['layer.update (including fetch/decode misses)', 'render through onSubmittedWorkDone'] },
  frameP95Ms: 12, maxCpuBytes: 42000000, stats: { peakGpuBytes: 43000000, memoryBudgetBytes: 268435456 }, disposed: { gpuBytes: 0 },
}};
test('W16 failing, short, missing and wrong-package results cannot become passes', () => {
  assert.equal(validateW16Proof(proof, binding).referenceHardwareQualified, false);
  for (const mutate of [p => p.soak.frameP95Ms = 22.3, p => p.soak.durationMs = 60000,
    p => p.soak.frames = NaN, p => p.soak.maxCpuBytes = 2e9, p => p.soak.stats.peakGpuBytes = 4e9,
    p => p.binding.packageSha256 = 'c'.repeat(64), p => p.soak.keyframesVisited = 63, p => p.soak.disposed.gpuBytes = 100,
    p => p.soak.viewport = [960, 540], p => p.soak.measurement.coldStartIncluded = false]) {
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
