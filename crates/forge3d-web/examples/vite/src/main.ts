import { Forge3DError, Forge3DRuntime } from "@forge3d/web";

const canvas = document.querySelector<HTMLCanvasElement>("#forge3d-canvas");

if (!canvas) {
  throw new Error("Forge3D canvas is missing");
}

async function main(): Promise<void> {
  if (!navigator.gpu) {
    canvas.replaceWith(document.createTextNode("WebGPU is not available."));
    return;
  }

  const runtime = await Forge3DRuntime.create(canvas, {
    width: 640,
    height: 360,
    devicePixelRatio: window.devicePixelRatio || 1,
    clearColor: [0.08, 0.12, 0.16, 1]
  });

  runtime.setTerrain({
    width: 4,
    height: 4,
    heights: new Float32Array([
      0, 0.1, 0.2, 0.1,
      0.2, 0.6, 0.9, 0.3,
      0.1, 0.8, 1.0, 0.4,
      0, 0.2, 0.4, 0.2
    ])
  });
  runtime.render();
}

main().catch((error: unknown) => {
  const normalized = Forge3DError.from(error);
  console.error(normalized.code, normalized.message);
});
