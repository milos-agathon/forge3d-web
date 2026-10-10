import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const base = new URL("../fixtures/w16/", import.meta.url),
  manifest = JSON.parse(
    readFileSync(new URL("copc-ept-tiles-v1.json", base), "utf8"),
  );
// This integrity audit reads every fixture; its timeout is a cold-storage
// allowance, separate from the W00 performance budgets and soak gates.
it("W16 fixtures and deepest native sources retain independent provenance", () => {
  expect(manifest.fixtureId).toBe("copc-ept-tiles-v1");
  expect(manifest.nativeSources).toHaveLength(21);
  for (const source of manifest.nativeSources) {
    expect(source.commit).toBe("bf8db93233e5158f6d226991fc5d230832c2d806");
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(source.fixture, base)))
        .digest("hex"),
    ).toBe(source.sha256);
  }
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.path, base));
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  expect(manifest.oracle).toEqual({ laspy: "2.7.0", lazrs: "0.8.2" });
  expect(manifest.autzen.count).toBe(110000);
  expect(manifest.copc.count).toBe(100000);
  expect(manifest.copcRoot.count).toBe(66272);
  expect(manifest.performance.durationMs).toBe(600000);
  expect(manifest.workloadEpt.topology.nodeCount).toBe(1865);
  expect(manifest.workloadEpt.topology.branchNodes).toBe(457);
  expect(manifest.workloadEpt.selectionCoverage.uniqueAdditiveSets).toBe(64);
  expect(manifest.workloadEpt.selectionCoverage.minCulledNodes).toBeGreaterThan(
    0,
  );
  expect(manifest.overviewCopc.count).toBe(200000);
  expect(manifest.overviewCopc.root.count).toBe(512);
  expect(manifest.overviewCopc.root.bounds).toEqual(
    manifest.overviewCopc.bounds,
  );
  expect(manifest.expandedTileCoverage.records).toBe(256);
  expect(manifest.expandedTileCoverage.nodesPerDocument).toBe(85);
  expect(manifest.expandedTileCoverage.uniqueSelections).toBeGreaterThanOrEqual(20);
}, 30_000);
