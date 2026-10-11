import { sha256 } from "./w17-fixture.js";
const plane = {
  v0: [-100, -100, 0],
  v1: [100, -100, 0],
  v2: [0, 100, 0],
  id: 42,
};
export async function runTraceFeatures(s) {
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice(),
    owned = [];
  const create = async (options, scene) => {
    const t = await s.PathTracer.create(
      { width: 24, height: 16, seed: 42, maxBounces: 2, ...options },
      { device },
    );
    owned.push(t);
    await t.setScene(scene);
    return t;
  };
  try {
    const lights = Array.from({ length: 50 }, (_, i) => ({
      position: [
        ((i % 5) - 2) * 1.5,
        ((Math.floor(i / 5) % 5) - 2) * 1.5,
        2 + (i % 7),
      ],
      intensity: i % 3 === 0 ? 200 : 2,
    }));
    const scene = {
      triangles: [plane],
      materials: [{ albedo: [0.5, 0.5, 0.5] }],
      lights,
      environment: [0, 0, 0],
    };
    const plain = await create({ maxBounces: 1 }, scene),
      ris = await create(
        {
          maxBounces: 1,
          restir: {
            initialCandidates: 32,
            temporalNeighbors: 3,
            spatialNeighbors: 4,
            spatialRadius: 3,
          },
        },
        scene,
      );
    const base = await plain.render({ spp: 1 }),
      first = await ris.render({ spp: 1 }),
      reused = await ris.render({ spp: 4 });
    // Exhaustive independent point-light sum at each pixel center.
    const reference = new Float32Array(24 * 16 * 3);
    for (let p = 0; p < 24 * 16; p++) {
      const x =
          ((((p % 24) + 0.5) / 24) * 2 - 1) * 5 * Math.tan(Math.PI / 8) * 1.5,
        y =
          (1 - ((Math.floor(p / 24) + 0.5) / 16) * 2) *
          5 *
          Math.tan(Math.PI / 8);
      let value = 0;
      for (const l of lights) {
        const dx = l.position[0] - x,
          dy = l.position[1] - y,
          z = l.position[2],
          d2 = dx * dx + dy * dy + z * z;
        value += (0.5 * l.intensity * z) / (Math.PI * d2 * Math.sqrt(d2));
      }
      reference.fill(value, p * 3, p * 3 + 3);
    }
    const mse = (r) =>
      r.color.reduce((a, v, i) => a + (v - reference[i]) ** 2, 0) /
      reference.length;
    const varianceReduction = 1 - mse(first) / mse(base),
      reuseChanged =
        (await sha256(first.color)) !== (await sha256(reused.color));
    const grid = new s.OnlineGuidingGrid(24, 16, 8),
      guided = await create({ guiding: grid }, scene),
      before = grid.snapshot();
    await guided.render({ spp: 4 });
    const after = grid.snapshot(),
      guidingUpdates = after.reduce(
        (n, v, i) => n + (v > before[i] ? 1 : 0),
        0,
      );
    const mediumScene = {
      triangles: [plane],
      materials: [{ albedo: [0, 0, 0], emission: [1, 1, 1] }],
      environment: [0, 0, 0],
      medium: {
        sigmaA: [0.2, 0.4, 0.6],
        sigmaS: [0, 0, 0],
        g: 0.2,
        bounds: { min: [-100, -100, 0], max: [100, 100, 2] },
      },
    };
    const volume = await create(
        {
          width: 16,
          height: 16,
          maxBounces: 2,
          camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 1 },
        },
        mediumScene,
      ),
      absorbed = await volume.render({ spp: 64 }),
      mean = [0, 0, 0];
    for (let p = 0; p < 256; p++)
      for (let c = 0; c < 3; c++) mean[c] += absorbed.color[p * 3 + c] / 256;
    const firefly = await create(
        { luminanceClamp: 2 },
        {
          triangles: [plane],
          materials: [{ emission: [1000, 1000, 1000], albedo: [0, 0, 0] }],
          environment: [0, 0, 0],
        },
      ),
      clamped = await firefly.render();
    const materials = [],
      materialHashes = [];
    for (const material of [
      { albedo: [0.7, 0.4, 0.2], metallic: 1, roughness: 0.25 },
      { albedo: [1, 1, 1], ior: 1.5 },
      {
        albedo: [0.7, 0.4, 0.2],
        metallic: 1,
        roughness: 0.25,
        ax: 0.1,
        ay: 0.7,
      },
    ]) {
      const sdf = s.SdfScene.singlePrimitive(
          s.SdfPrimitive.sphere([0, 0, 0], 1),
        ),
        mScene = {
          sdf,
          materials: [material],
          environment: [0.6, 0.7, 0.9],
          lights: [{ position: [2, 3, 4], intensity: 20 }],
        },
        a = await create({ engine: "megakernel", maxBounces: 6 }, mScene),
        b = await create({ engine: "wavefront", maxBounces: 6 }, mScene),
        ra = await a.render({ spp: 4 }),
        rb = await b.render({ spp: 4 });
      const hash = await sha256(ra.color);
      materialHashes.push(hash);
      const cpu = await create({ backend: "cpu", maxBounces: 6 }, mScene),
        rc = await cpu.render({ spp: 4 });
      let cpuError = 0;
      for (let i = 0; i < rc.color.length; i++)
        cpuError = Math.max(
          cpuError,
          Math.abs(rc.color[i] - ra.color[i]) /
            Math.max(1, Math.abs(rc.color[i])),
        );
      materials.push({
        same: hash === (await sha256(rb.color)),
        finite: ra.color.every(Number.isFinite),
        covered: ra.id.filter((x) => x !== 0).length,
        cpuRelativeError: cpuError,
        directMax: Math.max(...ra.direct),
      });
      sdf.dispose();
    }
    const disc = await create(
        {},
        {
          triangles: [plane],
          materials: [{ albedo: [0.5, 0.5, 0.5] }],
          environment: [0, 0, 0],
          lights: [
            {
              type: "disc",
              position: [0, 0, 3],
              normal: [0, 0, -1],
              radius: 1,
              intensity: 10,
            },
            {
              type: "directional",
              position: [0, 0, 0],
              direction: [0, 0, -1],
              intensity: 1,
            },
          ],
        },
      ),
      area = await disc.render({ spp: 4 });
    // A cached frame must restore the progressive state, including reservoirs.
    ris.enableSceneCache();
    await ris.render({ spp: 4 });
    await ris.render({ spp: 4 });
    let continued;
    for await (const u of ris.progressive()) {
      continued = u.result;
    }
    const fresh = await ris.render({ spp: 5 });
    let continuationMax = 0;
    for (let i = 0; i < fresh.color.length; i++)
      continuationMax = Math.max(
        continuationMax,
        Math.abs(fresh.color[i] - continued.color[i]),
      );
    grid.reset();
    guided.enableSceneCache();
    await guided.render({ spp: 4 });
    const cachedGuide = grid.snapshot();
    grid.reset();
    await guided.render({ spp: 4 });
    const guideRestored =
      (await sha256(grid.snapshot())) === (await sha256(cachedGuide));
    let guideContinued;
    for await (const u of guided.progressive()) guideContinued = u.result;
    grid.reset();
    const guideFresh = await guided.render({ spp: 5 }),
      guideContinuation =
        (await sha256(guideContinued.color)) ===
        (await sha256(guideFresh.color));
    grid.dispose();
    return {
      varianceReduction,
      baseMse: mse(base),
      risMse: mse(first),
      reuseMse: mse(reused),
      reuseChanged,
      guidingUpdates,
      guideRestored,
      guideContinuation,
      mediumMean: mean,
      mediumExpected: [Math.exp(-0.4), Math.exp(-0.8), Math.exp(-1.2)],
      clampMax: Math.max(...clamped.color),
      materials,
      anisotropyChangesImage: materialHashes[0] !== materialHashes[2],
      areaMean: area.color.reduce((a, b) => a + b) / area.color.length,
      continuationMax,
    };
  } finally {
    for (const t of owned) t.dispose();
    device.destroy();
  }
}
