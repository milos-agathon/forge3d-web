import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bindingKeys = ["runId", "jobId", "assetId", "commit", "packageSha256"];

export function joinAdapterAttestation(page, host, { required = true } = {}) {
  for (const key of bindingKeys) {
    if (page[key] !== host[key]) {
      throw new Error(`page/host attestation binding mismatch: ${key}`);
    }
  }
  if (page.secureContext !== true) {
    throw new Error("page-level WebGPU attestation requires a secure context");
  }
  if (!page.navigatorGpu || !page.deviceCreated || !page.surfaceCreated) {
    throw new Error("WebGPU adapter, device, and surface creation are required");
  }
  if (!hasMeasuredLumaPresentation(page)) {
    throw new Error("hardware attestation requires a luma-changing presented frame");
  }
  if (required) {
    if (!page.adapterInfoAvailable || typeof page.isFallbackAdapter !== "boolean") {
      throw new Error("ATTESTATION_UNAVAILABLE: fallback adapter boolean is required");
    }
    if (page.isFallbackAdapter) {
      throw new Error("software/fallback adapter is prohibited in required lanes");
    }
    if (!host.expectedGpuPresent || !host.headedSessionAvailable) {
      throw new Error("expected physical GPU and headed session are required");
    }
  }
  return {
    schemaVersion: 1,
    binding: Object.fromEntries(bindingKeys.map((key) => [key, page[key]])),
    required,
    result: required ? "PASS" : "PROBE",
    page,
    host,
  };
}

export function hasMeasuredLumaPresentation(page) {
  const samples = page?.presentedFrameLumaSamples;
  if (
    page?.surfacePresented !== true ||
    page?.lumaChanged !== true ||
    !Array.isArray(samples) ||
    samples.length !== 2 ||
    samples.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    ) ||
    !Number.isFinite(page.presentedFrameLumaDelta)
  ) {
    return false;
  }
  const measuredDelta = Math.abs(samples[1] - samples[0]);
  return (
    measuredDelta >= 0.25 &&
    Math.abs(page.presentedFrameLumaDelta - measuredDelta) <= 1e-9
  );
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
  const output = args.get("--output");
  if (!output || !args.get("--page") || !args.get("--host")) {
    throw new Error("--page, --host, and --output are required");
  }
  const pageInput = JSON.parse(readFileSync(args.get("--page"), "utf8"));
  const page = pageInput.adapter ?? pageInput;
  if (pageInput.adapter) {
    for (const key of bindingKeys) {
      if (pageInput[key] !== page[key]) {
        throw new Error(`browser/page attestation binding mismatch: ${key}`);
      }
    }
  }
  const record = joinAdapterAttestation(
    page,
    JSON.parse(readFileSync(args.get("--host"), "utf8")),
    { required: args.get("--required") !== "false" },
  );
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output }));
}
