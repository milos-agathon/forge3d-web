import assert from "node:assert/strict";
import test from "node:test";

import { withIsolatedBrowserContext } from "../../scripts/edge-browser-acceptance.mjs";

for (const failurePoint of ["init", "page", "navigation", "assertion"]) {
  test(`isolated Edge diagnostic closes its context once when ${failurePoint} fails`, async () => {
    const expected = new Error(`${failurePoint} failed`);
    let closeCount = 0;
    const page = { goto: async () => {
      if (failurePoint === "navigation") throw expected;
    } };
    const context = {
      addInitScript: async () => {
        if (failurePoint === "init") throw expected;
      },
      newPage: async () => {
        if (failurePoint === "page") throw expected;
        return page;
      },
      close: async () => { closeCount += 1; },
    };
    const browser = { newContext: async () => context };

    await assert.rejects(
      withIsolatedBrowserContext({
        browser,
        fixtureUrl: "https://fixture.test/test-interactive-viewer.html",
        setup: () => undefined,
        inspect: async () => {
          if (failurePoint === "assertion") throw expected;
          return true;
        },
      }),
      (error) => error === expected,
    );
    assert.equal(closeCount, 1);
  });
}

test("isolated Edge diagnostic closes its context once after success", async () => {
  let closeCount = 0;
  const context = {
    addInitScript: async () => undefined,
    newPage: async () => ({ goto: async () => undefined }),
    close: async () => { closeCount += 1; },
  };
  const result = await withIsolatedBrowserContext({
    browser: { newContext: async () => context },
    fixtureUrl: "https://fixture.test/test-interactive-viewer.html",
    setup: () => undefined,
    inspect: async () => "observed",
  });
  assert.equal(result, "observed");
  assert.equal(closeCount, 1);
});
