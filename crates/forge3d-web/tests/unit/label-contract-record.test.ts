import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as api from "../../src-ts/index.js";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
describe("W13 native test inventory and public documentation ports", () => {
  it("maps every pinned native label definition to an existing browser outcome port", () => {
    const c = JSON.parse(read("docs/parity/w13-native-test-coverage.json"));
    expect(c.baseline).toBe("1f4084af428dc699bdcd108b029736cb73903926");
    expect(c.definitions.length).toBeGreaterThan(80);
    const nativeRoot = "crates/forge3d-web/tests/golden/w13/native";
    const files = [
      ...new Set(
        c.definitions.map((d: { nativeFile: string }) => d.nativeFile),
      ),
    ] as string[];
    expect(files.length).toBe(c.nativeTestFiles);
    expect(readdirSync(resolve(root, nativeRoot)).sort()).toEqual(
      files.map((file) => file.replaceAll("/", "__")).sort(),
    );
    const sources = new Map<string, Buffer>();
    for (const d of c.definitions) {
      if (!sources.has(d.nativeFile))
        sources.set(
          d.nativeFile,
          readFileSync(
            resolve(root, nativeRoot, d.nativeFile.replaceAll("/", "__")),
          ),
        );
      expect(
        createHash("sha256").update(sources.get(d.nativeFile)!).digest("hex"),
      ).toBe(d.nativeFileSha256);
      expect(d.ports.length).toBeGreaterThan(0);
      for (const p of d.ports) expect(existsSync(resolve(root, p))).toBe(true);
    }
  });
  it("documents the full public workflow, compiler reasons and truthful experimental boundaries", () => {
    const guide = read("crates/forge3d-web/docs/labels.md");
    for (const term of [
      "FontAtlas",
      "LabelLayer",
      "LabelPlan.compile",
      "KeepoutRegion",
      "PriorityClass",
      "toRenderPayload",
      "toExportPayload",
      "placeholder_fallback",
      "missing_glyphs",
      "label_rejection_summary",
      "experimental_feature",
      "typography controls",
      "layout metrics",
      "placement policy",
      "stable numeric ID",
      "raw IPC",
      "test-w13-labels.html",
    ])
      expect(guide.toLowerCase()).toContain(term.toLowerCase());
    for (const reason of api.LABEL_REJECTION_REASONS)
      expect(guide).toContain("`" + reason + "`");
    for (const phrase of [
      "curved labels are supported",
      "curved labels are production-ready",
      "terrain-elevated line labels are supported",
    ])
      expect(guide.toLowerCase()).not.toContain(phrase);
    for (const name of [
      "FontAtlas",
      "FontFallbackRange",
      "TypographySettings",
      "LabelLayer",
      "LabelManager",
      "LabelFlags",
      "LabelStyle",
      "LabelFeatureSource",
      "LabelPlan",
      "KeepoutRegion",
      "PriorityClass",
      "LabelCollisionIndex",
      "declutterLabels",
    ])
      expect(typeof api[name as keyof typeof api]).toBe("function");
  });
  it("ships runnable high-level workflows without raw transport helpers", () => {
    const page = read("crates/forge3d-web/examples/test-w13-labels.html");
    for (const term of [
      "addLabel",
      "addLineLabel",
      "addCallout",
      "setLabels",
      "clearLabels",
      "readRgba",
      "experimental_feature",
    ])
      if (term === "clearLabels" || term === "experimental_feature")
        expect(
          read("crates/forge3d-web/tests/playwright/w13_labels.spec.ts") +
            page +
            read("crates/forge3d-web/tests/unit/labels.test.ts"),
        ).toContain(term);
      else expect(page).toContain(term);
    expect(page).not.toContain("send_ipc");
    expect(page).not.toContain("viewer_ipc");
  });
});
