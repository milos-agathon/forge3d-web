import { trackGpuBuffers } from "./w17-memory.js";
export async function runGuidingParity(s) {
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice(),
    tracers = [],
    grids = [],
    checkpoints = [];
  let boundary;
  const scene = {
    triangles: [
      { v0: [-100, -100, 0], v1: [100, -100, 0], v2: [0, 100, 0], id: 1 },
      {
        v0: [2, -100, 0],
        v1: [2, 100, 0],
        v2: [2, 100, 100],
        materialId: 1,
        id: 2,
      },
      {
        v0: [2, -100, 0],
        v1: [2, 100, 100],
        v2: [2, -100, 100],
        materialId: 1,
        id: 3,
      },
    ],
    materials: [
      { albedo: [1, 1, 1] },
      { albedo: [0, 0, 0], emission: [10, 10, 10] },
    ],
    environment: [0, 0, 0],
  };
  const error = (a, b) =>
    a.reduce(
      (m, v, i) => Math.max(m, Math.abs(v - b[i]) / Math.max(1, Math.abs(v))),
      0,
    );
  try {
    for (const [seed, fovY] of [
      [42, 45],
      [1597463007, 60],
      [118605492, 45],
    ]) {
      const group = [];
      for (const backend of ["cpu", "megakernel", "wavefront"]) {
        const grid = new s.OnlineGuidingGrid(32, 24, 8);
        // Pixel 400's seventh xorshift draw is 0.9464285969734192: exactly
        // the f32 CDF boundary after bin 6 for these previously trained weights.
        if (seed === 118605492) {
          const weights = grid.snapshot();
          weights.set([1, 10, 1, 9, 1, 1, 4, 1], 400 * 8);
          grid.restore(weights);
        }
        grids.push(grid);
        const t = await s.PathTracer.create(
          {
            width: 32,
            height: 24,
            seed,
            maxBounces: 3,
            backend: backend === "cpu" ? "cpu" : "webgpu",
            engine: backend === "cpu" ? "megakernel" : backend,
            camera: { origin: [0, 0, 1], target: [0, 0, 0], fovY },
            guiding: grid,
          },
          { device },
        );
        tracers.push(t);
        await t.setScene(scene);
        group.push({ t, grid });
      }
      for (let spp = 1; spp <= 32; spp++) {
        const result = [];
        for (const { t } of group) result.push(await t.render({ spp: 1 }));
        if (seed === 118605492 && spp === 1) {
          const before = [1, 10, 1, 9, 1, 1, 4, 1];
          const changed = (grid) =>
            Array.from(grid.snapshot().slice(400 * 8, 401 * 8)).flatMap(
              (w, bin) => (w !== before[bin] ? [bin] : []),
            );
          boundary = {
            pixel: 400,
            u: 0.9464285969734192,
            cpuBins: changed(group[0].grid),
            gpuBins: changed(group[1].grid),
          };
        }
        checkpoints.push({
          seed,
          fovY,
          spp,
          color: error(result[0].color, result[1].color),
          weights: error(group[0].grid.snapshot(), group[1].grid.snapshot()),
          engines: error(result[1].color, result[2].color),
          engineWeights: error(
            group[1].grid.snapshot(),
            group[2].grid.snapshot(),
          ),
          covered: result[1].id.filter((id) => id > 0).length,
          trained: group[1].grid.snapshot().filter((weight) => weight > 1)
            .length,
        });
      }
    }
    return {
      width: 32,
      height: 24,
      bins: 8,
      maxBounces: 3,
      boundary,
      checkpoints,
    };
  } finally {
    for (const t of tracers) t.dispose();
    for (const grid of grids) grid.dispose();
    device.destroy();
  }
}
export async function runReviewRegressions(s) {
  const started = performance.now();
  const phase = (name) =>
    console.log(`W17 review ${name}: ${Math.round(performance.now() - started)}ms`);
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice(),
    track = trackGpuBuffers(device),
    tracers = [];
  const create = async (options, scene) => {
    const t = await s.PathTracer.create(
      { width: 16, height: 12, seed: 42, maxBounces: 3, ...options },
      { device },
    );
    tracers.push(t);
    await t.setScene(scene);
    return t;
  };
  const error = (a, b) =>
    a.reduce(
      (m, v, i) => Math.max(m, Math.abs(v - b[i]) / Math.max(1, Math.abs(v))),
      0,
    );
  try {
    // Known barycentric target points on rotated triangles; oblique non-dyadic rays.
    phase("BVH and refit");
    let maxT = 0,
      maxBary = 0,
      maxOracle = 0,
      probes = 0,
      invalidLeaves = 0,
      refitStable = true;
    for (const count of [1, 2, 3, 5, 6, 7, 9, 10, 17, 31, 33, 65]) {
      const rotate = ([x, y, z], i) => [
        x * Math.cos(0.27) + z * Math.sin(0.27) + i * 0.5,
        y * Math.cos(0.13) - z * Math.sin(0.13),
        y * Math.sin(0.13) + z * Math.cos(0.13),
      ];
      const triangles = Array.from({ length: count }, (_, i) => ({
        v0: rotate([-0.17, -0.19, 0.031], i),
        v1: rotate([0.19, -0.17, 0.043], i),
        v2: rotate([0.011, 0.21, -0.017], i),
        id: i + 1,
      }));
      const rays = triangles.map((t) => {
        const b = [0.23, 0.31, 0.46],
          p = [0, 1, 2].map(
            (c) => b[0] * t.v0[c] + b[1] * t.v1[c] + b[2] * t.v2[c],
          ),
          d = [0.137, -0.091, -0.977];
        return { origin: p.map((v, c) => v - d[c] * 3.7), direction: d };
      });
      const cpu = s.buildBvh(triangles),
        wasm = await s.buildBvhWasm(triangles),
        gpu = await s.buildBvhGpu(triangles, { device });
      if (
        !gpu.isGpu() ||
        !wasm.isCpu() ||
        cpu.getProperties().triangleCount !== count
      )
        throw Error("BVH properties mismatch");
      gpu.validatePrimitives();
      invalidLeaves += gpu.nodes.filter(
        (n) => n.count === 0 && n.left === 0 && n.right === 0,
      ).length;
      const topology = JSON.stringify(
        gpu.nodes.map((n) => [n.left, n.right, n.first, n.count]),
      );
      const hits = await s.traceRaysGpu({ bvh: gpu }, rays, { device });
      for (let i = 0; i < count; i++) {
        const expected = cpu.intersect(rays[i]);
        if (expected?.id !== i + 1)
          throw Error("Oblique oracle coverage failed");
        maxOracle = Math.max(
          maxOracle,
          Math.abs(expected.t - 3.7),
          ...expected.barycentric.map((v, c) =>
            Math.abs(v - [0.23, 0.31, 0.46][c]),
          ),
        );
        for (const h of [
          wasm.intersect(rays[i]),
          gpu.intersect(rays[i]),
          hits[i],
        ]) {
          if (h?.id !== expected.id || h.kind !== "mesh")
            throw Error("Irregular BVH ID mismatch");
          maxT = Math.max(maxT, Math.abs(h.t - expected.t));
          maxBary = Math.max(
            maxBary,
            ...h.barycentric.map((v, c) =>
              Math.abs(v - expected.barycentric[c]),
            ),
          );
          probes++;
        }
      }
      const moved = triangles.map((t) => ({
        ...t,
        v0: t.v0.map((v, c) => v - (c === 2 ? 0.371 : 0)),
        v1: t.v1.map((v, c) => v - (c === 2 ? 0.371 : 0)),
        v2: t.v2.map((v, c) => v - (c === 2 ? 0.371 : 0)),
      }));
      await s.refitBvhGpu(gpu, moved, { device });
      refitStable &&=
        topology ===
        JSON.stringify(
          gpu.nodes.map((n) => [n.left, n.right, n.first, n.count]),
        );
      const movedRays = rays.map((r) => ({
        ...r,
        origin: r.origin.map((v, c) => v - (c === 2 ? 0.371 : 0)),
      }));
      const refitted = await s.traceRaysGpu({ bvh: gpu }, movedRays, {
        device,
      });
      for (let i = 0; i < count; i++)
        if (
          gpu.intersect(movedRays[i])?.id !== i + 1 ||
          refitted[i]?.id !== i + 1
        )
          throw Error("Irregular refit mismatch");
      cpu.dispose();
      wasm.dispose();
      gpu.dispose();
    }
    const triangle = {
      v0: [-10, -10, 0],
      v1: [10, -10, 0],
      v2: [0, 10, 0],
      id: 0xfffffffe,
    };
    const reserved = await s.traceRaysGpu(
      { triangles: [triangle] },
      [{ origin: [0, 0, 5], direction: [0, 0, -1] }],
      { device },
    );
    if (reserved[0]?.kind !== "mesh" || reserved[0].id !== 0xfffffffe)
      throw Error("Mesh/SDF identity collision");
    phase("ReSTIR parity");
    const sdf = s.SdfScene.singlePrimitive(s.SdfPrimitive.sphere([0, 0, 0], 1));
    const sphere = {
      sdf,
      environment: [0.2, 0.3, 0.4],
      materials: [{ albedo: [0.7, 0.5, 0.3] }],
      lights: [
        { position: [-2, 3, 4], intensity: 20 },
        { position: [3, -2, -3], intensity: 40 },
      ],
    };
    const restir = {
      initialCandidates: 4,
      temporalNeighbors: 3,
      spatialNeighbors: 8,
      spatialRadius: 4,
      maxTemporalAge: 4,
    };
    const parity = [];
    for (const biasCorrection of [true, false]) {
      const options = {
        width: 32,
        height: 24,
        restir: { ...restir, biasCorrection },
      };
      const a = await create(options, sphere),
        b = await create({ ...options, engine: "wavefront" }, sphere),
        c = await create({ ...options, backend: "cpu" }, sphere);
      const [ra, rb, rc] = [
        await a.render({ spp: 4 }),
        await b.render({ spp: 4 }),
        await c.render({ spp: 4 }),
      ];
      parity.push({
        cpu: error(rc.color, ra.color),
        engines: error(ra.color, rb.color),
        covered: ra.id.filter((v) => v !== 0).length,
      });
    }
    const plane = {
      v0: [-100, -100, 0],
      v1: [100, -100, 0],
      v2: [0, 100, 0],
      id: 1,
    };
    const flat = {
      triangles: [plane],
      materials: [{ albedo: [0.5, 0.5, 0.5] }],
      environment: [0, 0, 0],
      lights: [
        { position: [0, 0, 5], intensity: 100 },
        { position: [0, 0, -5], intensity: 100 },
      ],
    };
    const reuse = await create(
      {
        width: 8,
        height: 8,
        maxBounces: 1,
        camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 0.01 },
        restir: {
          initialCandidates: 1,
          temporalNeighbors: 1,
          spatialNeighbors: 4,
          spatialRadius: 2,
          maxTemporalAge: 3,
        },
      },
      flat,
    );
    let reuseMean = 0,
      reuseVariance = 0;
    phase("ReSTIR seed ensemble");
    for (let seed = 0; seed < 8; seed++) {
      const t =
        seed === 0
          ? reuse
          : await create(
              {
                width: 8,
                height: 8,
                seed: 42 + seed,
                maxBounces: 1,
                camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 0.01 },
                restir: {
                  initialCandidates: 1,
                  temporalNeighbors: 1,
                  spatialNeighbors: 4,
                  spatialRadius: 2,
                  maxTemporalAge: 3,
                },
              },
              flat,
            );
      const reused = await t.render({ spp: 128 });
      if (seed === 0)
        reuseVariance =
          reused.variance.reduce((a, b) => a + b) / reused.variance.length;
      reuseMean +=
        reused.color.reduce((a, b) => a + b) / (reused.color.length * 8);
    }
    const reuseOff = await create(
      {
        width: 8,
        height: 8,
        maxBounces: 1,
        camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 0.01 },
        restir: {
          initialCandidates: 1,
          temporalNeighbors: 0,
          spatialNeighbors: 0,
          maxTemporalAge: 3,
        },
      },
      flat,
    );
    const noReuse = await reuseOff.render({ spp: 128 }),
      reuseVarianceRatio =
        reuseVariance /
        (noReuse.variance.reduce((a, b) => a + b) / noReuse.variance.length);
    const reuseExpected = (0.5 * 100) / (Math.PI * 25);
    const volumeOptions = {
      width: 16,
      height: 16,
      maxBounces: 3,
      camera: { origin: [0, 0, 5], target: [0, 0, 0], fovY: 0.01 },
    };
    phase("Lit media");
    const clear = await create(volumeOptions, {
        ...flat,
        lights: [flat.lights[0]],
      }),
      fog = await create(volumeOptions, {
        ...flat,
        lights: [flat.lights[0]],
        medium: {
          sigmaA: [0.5, 0.5, 0.5],
          sigmaS: [0, 0, 0],
          bounds: { min: [-100, -100, 0], max: [100, 100, 2] },
        },
      });
    const clearResult = await clear.render(),
      fogResult = await fog.render({ spp: 64 });
    const absorptionRatio =
      fogResult.color.reduce((a, b) => a + b) /
      clearResult.color.reduce((a, b) => a + b);
    const scatterScene = {
      environment: [0, 0, 0],
      lights: [{ position: [1, 0, 3], intensity: 100 }],
      medium: {
        sigmaA: [0.02, 0.04, 0.06],
        sigmaS: [0.5, 0.4, 0.3],
        g: 0.3,
        bounds: { min: [-100, -100, 0], max: [100, 100, 4] },
      },
    };
    const va = await create(volumeOptions, scatterScene),
      vb = await create(
        { ...volumeOptions, engine: "wavefront" },
        scatterScene,
      ),
      vc = await create({ ...volumeOptions, backend: "cpu" }, scatterScene);
    const ar = await va.render({ spp: 4 }),
      br = await vb.render({ spp: 4 }),
      cr = await vc.render({ spp: 4 });
    const mediumParity = {
      cpu: error(cr.color, ar.color),
      engines: error(ar.color, br.color),
      mean: ar.color.reduce((a, b) => a + b) / ar.color.length,
    };
    // An emissive wall occupies positive-x azimuth bins after a diffuse floor bounce.
    const wall = {
      triangles: [
        plane,
        {
          v0: [2, -100, 0],
          v1: [2, 100, 0],
          v2: [2, 100, 100],
          materialId: 1,
          id: 2,
        },
        {
          v0: [2, -100, 0],
          v1: [2, 100, 100],
          v2: [2, -100, 100],
          materialId: 1,
          id: 3,
        },
      ],
      materials: [
        { albedo: [1, 1, 1] },
        { albedo: [0, 0, 0], emission: [10, 10, 10] },
      ],
      environment: [0, 0, 0],
    };
    const guidingOptions = {
      width: 8,
      height: 8,
      maxBounces: 2,
      camera: { origin: [0, 0, 1], target: [0, 0, 0], fovY: 1 },
      luminanceClamp: 2,
    };
    const ga = new s.OnlineGuidingGrid(8, 8, 8),
      gb = new s.OnlineGuidingGrid(8, 8, 8);
    phase("Guiding and AOVs");
    const guided = await create({ ...guidingOptions, guiding: ga }, wall),
      guidedCpu = await create(
        { ...guidingOptions, backend: "cpu", guiding: gb },
        wall,
      );
    const gr = await guided.render({ spp: 16 }),
      gcr = await guidedCpu.render({ spp: 16 });
    let positiveMass = 0,
      negativeMass = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const pdf = ga.pdf(x, y);
        positiveMass += (pdf[0] + pdf[1] + pdf[6] + pdf[7]) / 64;
        negativeMass += (pdf[2] + pdf[3] + pdf[4] + pdf[5]) / 64;
      }
    const guidingParity = error(gcr.color, gr.color),
      guidingWeightsError = error(gb.snapshot(), ga.snapshot());
    const blobs = await s.encodeTraceAovs(gr, "review");
    let aovRoundtripError = 0;
    for (const name of [
      "albedo",
      "normal",
      "depth",
      "direct",
      "indirect",
      "emission",
    ]) {
      const image = await s.readExr(blobs[`review_aov-${name}.exr`]);
      const components = name === "depth" ? 1 : 3,
        labels =
          name === "depth"
            ? ["Z"]
            : name === "normal"
              ? ["X", "Y", "Z"]
              : ["R", "G", "B"];
      if (image.width !== 8 || image.height !== 8)
        throw Error("AOV dimensions mismatch");
      for (let c = 0; c < components; c++) {
        const channel = image.channels.find(
          (v) => v.name === `${name}.${labels[c]}`,
        );
        if (!channel) throw Error("AOV channel missing");
        for (let i = 0; i < 64; i++)
          aovRoundtripError = Math.max(
            aovRoundtripError,
            Math.abs(channel.data[i] - gr[name][i * components + c]),
          );
      }
    }
    const png = await createImageBitmap(blobs["review_aov-visibility.png"]),
      visibilityPng = png.width === 8 && png.height === 8;
    png.close();
    const tiles = [...s.iterTraceTiles(17, 11, 4)],
      tileCoverage = tiles.reduce((n, t) => n + t.width * t.height, 0);
    const trained = ga.snapshot(),
      varianceOptions = { ...guidingOptions, luminanceClamp: 0 };
    phase("Guiding variance");
    const learned = await create({ ...varianceOptions, guiding: ga }, wall),
      uniform = await create(varianceOptions, wall);
    ga.restore(trained);
    await learned.render({ spp: 256 });
    const lr = await learned.render({ spp: 64 }),
      ur = await uniform.render({ spp: 64 }),
      guidingVarianceRatio =
        lr.variance.reduce((a, b) => a + b) /
        ur.variance.reduce((a, b) => a + b);
    ga.dispose();
    gb.dispose();
    // Equal explicit axes must produce the same lobe as their matching roughness.
    const axisScene = {
      ...sphere,
      materials: [
        {
          albedo: [0.7, 0.4, 0.2],
          metallic: 1,
          roughness: 0.5,
          ax: 0.01,
          ay: 0.01,
        },
      ],
    };
    const axis = await create({}, axisScene),
      equiv = await create(
        {},
        {
          ...axisScene,
          materials: [{ albedo: [0.7, 0.4, 0.2], metallic: 1, roughness: 0.1 }],
        },
      ),
      axisError = error(
        (await axis.render({ spp: 4 })).color,
        (await equiv.render({ spp: 4 })).color,
      );
    sdf.dispose();
    phase("Finished");
    for (const t of tracers) t.dispose();
    const residualBuffers = track.count,
      residualBytes = track.bytes;
    const negative = device.createBuffer({ size: 64, usage: 8 }),
      leakNegativeControl = track.count === residualBuffers + 1;
    negative.destroy();
    return {
      probes,
      invalidLeaves,
      refitStable,
      maxT,
      maxBary,
      maxOracle,
      parity,
      reuseMean,
      reuseVarianceRatio,
      reuseExpected,
      absorptionRatio,
      absorptionExpected: Math.exp(-2),
      mediumParity,
      positiveMass,
      negativeMass,
      guidingVarianceRatio,
      aovRoundtripError,
      visibilityPng,
      tileCoverage,
      guidingParity,
      guidingWeightsError,
      axisError,
      residualBuffers,
      residualBytes,
      createdBuffers: track.created,
      destroyedBuffers: track.destroyed,
      peakGpuAllocatedBytes: track.peakBytes,
      leakNegativeControl,
    };
  } finally {
    for (const t of tracers) t.dispose();
    track.restore();
    device.destroy();
  }
}
