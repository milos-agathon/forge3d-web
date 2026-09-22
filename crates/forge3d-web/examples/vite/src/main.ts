import { Forge3DError, Forge3DRuntime, TerrainDataset } from "@forge3d/web";

const canvas = document.querySelector<HTMLCanvasElement>("#forge3d-canvas");

if (!canvas) {
  throw new Error("Forge3D canvas is missing");
}

const DEM_WIDTH = 65;
const DEM_HEIGHT = 65;

function buildDem(): Float32Array {
  const heights = new Float32Array(DEM_WIDTH * DEM_HEIGHT);
  for (let y = 0; y < DEM_HEIGHT; y += 1) {
    for (let x = 0; x < DEM_WIDTH; x += 1) {
      heights[y * DEM_WIDTH + x] = Math.fround(
        Math.sin(x / 8) + Math.cos(y / 10) + 0.002 * x * y
      );
    }
  }
  return heights;
}

async function main(): Promise<void> {
  if (!navigator.gpu) {
    canvas.replaceWith(document.createTextNode("WebGPU is not available."));
    return;
  }

  const heights = buildDem();
  const direct = TerrainDataset.fromArray({
    width: DEM_WIDTH,
    height: DEM_HEIGHT,
    heights,
    spacing: [30, 30],
    colormap: "terrain"
  });

  const bytes = new Uint8Array(heights.slice().buffer);
  const fromFile = await TerrainDataset.fromSource({
    width: DEM_WIDTH,
    height: DEM_HEIGHT,
    source: new File([bytes], "dem.f32le", {
      type: "application/octet-stream"
    }),
    spacing: [30, 30]
  });

  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  let fromUrl: TerrainDataset;
  try {
    fromUrl = await TerrainDataset.fromSource({
      width: DEM_WIDTH,
      height: DEM_HEIGHT,
      source: blobUrl,
      spacing: [30, 30]
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const runtime = await Forge3DRuntime.create(canvas, {
    width: 640,
    height: 360,
    devicePixelRatio: window.devicePixelRatio || 1,
    clearColor: [0.08, 0.12, 0.16, 1]
  });

  runtime.setTerrain({
    ...direct.toTerrainInput(),
    heightAo: { enabled: true },
    sunVisibility: { enabled: true }
  });
  runtime.setCamera({
    position: [0, 2600, 2600],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovYDegrees: 50,
    near: 1,
    far: 12000
  });
  runtime.render();

  const slopeAspect = direct.slopeAspect();
  const query = fromUrl.query(0, 0);
  const heightsBack = await runtime.readTerrainHeights();
  const analysis = await runtime.computeTerrainAnalysis(
    fromFile.toTerrainInput(),
    { kind: "height-ao", options: { enabled: true } }
  );

  console.log("forge3d terrain example", {
    statistics: direct.statistics,
    fileCount: fromFile.statistics.count,
    urlCount: fromUrl.statistics.count,
    slope: slopeAspect.slopeRadians[32 * DEM_WIDTH + 32],
    query,
    readbackSamples: heightsBack.length,
    analysisKind: analysis.kind
  });
}

main().catch((error: unknown) => {
  const normalized = Forge3DError.from(error);
  console.error(normalized.code, normalized.message);
});
