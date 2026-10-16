import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW06PackageProbe: () => Promise<any>;
  }
}

test("W06 public-API consumer: capture, offline, EXR, frames and video", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/examples/test-w06-package.html");
  const result = await page.evaluate(() => window.__forge3dW06PackageProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.capture.hdrError).toBeLessThanOrEqual(1e-5);
  expect(result.capture.id).toBe(true);
  expect(result.capture.normalY).toBe(1);
  expect(result.capture.channels).toEqual(["albedo", "normal", "depth", "id", "motion"]);
  expect(result.offline).toEqual({ samplesUsed: 4, denoiser: "atrous" });
  expect(result.exr).toEqual({ channels: 14, software: "forge3d-web", mse: 0 });
  expect(result.frames.count).toBe(6);
  expect(result.frames.timestampsUs).toEqual([0, 100000, 200000, 300000, 400000, 500000]);
  expect(result.frames.names[5]).toBe("frame_0005.png");
  if (result.video.ok) {
    expect(result.video.frameCount).toBe(6);
    expect(result.video.mimeType).toBe("video/webm");
  } else {
    expect(result.video.code).toBe("UNSUPPORTED_FEATURE");
    expect(result.video.kind).toBe("video-codec-unavailable");
  }
  expect(pageErrors).toEqual([]);
});
