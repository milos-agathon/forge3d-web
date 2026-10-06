const api = await import(
  /* @vite-ignore */ location.search.includes("dist")
    ? "../dist/index.js"
    : "../src-ts/index.ts"
);
const {
  CrsTransformer,
  DatasetRegistry,
  IndexedDbByteCache,
  VectorLayers,
  reprojectLabelFeatures,
} = api;
const cache = () => new IndexedDbByteCache({ name: "forge3d-w14-acceptance" });
const fixture = await (
  await fetch("../tests/fixtures/w14/crs-epsg-v1.json")
).json();
const error = async (f) => {
  try {
    await f();
    return null;
  } catch (e) {
    return { code: e.code, message: e.message, details: e.details };
  }
};
const pipeline = fixture.grid.pipeline;
window.__w14 = {
  api,
  async coordinates() {
    const crs = await CrsTransformer.create({ cache: cache() });
    try {
      let projectedError = 0,
        geographicError = 0,
        roundTripError = 0;
      for (const c of fixture.cases) {
        const output = await crs.transformCoords(c.points, c.source, c.target);
        output
          .flat()
          .forEach(
            (n, i) =>
              (projectedError = Math.max(
                projectedError,
                Math.abs(n - c.expected.flat()[i]),
              )),
          );
        const back = await crs.transformCoords(output, c.target, c.source);
        back
          .flat()
          .forEach(
            (n, i) =>
              (geographicError = Math.max(
                geographicError,
                Math.abs(n - c.points.flat()[i]),
              )),
          );
        const again = await crs.transformCoords(back, c.source, c.target);
        again
          .flat()
          .forEach(
            (n, i) =>
              (roundTripError = Math.max(
                roundTripError,
                Math.abs(n - output.flat()[i]),
              )),
          );
      }
      const xy = await crs.transformCoords(
        [[9, 40]],
        "EPSG:4326",
        "EPSG:32632",
      );
      const axis = await crs.transformCoords(
        [[40, 9]],
        "EPSG:4326",
        "EPSG:32632",
        { alwaysXY: false },
      );
      const metadata = await crs.parseCrs(fixture.wkt.utm32),
        wkt = await crs.parseCrsFromWkt(fixture.wkt.wgs84);
      const original = new Float32Array([9, 40]),
        copy = await crs.transformCoords(original, "EPSG:4326", "EPSG:4326");
      const empty = await crs.transformCoords([], "EPSG:4326", "EPSG:32632");
      const errors = [];
      for (const call of [
        () => crs.transformCoords([[1, NaN]], "EPSG:4326", "EPSG:3857"),
        () => crs.transformCoords([[1]], "EPSG:4326", "EPSG:3857"),
        () => crs.parseCrs("EPSG:99999999"),
        () => crs.transformCoords([[1, 100]], "EPSG:4326", "EPSG:3857"),
      ])
        errors.push(await error(call));
      const large = await crs.transformCoords(
        new Float64Array(Array.from({ length: 10000 }, () => [9, 40]).flat()),
        "EPSG:4326",
        "EPSG:32632",
      );
      return {
        projectedError,
        geographicError,
        roundTripError,
        axisMatches: JSON.stringify(axis) === JSON.stringify(xy),
        metadata,
        wkt,
        copyIsFloat64: copy instanceof Float64Array,
        originalIntact: original.length === 2,
        empty,
        largeCount: large.length / 2,
        errors,
        diagnostics: crs.getDiagnostics(),
      };
    } finally {
      crs.dispose();
    }
  },
  async geometry() {
    const crs = await CrsTransformer.create({ cache: cache() });
    const layers = new VectorLayers();
    try {
      const collection = {
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "EPSG:4326" } },
        bbox: [8, 40, 10, 42],
        features: [
          {
            type: "Feature",
            id: "p",
            properties: { name: "point" },
            geometry: { type: "Point", coordinates: [9, 40, 120] },
          },
          { type: "Feature", id: "null", properties: {}, geometry: null },
          {
            type: "Feature",
            geometry: {
              type: "GeometryCollection",
              geometries: [
                {
                  type: "MultiPoint",
                  coordinates: [
                    [8, 40],
                    [10, 42],
                  ],
                },
                {
                  type: "LineString",
                  coordinates: [
                    [8, 40],
                    [9, 41],
                  ],
                },
                {
                  type: "MultiLineString",
                  coordinates: [
                    [
                      [8, 40],
                      [9, 41],
                    ],
                  ],
                },
                {
                  type: "Polygon",
                  coordinates: [
                    [
                      [8, 40],
                      [9, 40],
                      [9, 41],
                      [8, 40],
                    ],
                    [
                      [8.1, 40.1],
                      [8.2, 40.1],
                      [8.2, 40.2],
                      [8.1, 40.1],
                    ],
                  ],
                },
                {
                  type: "MultiPolygon",
                  coordinates: [
                    [
                      [
                        [8, 40],
                        [9, 40],
                        [9, 41],
                        [8, 40],
                      ],
                    ],
                  ],
                },
              ],
            },
          },
        ],
      };
      const before = JSON.stringify(collection),
        projected = await crs.reprojectGeometry(
          collection,
          "EPSG:4326",
          "EPSG:32632",
        ),
        back = await crs.reprojectGeometry(
          projected,
          "EPSG:32632",
          "EPSG:4326",
        );
      const input = {
        name: "geographic",
        crs: "EPSG:4326",
        features: [
          { id: 321, kind: "point", position: [9, 120, 40] },
          {
            id: 322,
            kind: "line",
            positions: [
              [8, 10, 40],
              [9, 20, 41],
            ],
          },
        ],
      };
      const layer = await layers.addGeospatial(
        input,
        { crs: "EPSG:32632" },
        crs,
      );
      const snapshot = layer.snapshot();
      const missingTarget = await error(() =>
        layers.addGeospatial(input, { crs: undefined }, crs),
      );
      const failure = await error(() =>
        layers.addGeospatial(
          { ...input, name: "invalid", crs: "EPSG:99999999" },
          "EPSG:32632",
          crs,
        ),
      );
      const labels = await reprojectLabelFeatures(
        crs,
        [
          {
            id: "label",
            properties: { name: "Fuji" },
            geometry: { type: "Point", coordinates: [9, 40, 120] },
          },
          ...["coordinates", "position", "world_pos"].map((key) => ({
            id: key,
            type: "Point",
            properties: { name: key },
            [key]: [9, 40, 120],
          })),
        ],
        "EPSG:4326",
        "EPSG:32632",
        { text: "name" },
      );
      return {
        projected,
        back,
        inputIntact: before === JSON.stringify(collection),
        snapshot,
        missingTarget,
        failure,
        layerCount: layers.snapshot().layers.length,
        labels: labels.labels,
        labelMetadata: labels.metadata,
      };
    } finally {
      crs.dispose();
      layers.dispose();
    }
  },
  async grids() {
    const crs = await CrsTransformer.create({ cache: cache() });
    try {
      return {
        shifted: await crs.transformPipeline(fixture.grid.points, pipeline),
        gridError: Math.max(
          ...(await crs.transformPipeline(fixture.grid.points, pipeline))
            .flat()
            .map((n, i) => Math.abs(n - fixture.grid.expected.flat()[i])),
        ),
        missing: await error(() =>
          crs.transformPipeline(
            [[-100, 40]],
            pipeline.replace("us_noaa_conus.tif", "not-present.tif"),
          ),
        ),
        bestMissing: await error(() =>
          crs.transformCoords([[-100, 40]], "EPSG:4267", "EPSG:4269"),
        ),
        optional: await error(() =>
          crs.transformCoords(
            [[-100, 40]],
            "+proj=longlat +ellps=clrk66 +nadgrids=@null",
            "EPSG:4326",
          ),
        ),
        invalid: await crs.parseCrsFromWkt('GEOGCRS["broken"]'),
      };
    } finally {
      crs.dispose();
    }
  },
  async datasets(offline = false) {
    const registry = new DatasetRegistry({ cache: cache() });
    try {
      const dem = await registry.miniDem({ offline }),
        boundaries = await registry.sampleBoundaries({ offline });
      return {
        width: dem.width,
        height: dem.height,
        min: Math.min(...dem.data),
        max: Math.max(...dem.data),
        boundaries: boundaries.features.length,
        names: registry.available(),
        digest: registry.info("mini_dem").sha256,
        diagnostics: registry.getDiagnostics(),
      };
    } finally {
      registry.dispose();
    }
  },
  async offline() {
    const crs = await CrsTransformer.create({ cache: cache(), offline: true });
    try {
      return {
        point: await crs.transformCoords([[9, 40]], "EPSG:4326", "EPSG:32632"),
        grid: await crs.transformPipeline([[-100, 40]], pipeline),
        datasets: await this.datasets(true),
        diagnostics: crs.getDiagnostics(),
      };
    } finally {
      crs.dispose();
    }
  },
  async lifetime() {
    const crs = await CrsTransformer.create({
      cache: cache(),
      maxPoints: 10000,
    });
    const controller = new AbortController();
    const cancelled = crs.transformCoords(
      new Float64Array(20000),
      "EPSG:4326",
      "EPSG:32632",
      { signal: controller.signal },
    );
    controller.abort();
    const cancellation = await error(() => cancelled),
      budget = await error(() =>
        crs.transformCoords(new Float64Array(20002), "EPSG:4326", "EPSG:32632"),
      );
    const queued = crs.transformCoords([[9, 40]], "EPSG:4326", "EPSG:32632");
    crs.dispose();
    crs.dispose();
    const disposal = await error(() => queued),
      after = await error(() => crs.parseCrs("EPSG:4326"));
    const tiny = await error(() =>
      CrsTransformer.create({ cache: cache(), memoryBudgetBytes: 16 }),
    );
    return {
      cancellation,
      budget,
      disposal,
      after,
      tiny,
      diagnostics: crs.getDiagnostics(),
    };
  },
  async lostDevice() {
    const crs = await CrsTransformer.create({ cache: cache() });
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      let lossReason = null;
      if (adapter) {
        const device = await adapter.requestDevice();
        device.destroy();
        lossReason = (await device.lost).reason;
      }
      return {
        point: await crs.transformCoords([[9, 40]], "EPSG:4326", "EPSG:32632"),
        gpuBytes: crs.getDiagnostics().gpuBytes,
        lossReason,
      };
    } finally {
      crs.dispose();
    }
  },
};
document.querySelector("#run")?.addEventListener("click", async () => {
  const output = document.querySelector("#result");
  output.textContent = "Loading…";
  try {
    const [coordinates, datasets] = await Promise.all([
      window.__w14.coordinates(),
      window.__w14.datasets(),
    ]);
    output.textContent = JSON.stringify(
      {
        fuji: await withFuji(),
        dem: {
          width: datasets.width,
          height: datasets.height,
          min: datasets.min,
          max: datasets.max,
        },
        maxProjectedError: coordinates.projectedError,
      },
      null,
      2,
    );
  } catch (e) {
    output.textContent = e.message;
  }
});
async function withFuji() {
  const crs = await CrsTransformer.create({ cache: cache() });
  try {
    return (
      await crs.transformCoords(
        [[138.7274, 35.3606]],
        "EPSG:4326",
        "EPSG:32654",
      )
    )[0];
  } finally {
    crs.dispose();
  }
}
