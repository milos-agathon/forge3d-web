import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireFileHostLock } from "../src/host-lock.mjs";

test("exclusive host lock serializes every asset owned by one host", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-host-lock-"));
  try {
    const path = join(root, "FW-MAC-M2-01.lock");
    const first = acquireFileHostLock(path);
    assert.ok(first);
    assert.equal(acquireFileHostLock(path), null);
    first.release();
    const second = acquireFileHostLock(path);
    assert.ok(second);
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
