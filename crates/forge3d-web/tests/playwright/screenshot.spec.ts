import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __forge3dScreenshotProbe: () => Promise<{
      supported: boolean;
      type: string;
      size: number;
      signature: number[];
      disposedCode?: string;
      width: number;
      height: number;
    }>;
  }
}

test("captures a PNG Blob screenshot and rejects after dispose", async ({
  page
}) => {
  await page.goto("/examples/test-screenshot.html");

  const result = await page.evaluate(() => window.__forge3dScreenshotProbe());

  expect(result.supported).toBeTruthy();
  expect(result.type).toBe("image/png");
  expect(result.size).toBeGreaterThan(100);
  expect(result.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(result.disposedCode).toBe("RUNTIME_DISPOSED");
  expect(result.width).toBe(77);
  expect(result.height).toBe(53);
});
