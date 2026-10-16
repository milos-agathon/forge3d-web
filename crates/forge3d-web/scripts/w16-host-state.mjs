import { execFile } from 'node:child_process';
import { cpus, platform as currentPlatform, release } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hostGpuProbeCommands, sanitizeMacDisplayEvidence } from './capture-host-gpu-evidence.mjs';

export const W16_HOST_SAMPLE_INTERVAL_MS = 5000;
export const W16_HOST_MAX_SAMPLE_GAP_MS = 10000;

function command(command, args) {
  return new Promise(resolve => execFile(command, args, {
    encoding: 'utf8', timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => resolve({ command, args, available: !error,
    stdout: stdout?.trim() ?? '', stderr: stderr?.trim() ?? '',
    ...(error ? { error: error.code ?? error.message } : {}) })));
}

function cpuTimes() {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

function linuxGpuCounters() {
  const counters = {};
  try {
    for (const card of readdirSync('/sys/class/drm').filter(name => /^card\d+$/u.test(name))) {
      for (const path of ['gt_cur_freq_mhz', 'gt_act_freq_mhz', 'device/gpu_busy_percent', 'device/power/runtime_status']) {
        try { counters[`${card}/${path}`] = readFileSync(join('/sys/class/drm', card, path), 'utf8').trim(); } catch { /* Probe is absent on some drivers. */ }
      }
    }
  } catch { /* Non-DRM host; missing metrics remain explicit below. */ }
  return counters;
}

/** Read-only, bounded commands. Probe errors are evidence, never zero readings. */
export async function captureW16HostSample({ platform = currentPlatform(), runCommand = command } = {}) {
  const startedAt = new Date().toISOString();
  const power = platform === 'win32' ? runCommand('powercfg.exe', ['/getactivescheme'])
    : platform === 'linux' ? runCommand('powerprofilesctl', ['get']) : runCommand('pmset', ['-g']);
  const gpu = await runCommand('nvidia-smi', [
    '--query-gpu=index,uuid,name,driver_version,pstate,clocks.current.graphics,clocks.current.sm,clocks.current.memory,utilization.gpu,utilization.memory,memory.used,power.draw',
    '--format=csv,noheader,nounits',
  ]);
  let gpuState;
  if (gpu.available && gpu.stdout) {
    const processes = await runCommand('nvidia-smi', []); // Includes graphics and compute users, unlike --query-compute-apps.
    gpuState = { source: 'nvidia-smi', fields: ['index', 'uuid', 'name', 'driverVersion', 'pState',
      'graphicsClockMHz', 'smClockMHz', 'memoryClockMHz', 'gpuUtilizationPercent', 'memoryUtilizationPercent',
      'memoryUsedMiB', 'powerDrawWatts'], readings: gpu.stdout.split(/\r?\n/u).map(row => row.split(',').map(value => value.trim())),
      gpu, processes };
  } else {
    const probeResults = Promise.all(hostGpuProbeCommands(platform).map(async ([key, cmd, args]) => [key, await runCommand(cmd, args)]));
    const performanceResult = platform === 'win32' ? runCommand('powershell.exe', ['-NoProfile', '-Command',
      '$engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage; $processes = Get-Process | Select-Object Id,ProcessName; @{ gpuEngines = @($engines); processes = @($processes) } | ConvertTo-Json -Depth 4 -Compress',
    ]) : runCommand(platform === 'darwin' ? 'ps' : 'lsof', platform === 'darwin' ? ['-axo', 'pid,comm,%cpu'] : ['+D', '/dev/dri']);
    const [probes, performanceProbe] = await Promise.all([probeResults, performanceResult]);
    if (platform === 'darwin') {
      for (const [key, probe] of probes) if (key === 'systemProfiler' && probe.available) {
        try { probe.stdout = JSON.stringify(sanitizeMacDisplayEvidence(JSON.parse(probe.stdout))); } catch { probe.available = false; }
      }
    }
    const counters = platform === 'linux' ? linuxGpuCounters() : {};
    gpuState = { source: 'host-capture-fallback', nvidiaProbe: gpu, commandEvidence: Object.fromEntries(probes),
      performanceProbe, counters, unavailableMetrics: ['P-state unavailable through the existing host probes',
        ...(!Object.keys(counters).some(key => /freq/u.test(key)) ? ['GPU clocks unavailable through the existing host probes'] : []),
        ...(platform !== 'win32' && !Object.keys(counters).some(key => /busy/u.test(key)) ? ['GPU utilization unavailable through the existing host probes'] : []),
        ...(platform === 'darwin' ? ['GPU attribution unavailable; host process list retained'] : [])] };
  }
  const powerPlan = await power;
  const powerFallback = !powerPlan.available && platform === 'linux'
    ? await runCommand('sh', ['-c', 'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor']) : undefined;
  return { startedAt, capturedAt: new Date().toISOString(), gpu: gpuState,
    powerPlan, ...(powerFallback ? { powerFallback } : {}) };
}

/** Begin before the workload and sample again after it, including thrown runs. */
export async function startW16HostStateCapture({ binding = {}, intervalMs = W16_HOST_SAMPLE_INTERVAL_MS,
  sample = captureW16HostSample, now = () => performance.now(), wallNow = () => new Date(),
  schedule = setInterval, unschedule = clearInterval, readCpu = cpuTimes } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > W16_HOST_MAX_SAMPLE_GAP_MS)
    throw new Error('W16 host sampling interval must be positive and at most 10000 ms');
  const started = now(), startedAt = wallNow().toISOString(), samples = [];
  let cpu = readCpu(), inflight, stopped = false;
  const takeSample = () => {
    if (inflight) return inflight;
    const elapsedMs = now() - started;
    inflight = Promise.resolve().then(() => sample()).catch(error => ({
      captureError: { name: error.name, message: error.message },
    })).then(observed => {
      const next = readCpu(), total = next.total - cpu.total;
      samples.push({ ...observed, elapsedMs, completedElapsedMs: now() - started,
        cpuLoad: { source: 'node-os-cpu-time-delta', logicalCpus: cpus().length,
          percent: total > 0 ? 100 * (1 - (next.idle - cpu.idle) / total) : null } });
      cpu = next;
    }).finally(() => { inflight = undefined; });
    return inflight;
  };
  const timer = schedule(() => { if (!stopped) void takeSample(); }, intervalMs);
  await takeSample();
  return { async stop() {
    if (stopped) throw new Error('W16 host capture was already stopped');
    stopped = true;
    unschedule(timer);
    if (inflight) await inflight;
    await takeSample();
    const durationMs = now() - started;
    const gaps = samples.slice(1).map((sample, index) => sample.elapsedMs - samples[index].elapsedMs);
    gaps.push(durationMs - samples.at(-1).elapsedMs);
    return { schemaVersion: 1, kind: 'forge3d-w16-host-state-v1', binding, platform: currentPlatform(),
      osRelease: release(), startedAt, endedAt: wallNow().toISOString(), durationMs, intervalMs,
      maxObservedGapMs: Math.max(...gaps), sampleCount: samples.length, samples };
  } };
}

export function validateW16HostState(host, { durationMs = 0, binding = {} } = {}) {
  if (host?.schemaVersion !== 1 || host.kind !== 'forge3d-w16-host-state-v1' ||
    !Number.isFinite(host.durationMs) || host.durationMs < durationMs ||
    !Number.isFinite(host.intervalMs) || host.intervalMs <= 0 || host.intervalMs > W16_HOST_MAX_SAMPLE_GAP_MS ||
    !Array.isArray(host.samples) || host.samples.length < 2 || host.sampleCount !== host.samples.length ||
    !Number.isFinite(Date.parse(host.startedAt)) || !Number.isFinite(Date.parse(host.endedAt)) ||
    Math.abs(Date.parse(host.endedAt) - Date.parse(host.startedAt) - host.durationMs) > 1000 ||
    (binding.platform && host.platform !== binding.platform))
    throw new Error('W16 host-state capture missing or incomplete');
  for (const [key, value] of Object.entries(binding)) if (host.binding?.[key] !== value)
    throw new Error(`W16 host-state binding mismatch: ${key}`);
  let previous = 0, maxGap = 0;
  for (const [index, sample] of host.samples.entries()) {
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < previous ||
      !Number.isFinite(sample.completedElapsedMs) || sample.completedElapsedMs < sample.elapsedMs ||
      sample.completedElapsedMs > host.durationMs || sample.captureError ||
      !Number.isFinite(sample.cpuLoad?.percent) || sample.cpuLoad.percent < 0 || sample.cpuLoad.percent > 100 ||
      !sample.powerPlan || !['nvidia-smi', 'host-capture-fallback'].includes(sample.gpu?.source))
      throw new Error(`W16 host-state sample incomplete: ${index}`);
    maxGap = Math.max(maxGap, sample.elapsedMs - previous);
    previous = sample.elapsedMs;
    if (sample.gpu.source === 'nvidia-smi' && (!sample.gpu.gpu?.available || !sample.gpu.gpu.stdout ||
      !sample.gpu.processes?.available || !sample.gpu.processes.stdout))
      throw new Error('W16 NVIDIA GPU state or process evidence missing');
    if (sample.gpu.source === 'host-capture-fallback' && (!sample.gpu.commandEvidence || !sample.gpu.performanceProbe || !Array.isArray(sample.gpu.unavailableMetrics)))
      throw new Error('W16 fallback GPU evidence missing');
  }
  maxGap = Math.max(maxGap, host.durationMs - previous);
  if (maxGap > W16_HOST_MAX_SAMPLE_GAP_MS || host.maxObservedGapMs !== maxGap)
    throw new Error(`W16 host-state sample gap exceeds 10000 ms or is misreported: ${maxGap}`);
  return { sampleCount: host.sampleCount, maxObservedGapMs: maxGap };
}

export async function captureW16Soak(operation, options) {
  const capture = await startW16HostStateCapture(options);
  let result;
  try {
    result = await operation();
  } catch (error) {
    const hostState = await capture.stop();
    error.w16Observation = { hostState, soakError: { name: error.name, message: error.message } };
    throw error;
  }
  return { ...result, hostState: await capture.stop() };
}
