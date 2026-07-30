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
  hostId = binding.assetId,
  platform,
  commandEvidence,
  inventory,
  matrix,
  capturedAt = new Date(),
}) {
  const host = matrix.hosts.find(({ assetId }) => assetId === hostId);
  if (!host) {
    throw new Error(`host is not a fixed browser-lab host: ${hostId}`);
  }
  const attachedAsset = matrix.assets?.find(
    ({ assetId }) => assetId === binding.assetId,
  );
  if (
    binding.assetId !== hostId &&
    (attachedAsset?.hostAssetId !== hostId ||
      !host.attachedAssetIds.includes(binding.assetId))
  ) {
    throw new Error("target asset is not attached to the authorization-bound host");
  }
  const expectedPlatform = {
    macOS: "darwin",
    Windows: "win32",
    Ubuntu: "linux",
  }[host.os.family];
  if (platform !== expectedPlatform) {
    throw new Error(`platform ${platform} does not match ${host.assetId}`);
  }
  if (
    inventory?.schemaVersion !== 1 ||
    inventory.assetId !== hostId ||
    inventory.platform !== platform ||
    inventory.headed !== true ||
    inventory.session?.interactive !== true ||
    inventory.session?.locked !== false ||
    inventory.session?.remote !== false ||
    typeof inventory.osBuild !== "string" ||
    inventory.osBuild.trim() === ""
  ) {
    throw new Error("host GPU evidence requires the same live headed inventory");
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
      !nvidiaDriverAtOrAfter(commandEvidence.nvidiaSmi, "555.42.02")
    ) {
      throw new Error("NVIDIA driver is older than the May 2024 boundary");
    }
  }
  return {
    schemaVersion: 1,
    ...binding,
    hostId,
    platform,
    expectedGpu: host.gpu,
    expectedGpuPresent: true,
    headedSessionAvailable: true,
    osBuild: inventory.osBuild,
    session: inventory.session,
    inventoryCapturedAt: inventory.capturedAt,
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

function nvidiaDriverAtOrAfter(evidence, minimum) {
  const match = String(evidence ?? "").match(
    /,\s*([0-9]+)\.([0-9]+)\.([0-9]+)/u,
  );
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const expected = minimum.split(".").map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return actual[index] > expected[index];
    }
  }
  return true;
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
      systemProfiler: sanitizeMacDisplayEvidence(
        JSON.parse(run("system_profiler", ["SPDisplaysDataType", "-json"])),
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
  };
}

export function sanitizeMacDisplayEvidence(record) {
  const allowed = new Set([
    "sppci_model",
    "sppci_vendor",
    "sppci_device_type",
    "sppci_bus",
    "spdisplays_metal",
    "spdisplays_vram",
    "spdisplays_vram_shared",
  ]);
  return {
    SPDisplaysDataType: (record.SPDisplaysDataType ?? []).map((gpu) =>
      Object.fromEntries(
        Object.entries(gpu).filter(
          ([key, value]) =>
            allowed.has(key) &&
            ["string", "number", "boolean"].includes(typeof value),
        ),
      ),
    ),
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
  const inventoryPath = args.get("--inventory");
  if (!outputPath || !bindingPath || !inventoryPath) {
    throw new Error("--output, --binding, and --inventory are required");
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
    hostId: args.get("--host-id"),
    platform,
    commandEvidence,
    inventory: JSON.parse(readFileSync(inventoryPath, "utf8")),
    matrix,
  });
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output: outputPath }));
}
