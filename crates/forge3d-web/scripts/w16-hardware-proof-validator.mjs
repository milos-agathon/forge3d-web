import { resolveW16Lane } from './w16-lanes.mjs';
import { validateW16HostState } from './w16-host-state.mjs';
export function validateW16Proof(proof, binding) {
  const lane = resolveW16Lane({ ...binding, required: true });
  if (!Number.isInteger(binding.runId) || binding.runId < 1 || !Number.isInteger(binding.jobId) || binding.jobId < 1 ||
      !/^[a-f0-9]{40}$/u.test(binding.commit ?? '') || !/^[a-f0-9]{64}$/u.test(binding.packageSha256 ?? ''))
    throw new Error('W16 run/job/package binding is incomplete');
  if (proof?.schemaVersion !== 1 || proof.kind !== 'forge3d-w16-traversal-v1') throw new Error('Missing W16 traversal proof');
  for (const key of ['lane', 'assetId', 'platform', 'runId', 'jobId', 'commit', 'packageSha256'])
    if (proof.binding?.[key] !== binding[key]) throw new Error(`W16 binding mismatch: ${key}`);
  const r = proof.soak;
  validateW16HostState(r?.hostState, { durationMs: r?.durationMs, binding: proof.binding });
  for (const value of [r?.durationMs, r?.frames, r?.keyframesVisited, r?.totalPoints, r?.selectionCount,
    r?.minPoints, r?.maxPoints, r?.coveredPixels, r?.stats?.memoryBudgetBytes])
    if (!Number.isFinite(value)) throw new Error('W16 measurement missing or non-finite');
  for (const [key, limit] of [['frameP95Ms', lane.p95Ms], ['maxCpuBytes', lane.cpuBudgetBytes]])
    if (!Number.isFinite(r?.[key]) || r[key] < 0 || r[key] > limit) throw new Error(`W16 failed ${key}`);
  if (r?.targetProfile !== lane.profile || r.durationMs < 600000 || !Number.isFinite(r.durationMs) ||
      r.frames <= 1000 || r.keyframesVisited !== 64 || r.totalPoints !== 1000000 || r.selectionCount < 32 ||
      !(r.minPoints > 0 && r.minPoints < r.maxPoints && r.maxPoints <= 300000) || r.coveredPixels <= 150 ||
      r.maxCpuBytes <= 0 || r.viewport?.[0] !== 1920 || r.viewport?.[1] !== 1080 ||
      r.measurement?.coldStartIncluded !== true ||
      !r.measurement.timedStages?.includes('layer.update (including fetch/decode misses)') ||
      !r.measurement.timedStages?.includes('render through onSubmittedWorkDone') ||
      !Number.isFinite(r.stats?.peakGpuBytes) || r.stats.peakGpuBytes <= 0 || r.stats.peakGpuBytes > lane.gpuBudgetBytes ||
      r.stats.peakGpuBytes > r.stats.memoryBudgetBytes || r.disposed?.gpuBytes !== 0)
    throw new Error('W16 traversal coverage, duration or GPU budget failed');
  return { profile: lane.profile, measuredPass: true, referenceHardwareQualified: false };
}
/** Qualification runs only in the existing finalizer with joined page/host attestation. */
export function qualifyW16Proof(proof, binding, attestation, inventory) {
  validateW16Proof(proof, binding);
  if (attestation?.result !== 'PASS' || attestation.required !== true ||
      attestation.host?.hostId !== binding.assetId || attestation.host.expectedGpuPresent !== true ||
      attestation.host.headedSessionAvailable !== true || attestation.page?.isFallbackAdapter !== false ||
      inventory?.assetId !== binding.assetId || inventory.platform !== binding.platform)
    throw new Error('W16 physical hardware attestation missing');
  for (const key of ['assetId', 'runId', 'jobId', 'commit', 'packageSha256'])
    if (attestation.binding?.[key] !== binding[key]) throw new Error(`W16 attestation mismatch: ${key}`);
  const commands = attestation.host.commandEvidence;
  if (binding.platform === 'linux') {
    if (inventory.osVersion !== '6.8.0-79-generic' || !(inventory.osBuild ?? '').includes('Ubuntu 24.04.3 LTS') ||
        !/RTX 3070[^\n]*,\s*580\.82\.09(?:\s|$)/u.test(commands?.nvidiaSmi ?? '') ||
        !/Vulkan/u.test(commands?.vulkan ?? '') || !/1\.4\.313/u.test(commands.vulkan))
      throw new Error('W16 differs from the pinned W00 Ubuntu/Vulkan profile');
  } else {
    const gpu = [commands?.videoControllers].flat().find(g => /Iris.*Xe/iu.test(g?.Name ?? ''));
    let os;
    try { os = JSON.parse(inventory.osBuild); } catch { throw new Error('W16 Windows inventory must contain observed build JSON'); }
    if (os.buildNumber !== '26200' || os.ubr !== 6584 || os.displayVersion !== '25H2' || os.editionId !== 'Professional' || gpu?.DriverVersion !== '32.0.101.6987')
      throw new Error('W16 differs from the pinned W00 Windows/Iris Xe profile');
  }
  return { profile: proof.soak.targetProfile, referenceHardwareQualified: true };
}
