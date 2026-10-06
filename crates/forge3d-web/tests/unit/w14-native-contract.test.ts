import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as api from "../../src-ts/index.js";
const read = (path: string) =>
  readFileSync(new URL("../../../../" + path, import.meta.url));
const record = JSON.parse(
  read("docs/parity/w14-native-test-coverage.json").toString(),
);
describe("W14 native source and outcome inventory", () => {
  it("maps every exact native test definition to a named browser test", () => {
    expect(record.nativeTestFiles).toBe(3);
    expect(record.snapshots).toHaveLength(6);
    for (const s of record.snapshots)
      expect(
        createHash("sha256")
          .update(
            read(
              "crates/forge3d-web/tests/golden/w14/native/" +
                s.nativePath.replaceAll("/", "__"),
            ),
          )
          .digest("hex"),
      ).toBe(s.sha256);
    const files = [
      ...new Set(record.definitions.map((d: any) => d.nativeFile)),
    ] as string[];
    expect(files).toHaveLength(3);
    for (const file of files) {
      const source = read(
        "crates/forge3d-web/tests/golden/w14/native/" +
          file.replaceAll("/", "__"),
      );
      const actual = [...source.toString().matchAll(/^\s*def (test_\w+)\(/gm)]
        .map((m) => m[1])
        .sort();
      const mapped = record.definitions.filter(
        (d: any) => d.nativeFile === file,
      );
      expect(mapped.map((d: any) => d.definition).sort()).toEqual(actual);
      for (const d of mapped) {
        expect(createHash("sha256").update(source).digest("hex")).toBe(
          d.nativeFileSha256,
        );
        expect(d.ports.length).toBeGreaterThan(0);
        expect(d.adaptation).toBeTruthy();
        for (const p of d.ports)
          expect(read(p.file).toString()).toContain(p.test);
      }
    }
  });
  it("exports the public native-equivalent ESM CRS and dataset surface", () => {
    for (const name of [
      "CrsTransformer",
      "DatasetRegistry",
      "projAvailable",
      "crsToEpsg",
      "crsFromRasterMetadata",
      "crsFromGeoJson",
      "reprojectVectorLayer",
      "reprojectLabelFeatures",
      "decodeDatasetNpy",
    ])
      expect(typeof api[name as keyof typeof api]).toBe("function");
    expect("render_polygons" in api).toBe(false);
    expect("renderPolygons" in api).toBe(false);
    const guide = read("crates/forge3d-web/docs/crs-datasets.md").toString();
    for (const term of [
      "ONLY_BEST=YES",
      "ALLOW_BALLPARK=NO",
      "offline: true",
      "parseCrsFromWkt",
      "transformCoords",
      "reprojectGeometry",
      "DatasetRegistry",
      "sampleBoundaries",
      "miniDem",
      "dispose",
      "signal",
      "1e-7",
      "0.01 m",
    ])
      expect(guide).toContain(term);
  });
});
