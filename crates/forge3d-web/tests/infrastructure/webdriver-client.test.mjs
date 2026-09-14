import assert from "node:assert/strict";
import test from "node:test";

import { WebDriverClient } from "../../scripts/webdriver-client.mjs";

test("WebDriver health reads live session URL on every probe", async () => {
  const requests = [];
  const client = new WebDriverClient("http://127.0.0.1:4445", async (url, options) => {
    requests.push([url, options.method]);
    if (options.method === "POST") {
      return response(200, { value: { sessionId: "s1", capabilities: {} } });
    }
    return response(200, { value: "https://fixture.example/runs/1/2/abc/" });
  });
  const session = await client.createSession({ browserName: "safari" });
  assert.equal(await session.currentUrl(), "https://fixture.example/runs/1/2/abc/");
  assert.equal(await session.currentUrl(), "https://fixture.example/runs/1/2/abc/");
  assert.deepEqual(requests.map((entry) => entry[1]), ["POST", "GET", "GET"]);
});

test("WebDriver health fails closed on disappearance, HTTP, malformed, and timeout", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("private socket details"); },
    async () => response(500, { value: { error: "unknown error" } }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error("private body"); } }),
    async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private timeout")));
    }),
  ]) {
    const client = new WebDriverClient("http://127.0.0.1:4445", fetchImpl, 1);
    await assert.rejects(
      () => client.request("GET", "/session/s1/url"),
      /INFRA_ERROR WEBDRIVER_REQUEST_FAILED GET/u,
    );
  }
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
