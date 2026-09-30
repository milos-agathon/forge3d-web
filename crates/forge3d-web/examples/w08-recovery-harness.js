// W08 device-loss recovery helpers shared by the VT and overlay harnesses:
// a Forge3DSession whose runtimes can be device-lost through the runtime
// test seam, a Forge3DViewer loss/recovery driver, and a VT residency
// settle loop (feedback readbacks land on event-loop turns).

import { Forge3DRuntime } from "../src-ts/index.ts";
import { simulateRuntimeDeviceLossForTests } from "../src-ts/runtime-internals.ts";
import {
  Forge3DSession,
  setSessionRuntimeFactoryForTests,
} from "../src-ts/session.ts";
import { simulateViewerDeviceLossForTests } from "../src-ts/viewer.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Session over real runtimes; `lose()` device-loses the live one and
 * resolves once the session has recovered. */
export async function createLosableSession(canvas, options) {
  const runtimes = [];
  setSessionRuntimeFactoryForTests(async (target, runtimeOptions) => {
    const runtime = await Forge3DRuntime.create(target, runtimeOptions);
    runtimes.push(runtime);
    return runtime;
  });
  let session;
  try {
    session = await Forge3DSession.create(canvas, {
      ...options,
      recovery: { deviceLoss: "once" },
    });
  } finally {
    setSessionRuntimeFactoryForTests(undefined);
  }
  return {
    session,
    runtimeCount: () => runtimes.length,
    async lose() {
      const lost = runtimes.at(-1);
      // Recovery creates the replacement through the factory again.
      setSessionRuntimeFactoryForTests(async (target, runtimeOptions) => {
        const runtime = await Forge3DRuntime.create(target, runtimeOptions);
        runtimes.push(runtime);
        return runtime;
      });
      try {
        simulateRuntimeDeviceLossForTests(lost);
        for (let i = 0; i < 120 && session.status === "ready"; i += 1) {
          await sleep(25);
        }
        await session.whenReady();
      } finally {
        setSessionRuntimeFactoryForTests(undefined);
      }
    },
  };
}

/** Device-lose a viewer and wait for its recovery to finish. */
export async function loseViewer(viewer) {
  simulateViewerDeviceLossForTests(viewer);
  // The device-lost callback is asynchronous: wait until the loss is
  // observed (status leaves "ready"), then for recovery.
  for (let i = 0; i < 120 && viewer.status === "ready"; i += 1) {
    await sleep(25);
  }
  for (let i = 0; i < 240 && viewer.status === "recovering"; i += 1) {
    await sleep(50);
  }
}

/** Render until VT residency stops changing for `stableFrames` frames. */
export async function settleVt(render, stats, stableFrames = 6) {
  let previous = "";
  let stable = 0;
  let frames = 0;
  while (stable < stableFrames && frames < 200) {
    render();
    await sleep(0);
    const s = stats();
    const key = `${s.residentPages}/${s.tilesStreamed}/${s.evictions}`;
    stable = key === previous ? stable + 1 : 0;
    previous = key;
    frames += 1;
  }
  return frames;
}

export function framesEqual(a, b) {
  if (a.length !== b.length) return { byteEqual: false, maxDiff: -1 };
  let maxDiff = 0;
  let diffCount = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) diffCount += 1;
    if (d > maxDiff) maxDiff = d;
  }
  return { byteEqual: maxDiff === 0, maxDiff, diffCount };
}

/** Decode a viewer screenshot PNG to raw RGBA without color management. */
export async function decodePngRgba(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext("2d", { colorSpace: "srgb" });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, surface.width, surface.height).data;
}
