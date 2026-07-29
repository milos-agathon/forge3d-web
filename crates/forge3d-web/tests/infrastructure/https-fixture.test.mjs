import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createRunNonce } from "../../scripts/create-run-nonce.mjs";
import { validateRawFixtureProbe } from "../../scripts/probe-browser-fixture.mjs";
import { resolveFixtureResponse } from "../../scripts/serve-browser-fixture.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "forge3d-https-fixture-"));
writeFileSync(join(fixtureRoot, "index.html"), "<!doctype html>");
writeFileSync(join(fixtureRoot, "app.js"), "export {};");
writeFileSync(join(fixtureRoot, "package.sha256"), `${"c".repeat(64)}  package.tgz\n`);
mkdirSync(
  join(fixtureRoot, "node_modules", "@forge3d", "web", "dist"),
  { recursive: true },
);
writeFileSync(
  join(fixtureRoot, "node_modules", "@forge3d", "web", "dist", "index.js"),
  "export {};",
);
mkdirSync(join(fixtureRoot, "tests", "browser", "benchmark"), {
  recursive: true,
});
writeFileSync(
  join(
    fixtureRoot,
    "tests",
    "browser",
    "benchmark",
    "benchmark-manifest-v1.json",
  ),
  "{}",
);
writeFileSync(join(fixtureRoot, "forge3d_web_bg.wasm"), Buffer.from([0, 97, 115, 109]));
writeFileSync(join(fixtureRoot, "terrain.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const applicationHost = "mac-m2.webgpu-ci.forge3d.dev";
const assetHost = "assets-mac-m2.webgpu-ci.forge3d.dev";
const basePath = `/runs/10/20/${"a".repeat(32)}/`;
const configuration = {
  fixtureRoot,
  applicationHost,
  assetHost,
  basePath,
};

function request(role, path, overrides = {}) {
  return resolveFixtureResponse({
    role,
    ...configuration,
    request: {
      method: "GET",
      url: `${basePath}${path}`,
      host: role === "application" ? applicationHost : assetHost,
      origin:
        role === "asset" ? `https://${applicationHost}` : undefined,
      range: undefined,
      ...overrides,
    },
  });
}

test("nonce generation consumes exactly 16 bytes and rejects malformed or reused output", () => {
  let requestedBytes = null;
  const first = createRunNonce({
    runId: 10,
    jobId: 20,
    random: (bytes) => {
      requestedBytes = bytes;
      return Buffer.from("ab".repeat(16), "hex");
    },
  });
  assert.equal(requestedBytes, 16);
  assert.equal(first.basePath, `/runs/10/20/${"ab".repeat(16)}/`);
  assert.throws(
    () =>
      createRunNonce({
        runId: 10,
        jobId: 20,
        random: () => Buffer.alloc(15),
      }),
    /128 random bits/u,
  );
  const seen = new Set();
  const random = () => Buffer.alloc(16, 7);
  createRunNonce({ runId: 10, jobId: 20, random, seen });
  assert.throws(
    () => createRunNonce({ runId: 10, jobId: 21, random, seen }),
    /nonce reuse/u,
  );
});

test("application host, nonce path, MIME, cache, and method policy fail closed", () => {
  const wasm = request("application", "forge3d_web_bg.wasm");
  assert.equal(wasm.status, 200);
  assert.deepEqual(wasm.headers, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/wasm",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Length": "4",
  });
  assert.equal(
    request("application", "wrong-mime/forge3d_web_bg.wasm").headers[
      "Content-Type"
    ],
    "application/octet-stream",
  );
  assert.equal(
    request("application", "index.html", { host: assetHost }).status,
    421,
  );
  assert.equal(
    request("application", "index.html", {
      url: `/runs/10/20/${"b".repeat(32)}/index.html`,
    }).status,
    404,
  );
  assert.equal(
    request("application", "index.html", { method: "POST" }).status,
    405,
  );
  assert.equal(
    request(
      "application",
      "node_modules/@forge3d/web/dist/index.js",
    ).headers["Content-Type"],
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    request(
      "application",
      "tests/browser/benchmark/benchmark-manifest-v1.json",
    ).headers["Content-Type"],
    "application/json; charset=utf-8",
  );
});

test("asset allow route returns exact CORS and range headers", () => {
  const full = request("asset", "cors/allow/terrain.bin");
  assert.deepEqual(full.headers, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "application/octet-stream",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": `https://${applicationHost}`,
    Vary: "Origin",
    "Access-Control-Expose-Headers":
      "Accept-Ranges, Content-Length, Content-Range",
    "Accept-Ranges": "bytes",
    "Content-Length": "6",
  });
  const partial = request("asset", "cors/allow/terrain.bin", {
    range: "bytes=2-4",
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers["Content-Range"], "bytes 2-4/6");
  assert.equal(partial.headers["Content-Length"], "3");
  assert.deepEqual([...partial.body], [2, 3, 4]);
  const preflight = request("asset", "cors/allow/terrain.bin", {
    method: "OPTIONS",
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers["Access-Control-Allow-Methods"],
    "GET, HEAD, OPTIONS",
  );
  assert.equal(preflight.headers["Access-Control-Allow-Headers"], "Range");
});

test("deny and wrong-origin terrain and WASM policies remain browser-enforced", () => {
  for (const asset of ["terrain.bin", "forge3d_web_bg.wasm"]) {
    const deny = request("asset", `cors/deny/${asset}`);
    assert.equal(deny.status, 200);
    assert.equal(Object.hasOwn(deny.headers, "Access-Control-Allow-Origin"), false);
    const wrong = request("asset", `cors/wrong-origin/${asset}`);
    assert.equal(
      wrong.headers["Access-Control-Allow-Origin"],
      "https://invalid.example",
    );
  }
  assert.equal(
    request("asset", "cors/allow/terrain.bin", {
      origin: "https://invalid.example",
    }).status,
    403,
  );
});

test("raw readiness joins public-route policy to the promoted package digest", () => {
  const packageResponse = request("application", "package.sha256");
  const wasmResponse = request("application", "forge3d_web_bg.wasm");
  const rangeResponse = request("asset", "cors/allow/terrain.bin", {
    range: "bytes=1-3",
  });
  const denyResponse = request("asset", "cors/deny/terrain.bin");
  const wrongOriginResponse = request(
    "asset",
    "cors/wrong-origin/terrain.bin",
  );
  const normalize = (record) => ({
    status: record.status,
    headers: Object.fromEntries(
      Object.entries(record.headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    ),
    body: record.body.toString("utf8"),
  });
  const result = validateRawFixtureProbe({
    applicationHost,
    assetHost,
    basePath,
    expectedPackageSha256: "c".repeat(64),
    packageResponse: normalize(packageResponse),
    wasmResponse: normalize(wasmResponse),
    rangeResponse: normalize(rangeResponse),
    denyResponse: normalize(denyResponse),
    wrongOriginResponse: normalize(wrongOriginResponse),
  });
  assert.equal(result.ok, true);
  assert.throws(
    () =>
      validateRawFixtureProbe({
        applicationHost,
        assetHost,
        basePath,
        expectedPackageSha256: "d".repeat(64),
        packageResponse: normalize(packageResponse),
        wasmResponse: normalize(wasmResponse),
        rangeResponse: normalize(rangeResponse),
        denyResponse: normalize(denyResponse),
        wrongOriginResponse: normalize(wrongOriginResponse),
      }),
    /package SHA-256/u,
  );
});
