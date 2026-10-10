const dist = new URLSearchParams(location.search).has("dist"),
  api = await (dist
    ? import("../dist/index.js")
    : import("../src-ts/index.ts"));
const url = (name) =>
  new URL("../tests/fixtures/w16/" + name, location.href).href;
const canvas = document.querySelector("#canvas"),
  status = document.querySelector("#status");
let renderer, layer, liveView, pool;
let cameraHome,
  cameraAngle = 0,
  cameraZoom = 1,
  drag,
  dragged = false,
  cameraQueued = false;
const hash = async (array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", array)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
function workerPool() {
  const workers = [];
  const pool = new api.Forge3DWorkerPool({
    size: 2,
    preferSharedArrayBuffer: false,
    mainThreadHandler: api.createPointCloudWorkerHandler(),
    workerFactory: () => {
      const worker = new Worker(
        new URL("./w16-worker.js" + (dist ? "?dist" : ""), import.meta.url),
        { type: "module" },
      );
      workers.push(worker);
      const c = new MessageChannel();
      worker.postMessage({ port: c.port2 }, [c.port2]);
      return c.port1;
    },
  });
  return {
    pool,
    dispose() {
      pool.dispose();
      workers.forEach((w) => w.terminate());
    },
  };
}
function ortho(bounds) {
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2),
    extent = Math.max(...bounds.min.map((v, i) => bounds.max[i] - v), 1),
    scale = 1.8 / extent;
  // Source XY overhead view; depth includes source Z and uses WebGPU's 0..1 convention.
  return {
    position: [center[0], center[1], center[2] + extent],
    viewportHeight: 480,
    fovY: Math.PI / 4,
    viewProjection: [
      scale,
      0,
      0,
      0,
      0,
      scale,
      0,
      0,
      0,
      0,
      -0.5 / extent,
      0,
      -center[0] * scale,
      -center[1] * scale,
      0.5 + (center[2] * 0.5) / extent,
      1,
    ],
  };
}
async function io() {
  const manifest = await (await fetch(url("copc-ept-tiles-v1.json"))).json(),
    owner = workerPool();
  try {
    const laz = await api.openLaz(url("autzen_trim.laz"), {
        workerPool: owner.pool,
      }),
      data = await laz.readPoints("0-0-0-0");
    const lazResult = {
      count: data.positions.length / 3,
      positions: await hash(data.positions),
      colors: await hash(data.colors),
      bounds: laz.bounds,
    };
    laz.dispose();
    const requests = [];
    const fetcher = async (u, init) => {
      const r = await fetch(u, init);
      requests.push({
        range: init.headers.Range ?? init.headers.range ?? null,
        status: r.status,
        bytes: Number(r.headers.get("content-length")),
      });
      return r;
    };
    const copc = await api.openCopc(url("ellipsoid.copc.laz"), {
        workerPool: owner.pool,
        fetch: fetcher,
      }),
      root = await copc.readPoints("0-0-0-0"),
      copcResult = {
        count: copc.totalPoints,
        rootCount: root.positions.length / 3,
        rootPositions: await hash(root.positions),
        rootColors: await hash(root.colors),
        bounds: copc.header.bounds,
        metadata: copc.info,
        requests,
        ranges: copc.stats().ranges,
      };
    const pending = [copc.rootNode().key],
      visited = new Set(pending);
    for (let i = 0; i < pending.length; i++)
      for (const child of await copc.children(pending[i]))
        if (!visited.has(child.key)) {
          visited.add(child.key);
          pending.push(child.key);
        }
    const entries = [...copc.hierarchy.values()]
        .filter((n) => n.pointCount > 0)
        .sort((a, b) => a.offset - b.offset),
      allPositions = new Float64Array(copc.totalPoints * 3),
      allColors = new Uint8Array(copc.totalPoints * 3);
    let read = 0;
    for (const entry of entries) {
      const data = await copc.readPoints(entry.key);
      allPositions.set(data.positions, read * 3);
      allColors.set(data.colors, read * 3);
      read += data.positions.length / 3;
    }
    copcResult.pointsRead = read;
    copcResult.chunks = entries.length;
    copcResult.positions = await hash(allPositions);
    copcResult.colors = await hash(allColors);
    copcResult.ranges = copc.stats().ranges;
    copc.dispose();
    const ept = await api.openEpt(url("ept/ept.json")),
      ep = await ept.readPoints("0-0-0-0"),
      eptResult = {
        count: ep.positions.length / 3,
        positions: await hash(ep.positions),
        colors: await hash(ep.colors),
      };
    ept.dispose();
    const tables = await api.loadTileset(url("external.json")),
      tiles = new api.Tiles3dLayer(tables, {
        origin: [0, 0, 0],
        ownsTileset: true,
      });
    await tiles.update({
      position: [0, 0, 10],
      viewportHeight: 480,
      fovY: Math.PI / 4,
    });
    const tileResult = {
      stats: tiles.stats(),
      points: Array.from(tiles.pointData().positions),
      colors: Array.from(tiles.pointData().colors),
      mesh: Array.from(tiles.meshes()[0].mesh.positions),
      external: tables.stats().externalTilesets,
    };
    tiles.dispose();
    return {
      manifest,
      laz: lazResult,
      copc: copcResult,
      ept: eptResult,
      tiles: tileResult,
      worker: owner.pool.getDiagnostics(),
    };
  } finally {
    owner.dispose();
  }
}
async function ranged() {
  const manifest = await (await fetch(url("copc-ept-tiles-v1.json"))).json(),
    expected = manifest.overviewCopc,
    requests = [],
    fetcher = async (u, init) => {
      const r = await fetch(u, init);
      requests.push({
        range: init.headers.Range ?? init.headers.range ?? null,
        status: r.status,
        bytes: Number(r.headers.get("content-length")),
      });
      return r;
    };
  const d = await api.openCopc(url("overview.copc.laz"), { fetch: fetcher }),
    layer = new api.PointCloudLayer(d, {
      ...expected.options,
      ownsDataset: true,
      // This source stores low-valued 16-bit RGB. Use actual elevations for
      // coverage while independently checking the unchanged RGB bytes below.
      style: { pointSize: 3, colorMode: "elevation" },
    });
  const view = expected.view;
  await layer.update(view);
  const root = await d.readPoints("0-0-0-0"),
    r = await api.PointCloudRenderer.create(new OffscreenCanvas(640, 480));
  r.setLayers([layer]);
  await r.render(view);
  const pixels = await r.readRgba();
  let coveredPixels = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (Math.max(...pixels.subarray(i, i + 3)) >= 20) coveredPixels++;
  const result = {
    expected,
    rootPositions: await hash(root.positions),
    rootColors: await hash(root.colors),
    coveredPixels,
    points: layer.stats().pointsRendered,
    keys: layer.stats().selectedKeys,
    requests,
    bytes: d.stats().ranges.bytesTransferred,
    total: d.io.scheduler.fileSize(d.source),
    fraction:
      d.stats().ranges.bytesTransferred / d.io.scheduler.fileSize(d.source),
  };
  layer.traverser.setPointBudget(expected.root.count - 1);
  await layer.update(view);
  r.setLayers([layer]);
  await r.render(view);
  result.negativeKeys = layer.stats().selectedKeys;
  const empty = await r.readRgba();
  result.negativeCoveredPixels = 0;
  for (let i = 0; i < empty.length; i += 4)
    if (Math.max(...empty.subarray(i, i + 3)) >= 20)
      result.negativeCoveredPixels++;
  r.dispose();
  layer.dispose();
  return result;
}
async function show(real = false) {
  layer?.dispose();
  pool?.dispose();
  pool = workerPool();
  const dataset = real
    ? await api.openLaz(url("autzen_trim.laz"), { workerPool: pool.pool })
    : await (async () => {
        const t = await api.loadTileset(url("tileset.json")),
          tiles = new api.Tiles3dLayer(t, {
            origin: [0, 0, 0],
            ownsTileset: true,
          });
        await tiles.update({
          position: [0, 0, 10],
          viewportHeight: 480,
          fovY: Math.PI / 4,
        });
        const l = tiles.asPointCloudLayer();
        tiles.dispose();
        return l.dataset;
      })();
  layer = new api.PointCloudLayer(dataset, {
    ownsDataset: true,
    pointBudget: real ? 150000 : 100,
    style: { pointSize: real ? 2 : 18, colorMode: real ? "elevation" : "rgb" },
  });
  liveView = ortho(dataset.bounds);
  if (!real)
    liveView = {
      position: [0, 0, 5],
      viewportHeight: 480,
      fovY: Math.PI / 4,
      viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0.5, 1],
    };
  await layer.update(liveView);
  renderer ??= await api.PointCloudRenderer.create(canvas);
  renderer.setLayers([layer]);
  await renderer.render(liveView);
  cameraHome = structuredClone(liveView);
  cameraAngle = 0;
  cameraZoom = 1;
  return { layer, renderer, view: liveView };
}
async function rendering() {
  await show();
  const bytes = await renderer.readRgba(),
    counts = { red: 0, green: 0, blue: 0 };
  for (let i = 0; i < bytes.length; i += 4) {
    if (bytes[i] > 200 && bytes[i + 1] < 10) counts.red++;
    if (bytes[i + 1] > 200 && bytes[i] < 10) counts.green++;
    if (bytes[i + 2] > 200 && bytes[i] < 10) counts.blue++;
  }
  const picks = [];
  for (const x of [128, 320, 512]) picks.push(await renderer.pick(x, 240));
  const before = await hash(bytes),
    base = renderer.getStats();
  const styles = {};
  for (const mode of ["rgb", "elevation", "intensity", "classification"]) {
    layer.setStyle({ pointSize: 18, colorMode: mode });
    await renderer.render(liveView);
    const pixels = await renderer.readRgba();
    styles[mode] = Array.from(
      pixels.slice((240 * 640 + 320) * 4, (240 * 640 + 320) * 4 + 3),
    );
  }
  layer.setStyle({ pointSize: 18, colorMode: "rgb" });
  await renderer.render(liveView);
  let lost = false;
  if (globalThis.__loseW16Device) {
    await globalThis.__loseW16Device();
    for (let i = 0; i < 100 && !renderer.getStats().deviceLost; i++)
      await new Promise((r) => setTimeout(r, 1));
    lost = renderer.getStats().deviceLost;
  }
  await renderer.recover();
  const after = await hash(await renderer.readRgba());
  for (let i = 0; i < 30; i++) {
    renderer.setLayers([layer]);
    await renderer.render(liveView);
  }
  const stable = renderer.getStats();
  const pressure = await gpuPressure(layer.snapshot().nodes[0].buffer.data());
  renderer.resize(320, 240);
  await renderer.render(liveView);
  const resized = (await renderer.readRgba()).length;
  renderer.setLayers([]);
  const cleared = renderer.getStats();
  renderer.dispose();
  const disposed = renderer.getStats();
  layer.dispose();
  pool.dispose();
  renderer = undefined;
  layer = undefined;
  pool = undefined;
  return {
    counts,
    picks,
    before,
    after,
    lost,
    base,
    stable,
    resized,
    cleared,
    disposed,
    pressure,
    styles,
  };
}
async function gpuPressure(points) {
  const bounds = { min: [-1, -1, -1], max: [1, 1, 1] },
    root = {
      key: "0-0-0-0",
      bounds,
      pointCount: 3,
      spacing: 1,
      depth: 0,
      children: ["1-0-0-0"],
    },
    child = {
      ...root,
      key: "1-0-0-0",
      depth: 1,
      pointCount: 2000,
      children: [],
    };
  const dataset = {
    bounds,
    totalPoints: 2003,
    crs: undefined,
    rootNode: () => root,
    async children(key) {
      return key === root.key ? [child] : [];
    },
    async readPoints(key) {
      return key === root.key ? points : { positions: new Float64Array(6000) };
    },
    dispose() {},
  };
  const l = new api.PointCloudLayer(dataset, {
      mode: "replace",
      pointBudget: 5000,
      style: { pointSize: 8 },
    }),
    r = await api.PointCloudRenderer.create(new OffscreenCanvas(64, 64), {
      memoryBudgetBytes: 80 * 1024,
    });
  const far = { ...liveView, position: [0, 0, 10000] },
    near = { ...liveView, position: [0, 0, 5] };
  try {
    await l.update(far);
    r.setLayers([l]);
    await r.render(far);
    const before = await hash(await r.readRgba()),
      baseline = r.getStats().gpuBytes;
    await l.update(near);
    let code;
    try {
      r.setLayers([l]);
    } catch (e) {
      code = e.code;
    }
    await r.render(near);
    const after = await hash(await r.readRgba());
    const pick = await r.pick(32, 32);
    await r.recover();
    const recovered = await hash(await r.readRgba());
    return {
      code,
      before,
      after,
      recovered,
      baseline,
      bytes: r.getStats().gpuBytes,
      pick,
      peak: r.getStats().peakGpuBytes,
      budget: r.memoryBudgetBytes,
    };
  } finally {
    r.dispose();
    l.dispose();
  }
}
async function meshRendering() {
  const tiles = new api.Tiles3dLayer(
      await api.loadTileset(url("tileset.json")),
      { origin: [0, 0, 0], ownsTileset: true },
    ),
    scene = api.Forge3DScene.create(),
    r = await api.Forge3DRuntime.create(new OffscreenCanvas(256, 160), {
      width: 256,
      height: 160,
      devicePixelRatio: 1,
    });
  try {
    await tiles.update({
      position: [0, 0, 10],
      viewportHeight: 160,
      fovY: Math.PI / 4,
    });
    tiles.addMeshesToScene(scene);
    r.setScene(scene.snapshot());
    r.setCamera({
      position: [4.5, 6.5, 0],
      target: [4.5, 6.5, -5],
      up: [0, 1, 0],
      near: 0.1,
      far: 100,
      fovYDegrees: 45,
    });
    const frame = await r.capture({ samples: 1, aovs: ["id"] });
    const ids = frame.aovFrame.id();
    let covered = 0;
    for (const id of ids) if (id >= api.AOV_ID_SCENE_NODE_BASE) covered++;
    r.setScatterBatches([]);
    const empty = await r.capture({ samples: 1, aovs: ["id"] });
    let negative = 0;
    for (const id of empty.aovFrame.id())
      if (id >= api.AOV_ID_SCENE_NODE_BASE) negative++;
    return { covered, negative, triangles: tiles.stats().triangles };
  } finally {
    r.dispose();
    scene.dispose();
    tiles.dispose();
  }
}
async function failures() {
  const results = {};
  for (const [name, run] of Object.entries({
    range: () =>
      api.openCopc(url("ellipsoid.copc.laz"), {
        fetch: async () => new Response(new Uint8Array(1000000)),
      }),
    cancel: () => {
      const a = new AbortController();
      a.abort();
      return api.openCopc(url("ellipsoid.copc.laz"), { signal: a.signal });
    },
    budget: () => api.openCopc(url("ellipsoid.copc.laz"), { maxBytes: 100 }),
    corrupt: async () => {
      const d = await api.openCopc(url("ellipsoid.copc.laz"));
      try {
        const h = d.header;
        return await api.decodeLazChunk(
          new Uint8Array(h.recordLength + 8),
          h,
          5,
        );
      } finally {
        d.dispose();
      }
    },
  })) {
    try {
      await run();
      results[name] = "unexpected-success";
    } catch (e) {
      results[name] = { code: e.code, reason: e.details?.reason };
    }
  }
  return results;
}
async function workload() {
  const manifest = await (await fetch(url("copc-ept-tiles-v1.json"))).json(),
    owner = workerPool(),
    d = await api.openEpt(url("workload-ept/ept.json"), {
      workerPool: owner.pool,
    });
  try {
    const nodes = [];
    for (const expected of manifest.workloadEpt.nodes) {
      const p = await d.readPoints(expected.key);
      nodes.push({
        key: expected.key,
        count: p.positions.length / 3,
        positions: await hash(p.positions),
        colors: await hash(p.colors),
      });
    }
    const cameras = [];
    let layerCameras = 0,
      cullingDifferences = 0;
    for (const record of manifest.cameraSelections.filter(
      (r) => r.source === "workload-ept",
    )) {
      let selected;
      if (record.options.mode === "add") {
        const l = new api.PointCloudLayer(d, record.options);
        try {
          selected = await l.update(record.view);
          const withoutFrustum = await new api.PointCloudTraverser(
            record.options,
          ).visibleNodes(d, { ...record.view, viewProjection: undefined });
          if (
            selected
              .map((n) => n.key)
              .sort()
              .join() !==
            withoutFrustum
              .map((n) => n.key)
              .sort()
              .join()
          )
            cullingDifferences++;
          layerCameras++;
        } finally {
          l.dispose();
        }
      } else
        selected = await new api.PointCloudTraverser(
          record.options,
        ).visibleNodes(d, record.view);
      cameras.push(
        selected.map((n) => ({
          key: n.key,
          pointCount: n.pointCount,
          sse: Number(n.sse.toFixed(manifest.sseDecimalPlaces)),
        })),
      );
    }
    return {
      count: d.totalPoints,
      nodes,
      cameras,
      manifest,
      layerCameras,
      cullingDifferences,
    };
  } finally {
    d.dispose();
    owner.dispose();
  }
}
async function tileReferences() {
  const corpus = await (await fetch(url('tile-traversal-v2.json'))).json(), actual = [];
  for (const [name, document] of Object.entries(corpus.documents)) {
    const tiles = api.Tileset.fromJson(document, url('tileset.json'));
    try {
      for (const record of corpus.records.filter(r => r.document === name)) {
        actual.push(new api.TilesetTraverser(record.options).visibleTiles(tiles, record.view)
          .map(n => ({ uri: n.tile.content.uri.split('/').at(-1), depth: n.depth, sse: Number(n.sse.toFixed(9)) })));
      }
    } finally { tiles.dispose(); }
  }
  return { actual, expected: corpus.records.map(r => r.nodes), coverage: corpus.coverage };
}
async function soak(durationMs = 600000, targetProfile = "reference-discrete") {
  layer?.dispose();
  pool?.dispose();
  pool = workerPool();
  const manifest = await (await fetch(url("copc-ept-tiles-v1.json"))).json(),
    keyframes = manifest.cameraSelections.filter(
      (r) => r.source === "workload-ept" && r.options.mode === "add",
    ),
    dataset = await api.openEpt(url("workload-ept/ept.json"), {
      workerPool: pool.pool,
    });
  if (!manifest.performance.profiles[targetProfile])
    throw Error("Unknown W16 target profile");
  layer = new api.PointCloudLayer(dataset, {
    ownsDataset: true,
    ...keyframes[0].options,
    style: { pointSize: 2, colorMode: "elevation" },
  });
  liveView = keyframes[0].view;
  renderer ??= await api.PointCloudRenderer.create(canvas);
  renderer.resize(1920, 1080);
  const start = performance.now(),
    times = [],
    phaseTimes = { update: [], upload: [], render: [] },
    selections = new Set(),
    visited = new Set();
  let frames = 0,
    maxBytes = 0,
    maxCpuBytes = 0;
  let nextProgressMs = 60000;
  let minPoints = Infinity,
    maxPoints = 0;
  let baseline = 0;
  while (performance.now() - start < durationMs) {
    const frameStart = performance.now(),
      index = Math.floor(frames / 30) % 64,
      t = (frames % 30) / 30,
      v =
        t === 0
          ? keyframes[index].view
          : interpolateTopdown(
              keyframes[index].view,
              keyframes[(index + 1) % 64].view,
              t,
              layer.origin[2],
            );
    visited.add(index);
    const selected = await layer.update(v);
    const updated = performance.now();
    if (
      frames % 30 === 0 &&
      JSON.stringify(
        selected.map((n) => ({
          key: n.key,
          pointCount: n.pointCount,
          sse: Number(n.sse.toFixed(9)),
        })),
      ) !== JSON.stringify(keyframes[index].nodes)
    )
      throw Error(
        "Soak selection differs from the independent ADD/frustum oracle",
      );
    renderer.setLayers([layer]);
    const uploaded = performance.now();
    await renderer.render(v);
    const elapsed = performance.now() - frameStart;
    phaseTimes.update.push(updated - frameStart);
    phaseTimes.upload.push(uploaded - updated);
    phaseTimes.render.push(performance.now() - uploaded);
    times.push(elapsed);
    layer.recordFrameTime(elapsed);
    const layerStats = layer.stats();
    selections.add([...layerStats.selectedKeys].sort().join(","));
    minPoints = Math.min(minPoints, layerStats.pointsRendered);
    maxPoints = Math.max(maxPoints, layerStats.pointsRendered);
    if (
      layerStats.pointsRendered > keyframes[index].options.pointBudget ||
      !layerStats.selectedKeys.includes("0-0-0-0")
    )
      throw Error("Soak lost its coarse root or exceeded point budget");
    frames++;
    const frameStats = renderer.getStats(false);
    maxBytes = Math.max(maxBytes, frameStats.gpuBytes);
    maxCpuBytes = Math.max(
      maxCpuBytes,
      layerStats.cpuBytes +
        dataset.stats().decoded.cacheUsed +
        dataset.stats().compressed.bytes,
    );
    baseline = Math.max(baseline, frameStats.gpuBytes);
    const progressMs = performance.now() - start;
    if (progressMs >= nextProgressMs) {
      const ordered = [...times].sort((a, b) => a - b);
      console.log("W16 progress " + JSON.stringify({
        elapsedMs: Math.round(progressMs), frames,
        frameP95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))],
        keyframesVisited: visited.size, maxCpuBytes,
        peakGpuBytes: frameStats.peakGpuBytes,
      }));
      nextProgressMs += 60000;
    }
    await new Promise(requestAnimationFrame);
  }
  times.sort((a, b) => a - b);
  const pixels = await renderer.readRgba();
  let coveredPixels = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] >= 20 || pixels[i + 1] >= 20 || pixels[i + 2] >= 20)
      coveredPixels++;
  const stats = renderer.getStats(),
    adapter = await navigator.gpu.requestAdapter(),
    info = adapter.info;
  const result = {
    durationMs: performance.now() - start,
    frames,
    baseline,
    maxBytes,
    maxCpuBytes,
    stats,
    frameP95Ms: times[Math.ceil(times.length * 0.95) - 1],
    measurement: { coldStartIncluded: true, timedStages: ['camera', 'layer.update (including fetch/decode misses)', 'setLayers', 'render through onSubmittedWorkDone'], presentationWaitBetweenSamples: true },
    phases: Object.fromEntries(Object.entries(phaseTimes).map(([name, values]) => {
      values.sort((a, b) => a - b);
      return [name, { p50Ms: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) }];
    })),
    selectionCount: selections.size,
    keyframesVisited: visited.size,
    totalPoints: dataset.totalPoints,
    minPoints,
    maxPoints,
    coveredPixels,
    dataset: dataset.stats(),
    viewport: [1920, 1080],
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
    profile: "local-chromium-preflight",
    targetProfile,
    budgets: manifest.performance.profiles[targetProfile],
    referenceHardwareQualified: false,
    qualification:
      "W00 reference hardware is not inferred from a preflight run",
  };
  renderer.dispose();
  result.disposed = renderer.getStats();
  layer.dispose();
  pool.dispose();
  renderer = layer = pool = undefined;
  return result;
}
function interpolateTopdown(a, b, t, centerZ) {
  const [x, y, z] = a.position.map((v, i) => v + (b.position[i] - v) * t),
    height = z - centerZ,
    near = 0.01 * height,
    far = 8 * height,
    f = 1 / Math.tan(a.fovY / 2),
    depth = far / (near - far);
  return {
    ...a,
    position: [x, y, z],
    viewProjection: [
      f / (16 / 9),
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      depth,
      -1,
      (-x * f) / (16 / 9),
      -y * f,
      -z * depth + (near * far) / (near - far),
      z,
    ],
  };
}
window.__w16 = {
  api,
  io,
  ranged,
  show,
  rendering,
  failures,
  workload,
  soak,
  meshRendering,
  tileReferences,
};
status.textContent = "Ready. Choose a dataset.";
document.querySelector("#demo").onclick = () =>
  show()
    .then(
      () => (status.textContent = JSON.stringify(renderer.getStats(), null, 2)),
    )
    .catch((e) => (status.textContent = String(e)));
document.querySelector("#real").onclick = () =>
  show(true)
    .then(
      () => (status.textContent = JSON.stringify(renderer.getStats(), null, 2)),
    )
    .catch((e) => (status.textContent = String(e)));
async function restyle() {
  if (!layer) return;
  layer.setStyle({
    pointSize: Number(document.querySelector("#size").value),
    colorMode: document.querySelector("#style").value,
  });
  await renderer.render(liveView);
}
document.querySelector("#style").onchange = restyle;
document.querySelector("#size").oninput = restyle;
canvas.onclick = async (e) => {
  if (dragged) {
    dragged = false;
    return;
  }
  if (!renderer) return;
  const r = canvas.getBoundingClientRect(),
    pick = await renderer.pick(
      Math.floor(((e.clientX - r.left) / r.width) * canvas.width),
      Math.floor(((e.clientY - r.top) / r.height) * canvas.height),
    );
  status.textContent = JSON.stringify(
    pick ?? { message: "Background" },
    null,
    2,
  );
};
function queueCamera() {
  if (cameraQueued || !renderer || !layer) return;
  cameraQueued = true;
  requestAnimationFrame(async () => {
    cameraQueued = false;
    const c = Math.cos(cameraAngle),
      s = Math.sin(cameraAngle),
      origin = layer.origin,
      m = [...cameraHome.viewProjection],
      sx = m[0] * cameraZoom,
      sy = m[5] * cameraZoom;
    m[0] = sx * c;
    m[4] = -sx * s;
    m[1] = sy * s;
    m[5] = sy * c;
    m[12] = -sx * (origin[0] * c - origin[1] * s);
    m[13] = -sy * (origin[0] * s + origin[1] * c);
    const v = {
      ...cameraHome,
      position: [
        origin[0],
        origin[1],
        origin[2] + (cameraHome.position[2] - origin[2]) / cameraZoom,
      ],
      viewProjection: m,
    };
    try {
      await layer.update(v);
      renderer.setLayers([layer]);
      await renderer.render(v);
      liveView = v;
      status.textContent = JSON.stringify(
        { layer: layer.stats(), renderer: renderer.getStats() },
        null,
        2,
      );
    } catch (e) {
      if (e.code !== "REQUEST_CANCELLED") status.textContent = String(e);
    }
  });
}
canvas.onpointerdown = (e) => {
  drag = { x: e.clientX };
  dragged = false;
  canvas.setPointerCapture(e.pointerId);
};
canvas.onpointermove = (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 1) dragged = true;
  cameraAngle += dx * 0.008;
  drag.x = e.clientX;
  queueCamera();
};
canvas.onpointerup = () => (drag = undefined);
canvas.onpointercancel = () => (drag = undefined);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    cameraZoom = Math.max(
      0.25,
      Math.min(8, cameraZoom * Math.exp(-e.deltaY * 0.001)),
    );
    queueCamera();
  },
  { passive: false },
);
canvas.onkeydown = (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    cameraAngle += e.key === "ArrowLeft" ? -0.1 : 0.1;
    e.preventDefault();
    queueCamera();
  }
  if (e.key === "+" || e.key === "-") {
    cameraZoom = Math.max(
      0.25,
      Math.min(8, cameraZoom * (e.key === "+" ? 1.1 : 1 / 1.1)),
    );
    e.preventDefault();
    queueCamera();
  }
};
window.addEventListener(
  "pagehide",
  () => {
    renderer?.dispose();
    layer?.dispose();
    pool?.dispose();
  },
  { once: true },
);
