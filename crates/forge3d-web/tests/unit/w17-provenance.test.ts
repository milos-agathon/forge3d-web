import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

it("W17 frozen native algorithms and shipped contracts retain exact bytes", async () => {
  const root = new URL("../fixtures/w17/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("trace-sdf-v1.json", root), "utf8"),
  );
  expect(manifest).toMatchObject({
    fixtureId: "trace-sdf-v1",
    triangles: 65536,
    sdfPrimitives: 128,
    rays: 1048576,
    seed: 1597463007,
    spp: [1, 4, 16, 64],
  });
  expect(manifest.nativeSources.length).toBeGreaterThan(70);
  for (let i = 0; i < manifest.nativeSources.length; i += 16) {
    await Promise.all(
      manifest.nativeSources.slice(i, i + 16).map(async (source: any) => {
        const bytes = await readFile(new URL(source.fixture, root));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          source.sha256,
        );
        expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
      }),
    );
  }
}, 30000);
