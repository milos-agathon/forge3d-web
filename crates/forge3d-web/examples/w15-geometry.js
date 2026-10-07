const dist = new URLSearchParams(location.search).has("dist");
const api = dist
  ? await import("../dist/index.js")
  : await import("../src-ts/index.ts");
const canvas = document.querySelector("canvas");
const fixture = (name) =>
  new URL(`../tests/fixtures/w15/${name}`, import.meta.url);
const identity = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
const camera = {
  position: [12, 10, 18],
  target: [4, 2, -1.5],
  up: [0, 1, 0],
  near: 0.1,
  far: 200,
  fovYDegrees: 45,
};
const hash = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const maxError = (a, b) => {
  if (a.length !== b.length) throw Error("attribute count mismatch");
  return a.reduce((max, x, i) => Math.max(max, Math.abs(x - b[i])), 0);
};
function hausdorff(a, b) {
  const directed = (x, y) => {
    let max = 0;
    for (let i = 0; i < x.length; i += 3) {
      let min = Infinity;
      for (let j = 0; j < y.length; j += 3)
        min = Math.min(
          min,
          Math.hypot(x[i] - y[j], x[i + 1] - y[j + 1], x[i + 2] - y[j + 2]),
        );
      max = Math.max(max, min);
    }
    return max;
  };
  return Math.max(directed(a, b), directed(b, a));
}
async function io() {
  const family = {
      cube: api.generatePrimitive("box"),
      plane: api.generatePrimitive("plane", { resolution: [2, 2] }),
      tube: api.generateTube(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
        ],
        { radialSegments: 8 },
      ),
      ribbon: api.generateRibbon([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ]),
      extrusion: api.extrudePolygon(
        [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
        ],
        { height: 3 },
      ),
    },
    familyRoundtrips = [];
  for (const [name, input] of Object.entries(family))
    for (const format of ["obj", "stl", "glb"]) {
      const mesh = api.attachMeshTangents(input),
        copy = await api.loadMesh(api.exportMesh(mesh, format), { format }),
        bounds = api.meshBounds(mesh),
        diagonal = Math.hypot(...bounds.max.map((x, i) => x - bounds.min[i]));
      // OBJ deduplicates face triplets in encounter order, so compare exact
      // oriented connectivity after identifying vertices by all carried attributes.
      const remap = Array.from(
        { length: copy.positions.length / 3 },
        (_, i) => {
          if (format !== "obj") return i;
          for (let j = 0; j < mesh.positions.length / 3; j++)
            if (
              [0, 1, 2].every(
                (c) =>
                  Math.abs(
                    copy.positions[i * 3 + c] - mesh.positions[j * 3 + c],
                  ) <= 1e-5 &&
                  Math.abs(copy.normals[i * 3 + c] - mesh.normals[j * 3 + c]) <=
                    1e-5,
              ) &&
              [0, 1].every(
                (c) =>
                  Math.abs(copy.uvs[i * 2 + c] - mesh.uvs[j * 2 + c]) <= 1e-5,
              )
            )
              return j;
          throw Error("OBJ lost a vertex attribute");
        },
      );
      const topology =
        format === "stl"
          ? copy.indices.every((id, i) =>
              [0, 1, 2].every(
                (a) =>
                  copy.positions[id * 3 + a] ===
                  mesh.positions[mesh.indices[i] * 3 + a],
              ),
            )
          : copy.indices.every((id, i) => remap[id] === mesh.indices[i]);
      let facetNormalError = 0;
      if (format === "stl")
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const [a, b, c] = Array.from(mesh.indices.subarray(t, t + 3), (id) =>
              Array.from(mesh.positions.subarray(id * 3, id * 3 + 3)),
            ),
            u = b.map((x, i) => x - a[i]),
            v = c.map((x, i) => x - a[i]),
            n = [
              u[1] * v[2] - u[2] * v[1],
              u[2] * v[0] - u[0] * v[2],
              u[0] * v[1] - u[1] * v[0],
            ],
            length = Math.hypot(...n);
          for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++)
              facetNormalError = Math.max(
                facetNormalError,
                Math.abs(
                  copy.normals[(t + j) * 3 + k] - (length ? n[k] / length : 0),
                ),
              );
        }
      const copyBounds = api.meshBounds(copy),
        boundsError =
          Math.max(
            maxError(bounds.min, copyBounds.min),
            maxError(bounds.max, copyBounds.max),
          ) / diagonal;
      const error = (a, b, width) =>
        a.reduce(
          (max, x, i) =>
            Math.max(
              max,
              Math.abs(
                x - b[remap[Math.floor(i / width)] * width + (i % width)],
              ),
            ),
          0,
        );
      familyRoundtrips.push({
        name,
        format,
        triangles: copy.indices.length / 3,
        expectedTriangles: mesh.indices.length / 3,
        vertices: copy.positions.length / 3,
        expectedVertices:
          format === "stl" ? mesh.indices.length : mesh.positions.length / 3,
        topology,
        boundsError,
        positionError: hausdorff(copy.positions, mesh.positions) / diagonal,
        normalError:
          format === "stl"
            ? facetNormalError
            : error(copy.normals, mesh.normals, 3),
        uvError: format === "stl" ? null : error(copy.uvs, mesh.uvs, 2),
        tangentError:
          format === "glb" ? maxError(copy.tangents, mesh.tangents) : null,
      });
    }
  const imported = await api.loadObj(fixture("triangle.obj"));
  const assets = await Promise.all([
    api.loadGltf(fixture("triangle.gltf")),
    api.loadGltf(fixture("triangle-external.gltf")),
    api.loadGltf(fixture("triangle.glb")),
  ]);
  const mesh = assets[0].primitives[0].mesh,
    roundtrips = [];
  for (const format of ["obj", "stl", "glb"]) {
    const blob = api.exportMesh(mesh, format),
      copy = await api.loadMesh(blob, { format });
    const bounds = api.meshBounds(mesh),
      diagonal = Math.hypot(...bounds.max.map((x, i) => x - bounds.min[i]));
    roundtrips.push({
      format,
      vertices: copy.positions.length / 3,
      triangles: copy.indices.length / 3,
      topology: [...copy.indices].join() === [...mesh.indices].join(),
      positionError: hausdorff(copy.positions, mesh.positions) / diagonal,
      normalError: maxError(copy.normals, mesh.normals),
      uvError: format === "stl" ? null : maxError(copy.uvs, mesh.uvs),
    });
  }
  const parts = [];
  const sink = await api.exportMeshToSink(mesh, "glb", {
    kind: "stream",
    stream: new WritableStream({ write: (bytes) => parts.push(bytes) }),
  });
  const pixel = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  };
  const png = await api.loadImage(await api.exportImage(pixel));
  const hdr = {
    width: 129,
    height: 2,
    data: Float32Array.from({ length: 129 * 2 * 4 }, (_, i) =>
      i % 4 === 3 ? 1 : [0.5, 1, 2][i % 4],
    ),
  };
  const hdrCopy = await api.loadHdr(api.exportHdr(hdr));
  const controller = new AbortController();
  controller.abort();
  let cancelled, budget;
  try {
    await api.loadGltf(fixture("triangle.glb"), { signal: controller.signal });
  } catch (e) {
    cancelled = e.code;
  }
  try {
    await api.loadGltf(fixture("triangle.glb"), { maxBytes: 1 });
  } catch (e) {
    budget = e.code;
  }
  const diagnostics = api.diagnoseBuildingTextures([
    {
      materialId: "wall",
      objectId: "house",
      albedoTexture: "wall.png",
      uvAvailable: true,
      assetAvailable: true,
      scalarFallback: true,
    },
  ]);
  return {
    familyRoundtrips,
    roundtrips,
    plainCounts: assets.map((a) => a.primitives[0].mesh.indices.length / 3),
    mtl: imported.materials[0].diffuseTexture,
    sinkBytes: sink.bytesWritten,
    pngExact: maxError(png.data, pixel.data) === 0,
    hdrError: maxError(hdrCopy.data, hdr.data),
    cancelled,
    budget,
    diagnostics,
  };
}
async function worker() {
  const owned = api.attachMeshTangents(
      api.generatePrimitive("plane", { resolution: [2, 2] }),
    ),
    transfer = api.transferMesh(owned),
    workerUrl = new URL("./w15-worker.js", import.meta.url),
    channel = new MessageChannel();
  if (dist) workerUrl.searchParams.set("dist", "");
  const w = new Worker(workerUrl, { type: "module" });
  const returned = new Promise((resolve, reject) => {
    w.onmessage = (e) => resolve(e.data.returnedDetached);
    w.onerror = (e) => reject(Error(e.message));
  });
  w.postMessage({ port: channel.port2 }, [channel.port2]);
  const pool = new api.Forge3DWorkerPool({
    size: 1,
    workerFactory: () => channel.port1,
    mainThreadHandler: api.createMeshWorkerHandler(),
  });
  try {
    const result = await pool.run(
      { kind: "subdivide", mesh: transfer.mesh, levels: 2 },
      { transfer: transfer.transfer },
    );
    return {
      inputDetached: transfer.mesh.positions.byteLength === 0,
      ownedIntact: owned.positions.byteLength > 0,
      returnedDetached: await returned,
      vertices: result.positions.length / 3,
      triangles: result.indices.length / 3,
      mode: pool.getDiagnostics().mode,
      valid: api.validateMesh(result).clean,
    };
  } finally {
    pool.dispose();
    w.terminate();
  }
}
async function buildings() {
  const scene = api.Forge3DScene.create(),
    layer = await api.loadBuildings(fixture("buildings.geojson")),
    r = await api.Forge3DRuntime.create(canvas, {
      width: 256,
      height: 160,
      devicePixelRatio: 1,
    });
  try {
    // A removed material slot makes material-index errors visible.
    scene.setMaterial("removed", { id: "removed" });
    scene.removeMaterial("removed");
    layer.addToScene(scene, { lodRatios: [1, 0.5], lodDistances: [60] });
    r.setScene(scene.snapshot());
    r.setCamera(camera);
    r.render();
    const capture = await r.capture({
        samples: 1,
        aovs: ["id", "albedo", "normal"],
      }),
      ids = capture.aovFrame.id(),
      albedo = capture.aovFrame.albedo(),
      counts = {},
      colors = {};
    for (let i = 0; i < ids.length; i++)
      if (ids[i] >= 0x100000) {
        counts[ids[i]] = (counts[ids[i]] ?? 0) + 1;
        colors[ids[i]] = Array.from(albedo.subarray(i * 3, i * 3 + 3));
      }
    const near = r.getScatterStats();
    r.setCamera({ ...camera, position: [40, 30, 80] });
    r.render();
    const far = r.getScatterStats();
    const city = await api.loadBuildings(fixture("buildings.city.json"), {
      origin: [1000, 2000, 0],
    });
    const cityBounds = city.bounds();
    city.dispose();
    const geographic = await (
      await fetch(fixture("buildings.city.json"))
    ).json();
    geographic.transform = { scale: [0.01, 0.01, 1], translate: [9, 40, 0] };
    const crs = await api.CrsTransformer.create({ cache: null });
    let projectedBounds;
    try {
      const origin = await crs.transformCoords(
          [[9, 40, 0]],
          "EPSG:4326",
          "EPSG:32632",
          { alwaysXY: true },
        ),
        projected = await api.loadBuildings(
          new Blob([JSON.stringify(geographic)]),
          {
            crs: "EPSG:4326",
            targetCrs: "EPSG:32632",
            transformer: crs,
            origin: origin[0],
          },
        );
      projectedBounds = projected.bounds();
      projected.dispose();
    } finally {
      crs.dispose();
    }
    return {
      projectedBounds,
      counts,
      colors,
      materialIndices: scene.getScatterBatches().map((b) => b.materialIndex),
      near,
      far,
      cityBounds,
      triangles: layer.totalTriangles,
    };
  } finally {
    r.dispose();
    scene.dispose();
    layer.dispose();
  }
}
async function textures() {
  const mesh = api.attachMeshTangents(
      api.generatePrimitive("plane", { resolution: [2, 2] }),
    ),
    scene = api.Forge3DScene.create(),
    r = await api.Forge3DRuntime.create(canvas, {
      width: 256,
      height: 160,
      devicePixelRatio: 1,
    });
  const transform = new Float32Array([
    0, -2, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const image = {
    width: 2,
    height: 2,
    format: "rgba8unorm-srgb",
    colorSpace: "srgb",
    data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]),
  };
  const normal = {
    width: 1,
    height: 1,
    format: "rgba8unorm",
    colorSpace: "linear",
    data: new Uint8Array([190, 128, 225, 255]),
  };
  try {
    scene.setMaterial("checker", {
      id: "checker",
      textures: { baseColor: image, normal },
    });
    const index = scene.getMaterials().find((m) => m.slot === "checker").index;
    const capture = async (m, transforms) => {
      scene.setScatterBatches([
        new api.MeshLayer(m, { transforms, materialIndex: index }).toBatch(),
      ]);
      r.setScene(scene.snapshot());
      r.render();
      return r.capture({ samples: 1, aovs: ["id", "albedo", "normal"] });
    };
    r.setCamera({ ...camera, position: [0, 0, 8], target: [0, 0, 0] });
    const a = await capture(mesh, transform),
      b = await capture(api.transformMesh(mesh, transform), identity);
    const ids = a.aovFrame.id(),
      colors = a.aovFrame.albedo(),
      unique = new Set();
    let covered = 0;
    for (let i = 0; i < ids.length; i++)
      if (ids[i]) {
        covered++;
        unique.add(
          Array.from(colors.subarray(i * 3, i * 3 + 3))
            .map((x) => Math.round(x * 255))
            .join(),
        );
      }
    const c = await capture(
      { ...mesh, uvs: new Float32Array(mesh.uvs.length) },
      transform,
    );
    return {
      covered,
      colors: unique.size,
      normalError: maxError(a.aovFrame.normal(), b.aovFrame.normal()),
      albedoError: maxError(a.aovFrame.albedo(), b.aovFrame.albedo()),
      idsEqual: (await hash(ids)) === (await hash(b.aovFrame.id())),
      uvNegativeDelta: maxError(a.aovFrame.albedo(), c.aovFrame.albedo()),
    };
  } finally {
    r.dispose();
    scene.dispose();
  }
}
async function resources() {
  const mesh = api.generatePrimitive("sphere", {
      rings: 8,
      radialSegments: 12,
    }),
    r = await api.Forge3DRuntime.create(canvas, {
      width: 256,
      height: 160,
      devicePixelRatio: 1,
      memoryBudgetBytes: 8 * 1024 * 1024,
    }),
    bytes = [];
  try {
    r.setCamera({ ...camera, position: [0, 2, 8], target: [0, 0, 0] });
    for (let i = 0; i < 30; i++) {
      const layer = new api.MeshLayer(mesh);
      r.setScatterBatches([layer.toBatch()]);
      r.render();
      bytes.push(r.getScatterMemoryReport().gpuBytes);
      layer.dispose();
      if (layer.cpuBytes !== 0) throw Error("CPU ownership leaked");
    }
    const before = await hash(await r.readRgba());
    let rejected;
    const transforms = new Float32Array(16 * 110000);
    for (let i = 0; i < 110000; i++) transforms.set(identity, i * 16);
    try {
      r.setScatterBatches([new api.MeshLayer(mesh, { transforms }).toBatch()]);
    } catch (e) {
      rejected = e.code;
    }
    r.render();
    const after = await hash(await r.readRgba());
    r.resize({ width: 128, height: 80, devicePixelRatio: 1 });
    r.render();
    const resized = (await r.readRgba()).length;
    r.setScatterBatches([]);
    const cleared = r.getScatterMemoryReport();
    return {
      stable: bytes.every((x) => x === bytes[0]),
      bytes: bytes[0],
      rejected,
      atomic: before === after,
      resized,
      cleared: cleared.gpuBytes,
      budget: r.getMemoryReport().budgetBytes,
    };
  } finally {
    r.dispose();
  }
}
async function recovery() {
  const sessionModule = dist
      ? await import("../dist/session.js")
      : await import("../src-ts/session.ts"),
    internals = dist
      ? await import("../dist/runtime-internals.js")
      : await import("../src-ts/runtime-internals.ts");
  let runtime,
    created = 0;
  sessionModule.setSessionRuntimeFactoryForTests(async (c, o) => {
    created++;
    runtime = await api.Forge3DRuntime.create(c, o);
    return runtime;
  });
  const scene = api.Forge3DScene.create(),
    layer = await api.loadBuildings(fixture("buildings.geojson"));
  layer.addToScene(scene);
  const session = await api.Forge3DSession.create(canvas, {
    runtime: {
      width: 256,
      height: 160,
      devicePixelRatio: 1,
      diagnostics: true,
    },
  });
  try {
    session.setScene(scene);
    session.setCamera(camera);
    session.render();
    const a = await hash(await session.readRgba());
    internals.simulateRuntimeDeviceLossForTests(runtime);
    const deadline = performance.now() + 15000;
    while (session.status !== "ready" || created < 2) {
      if (performance.now() > deadline) throw Error("recovery timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    session.render();
    return {
      same: a === (await hash(await session.readRgba())),
      created,
      stats: session.getScatterStats(),
      status: session.status,
    };
  } finally {
    session.dispose();
    scene.dispose();
    layer.dispose();
    sessionModule.setSessionRuntimeFactoryForTests(undefined);
  }
}
window.__w15 = { api, io, worker, buildings, textures, resources, recovery };
document.querySelector("#run").onclick = async () => {
  const result = document.querySelector("#result");
  result.textContent = "Running…";
  try {
    result.textContent = JSON.stringify(
      { render: await buildings(), io: await io(), worker: await worker() },
      null,
      2,
    );
  } catch (e) {
    result.textContent = `${e.code ?? "ERROR"}: ${e.message}`;
  }
};
