import assert from "node:assert/strict";
import test from "node:test";

import { createPlaywrightHealthObserver } from "../../scripts/browser-session-runtime.mjs";

const routeUrl = "https://fixture.example/runs/10/20/abcdefabcdefabcdefabcdefabcdefab/";

test("Playwright health probes the original live capture page and permits background state", async () => {
  let probes = 0;
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      probes += 1;
      return `${routeUrl}index.html`;
    },
  };
  const observe = createPlaywrightHealthObserver({
    browser: { isConnected: () => true },
    page,
    routeUrl,
  });
  await observe();
  await observe();
  assert.equal(probes, 2);
});

test("Playwright health rejects closed, crashed, replacement, and unauthorized navigation", async () => {
  const cases = [
    {
      browser: { isConnected: () => false },
      page: page(routeUrl),
      code: "PLAYWRIGHT_CAPTURE_PAGE_UNAVAILABLE",
    },
    {
      browser: { isConnected: () => true },
      page: { isClosed: () => true, evaluate: async () => routeUrl },
      code: "PLAYWRIGHT_CAPTURE_PAGE_UNAVAILABLE",
    },
    {
      browser: { isConnected: () => true, pages: () => [page(routeUrl)] },
      page: { isClosed: () => true, evaluate: async () => routeUrl },
      code: "PLAYWRIGHT_CAPTURE_PAGE_UNAVAILABLE",
    },
    ...[
      "https://other.example/runs/10/20/abcdefabcdefabcdefabcdefabcdefab/",
      "https://fixture.example/runs/11/20/abcdefabcdefabcdefabcdefabcdefab/",
      "https://fixture.example/runs/10/20/11111111111111111111111111111111/",
      "https://fixture.example/runs/10/20/abcdefabcdefabcdefabcdefabcdefab/other",
    ].map((url) => ({
      browser: { isConnected: () => true },
      page: page(url),
      code: "PLAYWRIGHT_CAPTURE_PAGE_NAVIGATED",
    })),
  ];
  for (const value of cases) {
    await assert.rejects(
      createPlaywrightHealthObserver({ ...value, routeUrl }),
      new RegExp(`INFRA_ERROR ${value.code}`, "u"),
    );
  }
});

test("Playwright probe rejection and hang are bounded and sanitized", async () => {
  for (const capturePage of [
    { isClosed: () => false, evaluate: async () => { throw new Error("PRIVATE_SENTINEL"); } },
    { isClosed: () => false, evaluate: async () => new Promise(() => undefined) },
  ]) {
    await assert.rejects(
      createPlaywrightHealthObserver({
        browser: { isConnected: () => true },
        page: capturePage,
        routeUrl,
        timeoutMs: 1,
      }),
      (error) => {
        assert.equal(error.message, "INFRA_ERROR PLAYWRIGHT_CAPTURE_PAGE_PROBE_FAILED");
        assert.equal(error.message.includes("PRIVATE_SENTINEL"), false);
        return true;
      },
    );
  }
});

function page(url) {
  return { isClosed: () => false, evaluate: async () => url };
}
