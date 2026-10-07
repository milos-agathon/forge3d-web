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
      for (const c of [...fixture.cases,...fixture.published.cases]) {
        const output = await crs.transformCoords(c.points, c.source, c.target);
        const difference = Math.max(...output.flat().map((n,i)=>Math.abs(n-c.expected.flat()[i])));
        if (["EPSG:4326","EPSG:4277"].includes(c.target)) geographicError = Math.max(geographicError,difference);
        else projectedError = Math.max(projectedError,difference);
        if (!["EPSG:4326","EPSG:4277"].includes(c.target)) {
          const back = await crs.transformCoords(output,c.target,c.source);
          const again = await crs.transformCoords(back,c.source,c.target);
          roundTripError = Math.max(roundTripError,...again.flat().map((n,i)=>Math.abs(n-output.flat()[i])));
        }
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
  async alignment() {
    const canvas=document.createElement("canvas");canvas.width=256;canvas.height=256;document.body.append(canvas);
    const r=await api.Forge3DRuntime.create(canvas,{width:256,height:256,devicePixelRatio:1});
    const t=fixture.terrain;
    // Distinct east/west and north/south slopes plus an off-center summit.
    const heights=Float32Array.from({length:t.width*t.height},(_,i)=>{
      const col=i%t.width,row=Math.floor(i/t.width);
      return 2+.5*col+.25*row+18*Math.exp(-((col-8)**2+(row-12)**2)/20);
    });
    const terrain=api.TerrainDataset.fromArray({...t,heights,domain:[0,40],renderMode:"perspective"});
    // Independent raster control samples: center, northwest, southeast.
    const sampleIndices=[16*t.width+16,12*t.width+8,20*t.width+24];
    const expectedHeights=sampleIndices.map(i=>heights[i]+1);
    const layers=new VectorLayers();
    const feature=(id,position)=>({id,kind:"point",position});
    const style={pointSize:14,color:[1,0,0,1],drape:true,drapeOffset:1};
    const frame=async()=>{r.render();return {rgba:Array.from(await r.readRgba()),pick:await r.readVectorPickMap()};};
    const heightError=pick=>{
      let maximum=0;
      for(let i=0;i<pick.ids.length;i++)if(pick.ids[i])
        maximum=Math.max(maximum,Math.abs(pick.worldPositions[i*3+1]-expectedHeights[pick.ids[i]-701]));
      return maximum;
    };
    try {
      r.setTerrain(terrain);
      r.setCamera({position:[0,450,0],target:[0,0,0],up:[0,0,-1],fovYDegrees:50,near:.1,far:2000});
      const input={name:"geographic",crs:"EPSG:4326",features:t.points.map((p,i)=>feature(701+i,[p[0],0,p[1]])),style};
      layers.add(input);
      const before=JSON.stringify(layers.snapshot());
      // The ordinary runtime entry point discovers the source and terrain CRS.
      await r.setVectorLayers(layers);
      const geographic=await frame();
      const crs=await CrsTransformer.create({cache:cache()});
      let labelError,labelCount;
      try {
        const labels=await reprojectLabelFeatures(crs,t.points.map((p,i)=>({id:i+1,properties:{name:String(i)},type:"Point",coordinates:[...p,0]})),"EPSG:4326",terrain);
        labelCount=labels.labels.length;
        labelError=Math.max(...labels.labels.map((f,i)=>Math.max(Math.abs(f.geometry.coordinates[0]-t.world[i][0]),Math.abs(f.geometry.coordinates[1]-t.world[i][1]))));
      } finally {crs.dispose();}
      // Reference heights come directly from raster indices, bypassing draping.
      const manual=new VectorLayers();manual.add({name:"local",features:t.world.map((p,i)=>feature(701+i,[p[0],expectedHeights[i],p[1]])),style:{...style,drape:false}});
      r.setVectorLayers(manual,terrain);
      const reference=await frame();
      const bad=layers.snapshot();bad.layers[0].crs="EPSG:99999999";
      const failure=await error(()=>r.setVectorLayers(bad));
      const afterFailure=await frame();
      const pending=error(()=>r.setVectorLayers(layers));
      r.setVectorLayers(manual,terrain);
      const cancelled=await pending;
      const afterCancel=await frame();
      const absolute=new VectorLayers();absolute.add({name:"broken absolute",features:t.world.map((p,i)=>feature(701+i,[500000+p[0],0,terrain.transform[3]-165-p[1]])),style});
      r.setVectorLayers(absolute,terrain);
      const negative=await frame();
      const visible=p=>Array.from(p.ids).filter(id=>id>0).length;
      const axisControls=[];
      for(const axis of ["east-west","north-south"]){
        const reversed=Float32Array.from(heights,(_,i)=>{
          const col=i%t.width,row=Math.floor(i/t.width);
          return heights[(axis==="north-south" ? t.height-1-row : row)*t.width+(axis==="east-west" ? t.width-1-col : col)];
        });
        const flipped=api.TerrainDataset.fromArray({...t,heights:reversed,domain:[0,40],renderMode:"perspective"});
        r.setTerrain(flipped);
        await r.setVectorLayers(layers);
        const result=await frame();
        axisControls.push({axis,pickPixels:visible(result.pick),heightError:heightError(result.pick),
          rgbaEqual:result.rgba.every((v,i)=>v===reference.rgba[i])});
      }
      const ids=Array.from(new Set(geographic.pick.ids)).filter(id=>id>0).sort();
      return {ids,labelError,labelCount,failure,cancelled,expectedHeights,heightError:heightError(geographic.pick),axisControls,
        failureAtomic:reference.rgba.every((v,i)=>v===afterFailure.rgba[i]),
        cancelAtomic:reference.rgba.every((v,i)=>v===afterCancel.rgba[i]),pickPixels:visible(geographic.pick),referencePixels:visible(reference.pick),negativePixels:visible(negative.pick),
        pickEqual:Array.from(geographic.pick.ids).every((v,i)=>v===reference.pick.ids[i]),
        rgbaEqual:geographic.rgba.every((v,i)=>v===reference.rgba[i]),inputIntact:before===JSON.stringify(layers.snapshot()),
        terrainVisible:reference.rgba.filter((v,i)=>i%4!==3&&v!==reference.rgba[i%4]).length>1000};
    } finally {r.dispose();layers.dispose();canvas.remove();}
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
        systemGridError: Math.max(...(await crs.transformCoords(fixture.grid.crsControl.points,fixture.grid.crsControl.source,fixture.grid.crsControl.target)).flat().map((n,i)=>Math.abs(n-fixture.grid.crsControl.expected.flat()[i]))),
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
