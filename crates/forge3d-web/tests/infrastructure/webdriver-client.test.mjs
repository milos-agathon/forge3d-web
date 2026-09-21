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

test("WebDriver W3C actions are bounded and use standard endpoints", async () => {
  const requests = [];
  const client = new WebDriverClient("http://127.0.0.1:4445", async (url, options) => {
    requests.push([url, options.method, options.body]);
    if (url.endsWith("/element")) {
      return response(200, { value: { "element-6066-11e4-a52e-4f735466cecf": "canvas-1" } });
    }
    if (url.endsWith("/rect")) {
      return response(200, { value: { x: 1, y: 2, width: 320, height: 240 } });
    }
    return response(200, { value: null });
  });
  const session = new (await import("../../scripts/webdriver-client.mjs")).WebDriverSession(client, "s1", {});
  const element = await session.findElement("#viewer");
  assert.equal(element, "canvas-1");
  assert.equal((await session.elementRect(element)).width, 320);
  await session.performActions([{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pause", duration: 0 }] }]);
  await session.releaseActions();
  await session.back();
  await session.refresh();
  assert.throws(() => session.performActions([]), /between one and four/u);
  assert.throws(() => session.performActions([{ actions: Array.from({ length: 65 }, () => ({ type: "pause" })) }]), /between one and 64/u);
  assert.deepEqual(requests.map((entry) => entry[1]), ["POST", "GET", "POST", "DELETE", "POST", "POST"]);
});

test("WebDriver BFCache actions use the exact async-script and history endpoints", async () => {
  const requests = [];
  const client = new WebDriverClient("http://127.0.0.1:4446", async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/session") && options.method === "POST") {
      return response(200, { value: { sessionId: "firefox-1", capabilities: {} } });
    }
    if (url.endsWith("/execute/async")) {
      return response(200, { value: { ok: true, value: { cycle: 1 } } });
    }
    return response(200, { value: null });
  });
  const session = await client.createSession({ browserName: "firefox" });
  assert.deepEqual(
    await session.runBfcacheLifecycleAction("prepareViewerBfcacheCycle", [1]),
    { cycle: 1 },
  );
  await session.historyBack();
  assert.equal(requests[1].url, "http://127.0.0.1:4446/session/firefox-1/execute/async");
  const executeBody = JSON.parse(requests[1].body);
  assert.deepEqual(executeBody.args, ["prepareViewerBfcacheCycle", [1]]);
  assert.match(executeBody.script, /viewer-bfcache-lifecycle\.js/u);
  assert.deepEqual(requests[2], {
    url: "http://127.0.0.1:4446/session/firefox-1/back",
    method: "POST",
    body: "{}",
  });
  await assert.rejects(
    () => session.runBfcacheLifecycleAction("constructor"),
    /BFCACHE_ACTION_INVALID/u,
  );
});

test("WebDriver BFCache actions fail closed on page failure and timeout", async () => {
  const pageFailure = new WebDriverClient("http://127.0.0.1:4446", async (url) =>
    response(200, url.endsWith("/session")
      ? { value: { sessionId: "s1", capabilities: {} } }
      : { value: { ok: false, message: "private page detail" } }),
  );
  const failedSession = await pageFailure.createSession({ browserName: "firefox" });
  await assert.rejects(
    () => failedSession.runBfcacheLifecycleAction("prepareViewerBfcacheCycle", [1]),
    /INFRA_ERROR WEBDRIVER_BFCACHE_ACTION_FAILED/u,
  );

  const timeout = new WebDriverClient("http://127.0.0.1:4446", async (url, { signal }) => {
    if (url.endsWith("/session")) return response(200, { value: { sessionId: "s2", capabilities: {} } });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private"))));
  }, 1);
  const timeoutSession = await timeout.createSession({ browserName: "firefox" });
  await assert.rejects(
    () => timeoutSession.historyBack(),
    /INFRA_ERROR WEBDRIVER_REQUEST_FAILED POST/u,
  );
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
