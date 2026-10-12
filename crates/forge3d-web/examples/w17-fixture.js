// Analytic reference geometry; no BVH implementation generates expected hits.
export function makeTraceFixture(s) {
  const triangles = [];
  for (let layer = 0; layer < 2; layer++)
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const a = [x - 64, y - 64, layer === 0 ? 0 : -2],
          b = [x - 63, y - 64, layer === 0 ? 0 : -2],
          c = [x - 63, y - 63, layer === 0 ? 0 : -2],
          d = [x - 64, y - 63, layer === 0 ? 0 : -2];
        const id = 1 + layer * 32768 + 2 * (y * 128 + x);
        triangles.push(
          { v0: a, v1: b, v2: c, id, materialId: 0 },
          { v0: a, v1: c, v2: d, id: id + 1, materialId: 0 },
        );
      }
  const sdf = new s.SdfScene();
  let root;
  for (let i = 0; i < 128; i++) {
    const node = sdf.addPrimitive(
      s.SdfPrimitive.sphere([140 + 3 * i, 0, 0], 1, 0),
    );
    root = root === undefined ? node : sdf.addOperation(0, root, node);
  }
  sdf.setBounds([139, -1, -1], [522, 1, 1]);
  return {
    triangles,
    sdf,
    materials: [{ albedo: [0.08, 0.08, 0.08], emission: [0.5, 0.5, 0.5] }],
    environment: [0.8, 0.8, 0.8],
  };
}
export function analyticRay(i) {
  const x = i % 1024,
    y = Math.floor(i / 1024),
    u = ((x % 8) + 0.25) / 8,
    v = ((y % 8) + 0.5) / 8;
  return {
    ray: {
      origin: [Math.floor(x / 8) - 64 + u, Math.floor(y / 8) - 64 + v, 5],
      direction: [0, 0, -1],
    },
    id: 1 + 2 * (Math.floor(y / 8) * 128 + Math.floor(x / 8)) + (v > u ? 1 : 0),
    bary: v <= u ? [1 - u, u - v, v] : [1 - v, u, v - u],
  };
}
export async function sha256(data) {
  const bytes = data instanceof ArrayBuffer ? data : data.buffer;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function runTraceWorkload(s) {
  const manifest = await (
      await fetch("/tests/fixtures/w17/trace-sdf-v1.json")
    ).json(),
    scene = makeTraceFixture(s);
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice();
  const cpu = s.buildBvh(scene.triangles),
    wasm = await s.buildBvhWasm(scene.triangles),
    gpu = await s.buildBvhGpu(scene.triangles, { device });
  const rayBytes = new Float32Array(1048576 * 6),
    cpuBytes = new ArrayBuffer(1048576 * 20),
    gpuBytes = new ArrayBuffer(1048576 * 20),
    wasmBytes = new ArrayBuffer(1048576 * 20);
  const put = (buffer, i, hit) => {
    const u = new Uint32Array(buffer, i * 20, 5),
      f = new Float32Array(buffer, i * 20, 5);
    u[0] = hit.id;
    f[1] = hit.t;
    f.set(hit.barycentric, 2);
  };
  const triData = new ArrayBuffer(65536 * 44),
    triF = new Float32Array(triData),
    triU = new Uint32Array(triData);
  scene.triangles.forEach((t, i) => {
    triF.set([...t.v0, ...t.v1, ...t.v2], i * 11);
    triU.set([t.id, t.materialId], i * 11 + 9);
  });
  let maxT = 0,
    maxBary = 0,
    idErrors = 0,
    analyticErrors = 0;
  const started = performance.now();
  try {
    for (let first = 0; first < 1048576; first += 65536) {
      const rays = Array.from(
        { length: 65536 },
        (_, j) => analyticRay(first + j).ray,
      );
      const hits = await s.traceRaysGpu(
        { ...scene, triangles: undefined, bvh: gpu },
        rays,
        { device, memoryBudgetBytes: 1536 * 1024 * 1024 },
      );
      for (let j = 0; j < rays.length; j++) {
        const i = first + j,
          a = analyticRay(i),
          c = cpu.intersect(rays[j]),
          w = wasm.intersect(rays[j]),
          g = hits[j];
        rayBytes.set([...a.ray.origin, ...a.ray.direction], i * 6);
        for (const h of [c, w, g]) {
          if (h?.id !== a.id) analyticErrors++;
          if (h)
            for (let k = 0; k < 3; k++)
              if (Math.abs(h.barycentric[k] - a.bary[k]) > 1e-5)
                analyticErrors++;
        }
        if (c?.id !== g?.id || c?.id !== w?.id) idErrors++;
        if (c && w && g) {
          maxT = Math.max(maxT, Math.abs(c.t - g.t), Math.abs(c.t - w.t));
          for (let k = 0; k < 3; k++)
            maxBary = Math.max(
              maxBary,
              Math.abs(c.barycentric[k] - g.barycentric[k]),
              Math.abs(c.barycentric[k] - w.barycentric[k]),
            );
          put(cpuBytes, i, c);
          put(wasmBytes, i, w);
          put(gpuBytes, i, g);
        }
      }
      console.log("W17 workload rays " + (first + 65536));
    }
    const lowerRays = Array.from({ length: 64 }, (_, i) => ({
        ...analyticRay(i * 16384).ray,
        origin: [...analyticRay(i * 16384).ray.origin.slice(0, 2), -1],
      })),
      lowerHits = await s.traceRaysGpu({ bvh: gpu }, lowerRays, { device });
    for (let i = 0; i < 64; i++) {
      const id = 32768 + analyticRay(i * 16384).id;
      for (const h of [
        cpu.intersect(lowerRays[i]),
        wasm.intersect(lowerRays[i]),
        lowerHits[i],
      ])
        if (h?.id !== id || h?.t !== 1) analyticErrors++;
    }
    const sphereRays = Array.from({ length: 128 }, (_, i) => ({
        origin: [140 + 3 * i, 0, 5],
        direction: [0, 0, -1],
      })),
      sphereHits = await s.traceRaysGpu({ sdf: scene.sdf }, sphereRays, {
        device,
      });
    for (const h of sphereHits)
      if (
        h?.id !== 0xffffffff ||
        Math.abs(h.t - 4) > 1e-5 ||
        h.materialId !== 0
      )
        analyticErrors++;
    const offsets = [
      [0.271, 0.433, 0.519],
      [-1.173, 0.397, 0.291],
      [0.623, -0.917, 0.371],
      [-0.347, -0.583, 0.719],
    ];
    const points = Array.from({ length: 512 }, (_, i) => [
        140 + 3 * Math.floor(i / 4) + offsets[i % 4][0],
        offsets[i % 4][1],
        offsets[i % 4][2],
      ]),
      distances = await s.evaluateSdfGpu(scene.sdf, points, { device }),
      native = await s.evaluateSdfWasm(scene.sdf, points);
    let maxSdf = 0,
      materialErrors = 0;
    for (let i = 0; i < points.length; i++) {
      const c = scene.sdf.evaluate(points[i]);
      maxSdf = Math.max(
        maxSdf,
        Math.abs(c.distance - distances[i].distance),
        Math.abs(c.distance - native[i].distance),
        Math.abs(
          c.distance -
            (Math.hypot(
              Math.fround(points[i][0]) - (140 + 3 * Math.floor(i / 4)),
              Math.fround(points[i][1]),
              Math.fround(points[i][2]),
            ) -
              1),
        ),
      );
      if (
        c.materialId !== distances[i].materialId ||
        c.materialId !== native[i].materialId
      )
        materialErrors++;
    }
    return {
      fixtureId: manifest.fixtureId,
      triangles: cpu.stats.triangleCount,
      sdfPrimitives: scene.sdf.primitiveCount(),
      rays: 1048576,
      triangleHash: await sha256(triData),
      expectedTriangleHash: manifest.triangleSha256,
      lowerLayerProbes: 64,
      sdfHitProbes: 128,
      sdfOffCenterProbes: 512,
      rayHash: await sha256(rayBytes),
      cpuHitHash: await sha256(cpuBytes),
      wasmHitHash: await sha256(wasmBytes),
      gpuHitHash: await sha256(gpuBytes),
      expectedRayHash: manifest.raySha256,
      expectedHitHash: manifest.analyticHitsSha256,
      maxT,
      maxBary,
      maxSdf,
      idErrors,
      analyticErrors,
      materialErrors,
      durationMs: performance.now() - started,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      gpuTree: gpu.stats,
      cpuTree: cpu.stats,
    };
  } finally {
    cpu.dispose();
    wasm.dispose();
    gpu.dispose();
    scene.sdf.dispose();
    device.destroy();
  }
}
