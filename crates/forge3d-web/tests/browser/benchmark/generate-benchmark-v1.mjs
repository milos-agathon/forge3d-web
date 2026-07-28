import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCHMARK_ID = "forge3d-viewer-benchmark-v1";
export const TERRAIN_SHA256 =
  "f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6";
export const TRACE_SHA256 =
  "bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d";
export const MANIFEST_SHA256 =
  "17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));

export function generateBenchmarkV1() {
  const terrain = generateTerrain();
  const trace = Buffer.from(JSON.stringify(generateTrace()), "utf8");
  const manifest = Buffer.from(
    JSON.stringify({
      id: BENCHMARK_ID,
      canvasCssWidth: 320,
      canvasCssHeight: 320,
      devicePixelRatio: 2,
      backingWidth: 640,
      backingHeight: 640,
      terrain: "benchmark-terrain-v1.f32le",
      terrainSha256: TERRAIN_SHA256,
      trace: "benchmark-trace-v1.json",
      traceSha256: TRACE_SHA256,
      warmupSamples: 120,
      measurementSamples: 600,
      nominalSampleIntervalMs: 16.666666666666668,
      traceVersion: 1,
    }),
    "utf8",
  );

  return {
    terrain,
    trace,
    manifest,
    hashes: {
      terrain: sha256(terrain),
      trace: sha256(trace),
      manifest: sha256(manifest),
    },
  };
}

export function writeBenchmarkV1(directory = benchmarkDirectory) {
  const generated = generateBenchmarkV1();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "benchmark-terrain-v1.f32le"), generated.terrain);
  writeFileSync(join(directory, "benchmark-trace-v1.json"), generated.trace);
  writeFileSync(join(directory, "benchmark-manifest-v1.json"), generated.manifest);
  return generated;
}

function generateTerrain() {
  const width = 512;
  const height = 512;
  const bytes = Buffer.alloc(width * height * Float32Array.BYTES_PER_ELEMENT);
  let byteOffset = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base =
        511 - Math.max(Math.abs(2 * x - 511), Math.abs(2 * y - 511));
      const ridge = (Math.imul(x, 13) + Math.imul(y, 7)) & 31;
      const value = Math.fround((base + ridge) / 541);
      bytes.writeFloatLE(value, byteOffset);
      byteOffset += Float32Array.BYTES_PER_ELEMENT;
    }
  }

  return bytes;
}

function generateTrace() {
  const warmup = [];
  const measurement = [];

  for (let i = 0; i < 120; i += 1) {
    warmup.push(
      view([0, 0, 0], 272 / 100, (i * 6) / 10, 24 + (tri(i % 40) * 3) / 10),
    );
  }

  for (let j = 0; j < 200; j += 1) {
    measurement.push(
      view(
        [0, 0, 0],
        272 / 100,
        (720 + j * 6) / 10,
        24 + (tri(j % 40) * 3) / 10,
      ),
    );
  }

  for (let j = 200; j < 400; j += 1) {
    const k = j - 200;
    measurement.push(
      view([(k - 100) / 500, 0, (tri(k % 40) - 10) / 500], 272 / 100, 192, 24),
    );
  }

  for (let j = 400; j < 600; j += 1) {
    const k = j - 400;
    measurement.push(
      view([0, 0, 0], (172 + Math.abs(k - 100)) / 100, 192, 24),
    );
  }

  return {
    id: "forge3d-viewer-benchmark-trace-v1",
    warmup,
    measurement,
  };
}

function view(target, distance, yawDegrees, pitchDegrees) {
  return {
    target,
    distance,
    yawDegrees,
    pitchDegrees,
    fovYDegrees: 46,
    near: 0.01,
    far: 100,
  };
}

function tri(period) {
  return period <= 20 ? period : 40 - period;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = writeBenchmarkV1();
  const expected = {
    terrain: TERRAIN_SHA256,
    trace: TRACE_SHA256,
    manifest: MANIFEST_SHA256,
  };

  for (const [name, hash] of Object.entries(generated.hashes)) {
    if (hash !== expected[name]) {
      throw new Error(`${name} SHA-256 drifted: expected ${expected[name]}, got ${hash}`);
    }
  }
}
