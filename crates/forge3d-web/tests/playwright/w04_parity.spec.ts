import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04ParityProbe: () => Promise<any>;
  }
}

const BRDF_MODELS = [
  "lambert",
  "phong",
  "blinn-phong",
  "oren-nayar",
  "cooktorrance-ggx",
  "cooktorrance-beckmann",
  "disney-principled",
  "ashikhmin-shirley",
  "ward",
  "toon",
  "minnaert",
  "subsurface",
  "hair",
];
const SHADOW_FILTERS = ["hard", "pcf", "pcss", "vsm", "evsm", "msm"];
const PACKED_SIZES = {
  packedLight: 112,
  packedMaterial: 64,
  lightingUniform: 32,
  materialUniform: 16,
  shadowUniform: 368,
  shadowDepthUniform: 64,
};

test("W04 golden parity: native terrain_pbr SSIM, contracts, recovery", async ({
  page,
  webgpuAvailability,
}, testInfo) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);

  const golden = readFileSync(
    fileURLToPath(new URL("../golden/w04-terrain-pbr-native.png", import.meta.url)),
  );
  expect(golden.byteLength).toBe(8167);
  expect(createHash("sha256").update(golden).digest("hex")).toBe(
    "3e0e344cf87b997924908b6fa14071fa108c18edecb0629259868af30775c908",
  );

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/examples/test-w04-parity.html");
  const result = await page.evaluate(() => window.__forge3dW04ParityProbe());

  const artifactDir = testInfo.outputDir;
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    `${artifactDir}/probe-result.json`,
    JSON.stringify(
      { ...result, actualPng: undefined, diffPng: undefined },
      undefined,
      2,
    ),
  );
  if (typeof result?.actualPng === "string") {
    writeFileSync(
      `${artifactDir}/actual.png`,
      Buffer.from(result.actualPng.split(",")[1], "base64"),
    );
  }
  if (typeof result?.diffPng === "string") {
    writeFileSync(
      `${artifactDir}/diff.png`,
      Buffer.from(result.diffPng.split(",")[1], "base64"),
    );
  }

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.selfEqual).toBe(true);
  expect(result.ssim).toBeGreaterThanOrEqual(0.98);
  expect(result.memory.currentBytes).toBeGreaterThan(0);
  expect(result.memory.peakBytes).toBeLessThanOrEqual(1 << 30);
  expect(result.memory.currentBytes).toBeLessThanOrEqual(1 << 30);
  expect(result.shadow.csmEnabled).toBe(true);
  expect(result.shadow.cascadeCount).toBe(3);
  expect(result.shadow.effectiveFilter).toBe("pcss");

  expect(result.brdfRoutes).toHaveLength(13);
  for (const [index, route] of result.brdfRoutes.entries()) {
    expect(route.model).toBe(BRDF_MODELS[index]);
    expect(route.effectiveModel.length).toBeGreaterThan(0);
    expect(["exact", "alias", "approximation"]).toContain(route.implementation);
  }

  for (const filter of SHADOW_FILTERS) {
    expect(result.shadowReports[filter].effectiveFilter).toBe(filter);
  }
  expect(result.csmRejection.code).toBe("INVALID_INPUT");
  expect(result.csmRejection.message).toContain(
    "csm is a cascade pipeline, not a shadow filter",
  );

  expect(result.textureContract.snapshot.baseColor).toBeDefined();
  expect(result.gltfChannels).toEqual({
    occlusion: 11,
    roughness: 128,
    metallic: 64,
  });
  expect(result.tangents.length).toBe(12);
  expect(result.ktx2Contract.code).toBe("INVALID_INPUT");

  expect(result.ibl.unprepared.effectiveMode).toBe("runtime-precompute");
  expect(result.ibl.first.effectiveMode).toBe("prepared-upload");
  expect(result.ibl.first.cacheHit).toBe(false);
  expect(result.ibl.second.cacheHit).toBe(true);
  expect(result.ibl.second.effectiveMode).toBe("prepared-upload");

  expect(result.recovery.status).toBe("ready");
  expect(result.recovery.generations).toBe(2);
  expect(result.recovery.byteEqual).toBe(true);
  expect(result.recovery.setSceneCalls).toBe(1);

  expect(result.packing).toEqual(PACKED_SIZES);
  expect(pageErrors).toEqual([]);
});
