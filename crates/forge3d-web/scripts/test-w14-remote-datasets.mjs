// Explicit live integration gate: real default URLs, full bytes, no fixture routes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatasetRegistry } from "../dist/index.js";
import { fetchRemoteDatasetWithRetry } from "./remote-dataset-retry.mjs";

const registry = new DatasetRegistry({ cache: null });
const results = [];
const failures = [];
let status = "failed";
try {
  for (const name of registry.remote()) {
    const metadata = registry.info(name);
    const bytes = await fetchRemoteDatasetWithRetry(registry, name, {
      onFailure(failure) { failures.push(failure); console.error(JSON.stringify(failure)); },
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, metadata.sha256, name);
    assert.equal(bytes.byteLength, metadata.byteLength, name);
    const result = { name, url: registry.url(name).href, byteLength: bytes.byteLength, sha256 };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  assert.equal(results.length, 10);
  status = "passed";
} finally {
  registry.dispose();
  mkdirSync(new URL("../test-results/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../test-results/w14-remote-datasets.json", import.meta.url),
    JSON.stringify({ checkedAt: new Date().toISOString(), status, results, failures }, null, 2) + "\n");
}
