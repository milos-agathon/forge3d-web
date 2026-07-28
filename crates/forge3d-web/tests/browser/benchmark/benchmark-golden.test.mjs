import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateBenchmarkV1,
  MANIFEST_SHA256,
  TERRAIN_SHA256,
  TRACE_SHA256,
} from "./generate-benchmark-v1.mjs";

const directory = dirname(fileURLToPath(import.meta.url));

test("benchmark v1 regenerates byte-for-byte with frozen hashes", () => {
  const generated = generateBenchmarkV1();
  const fixtures = {
    terrain: readFileSync(join(directory, "benchmark-terrain-v1.f32le")),
    trace: readFileSync(join(directory, "benchmark-trace-v1.json")),
    manifest: readFileSync(join(directory, "benchmark-manifest-v1.json")),
  };
  const expectedHashes = {
    terrain: TERRAIN_SHA256,
    trace: TRACE_SHA256,
    manifest: MANIFEST_SHA256,
  };

  for (const name of ["terrain", "trace", "manifest"]) {
    assert.deepEqual(fixtures[name], generated[name], `${name} bytes drifted`);
    assert.equal(
      createHash("sha256").update(fixtures[name]).digest("hex"),
      expectedHashes[name],
      `${name} SHA-256 drifted`,
    );
  }

  assert.equal(fixtures.terrain.byteLength, 1_048_576);
  assert.equal(fixtures.trace.at(-1), "}".charCodeAt(0), "trace has trailing bytes");
  assert.equal(
    fixtures.manifest.at(-1),
    "}".charCodeAt(0),
    "manifest has trailing bytes",
  );
});
