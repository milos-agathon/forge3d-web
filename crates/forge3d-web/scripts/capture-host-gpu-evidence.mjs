import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const matrixPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "hardware-matrix.json",
);

export function captureHostGpuEvidence({
  binding,
  platform,
  commandEvidence,
  matrix,
  capturedAt = new Date(),
}) {
  const host = matrix.hosts.find(({ assetId }) => assetId === binding.assetId);
  if (!host) {
    throw new Error(`asset is not a fixed browser-lab host: ${binding.assetId}`);
  }
  const expectedPlatform = {
    macOS: "darwin",
    Windows: "win32",
    Ubuntu: "linux",
  }[host.os.family];
  if (platform !== expectedPlatform) {
    throw new Error(`platform ${platform} does not match ${host.assetId}`);
  }
  const serialized = JSON.stringify(commandEvidence).toLowerCase();
  for (const token of expectedGpuTokens(host.assetId)) {
    if (!serialized.includes(token)) {
      throw new Error(`expected physical GPU token is absent: ${token}`);
    }
  }
  if (platform === "linux") {
    if (
      commandEvidence.sessionType !== "wayland" ||
      !commandEvidence.waylandDisplay ||
      !commandEvidence.loginctl
    ) {
      throw new Error("Linux GPU evidence requires loginctl and a headed Wayland session");
    }
    if (!commandEvidence.driver) {
      throw new Error("Linux GPU evidence requires installed driver data");
    }
    if (
      host.assetId === "FW-LNX-NV-01" &&
      !driverDateAtOrAfter(commandEvidence.driverDate, "2024-05-01")
    ) {
      throw new Error("NVIDIA driver is older than the May 2024 boundary");
    }
  }
  return {
    schemaVersion: 1,
    ...binding,
    platform,
    expectedGpu: host.gpu,
    expectedGpuPresent: true,
    headedSessionAvailable: true,
    commandEvidence,
    capturedAt: new Date(capturedAt).toISOString(),
  };
}

function expectedGpuTokens(assetId) {
  return {
    "FW-MAC-M2-01": ["apple m2"],
    "FW-WIN-I12-01": ["iris", "xe"],
    "FW-LNX-I12-01": ["intel", "iris"],
    "FW-LNX-NV-01": ["nvidia", "rtx 3070"],
  }[assetId];
}

function driverDateAtOrAfter(actual, minimum) {
  const actualTime = Date.parse(actual ?? "");
  return Number.isFinite(actualTime) && actualTime >= Date.parse(minimum);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function tryRun(command, args) {
  try {
    return run(command, args);
  } catch {
    return "";
  }
}

function liveEvidence(platform) {
  if (platform === "darwin") {
    return {
      systemProfiler: JSON.parse(
        run("system_profiler", ["SPDisplaysDataType", "-json"]),
      ),
    };
  }
  if (platform === "win32") {
    return {
      videoControllers: JSON.parse(
        run("powershell.exe", [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,Status | ConvertTo-Json -Compress",
        ]),
      ),
    };
  }
  const sessionId = process.env.XDG_SESSION_ID ?? "";
  return {
    lspci: run("lspci", ["-nnk"]),
    nvidiaSmi: tryRun("nvidia-smi", [
      "--query-gpu=name,driver_version",
      "--format=csv,noheader",
    ]),
    loginctl: run("loginctl", [
      "show-session",
      sessionId,
      "-p",
      "Type",
      "-p",
      "Active",
      "-p",
      "Remote",
    ]),
    sessionType: process.env.XDG_SESSION_TYPE ?? "",
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? "",
    driver: tryRun("glxinfo", ["-B"]) || tryRun("vulkaninfo", ["--summary"]),
    driverDate: process.env.FORGE3D_GPU_DRIVER_DATE ?? "",
  };
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = args.get("--output");
  const bindingPath = args.get("--binding");
  if (!outputPath || !bindingPath) {
    throw new Error("--output and --binding are required");
  }
  const matrix = JSON.parse(
    readFileSync(args.get("--matrix") ?? matrixPath, "utf8"),
  );
  const platform = args.get("--platform") ?? process.platform;
  const commandEvidence = args.get("--command-evidence")
    ? JSON.parse(readFileSync(args.get("--command-evidence"), "utf8"))
    : liveEvidence(platform);
  const record = captureHostGpuEvidence({
    binding: JSON.parse(readFileSync(bindingPath, "utf8")),
    platform,
    commandEvidence,
    matrix,
  });
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output: outputPath }));
}
