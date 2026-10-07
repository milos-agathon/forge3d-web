import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const base = new URL("../fixtures/w16/", import.meta.url),
  manifest = JSON.parse(
    readFileSync(new URL("copc-ept-tiles-v1.json", base), "utf8"),
  );
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
});
