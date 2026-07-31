import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import ts from "typescript";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "forge3d-hardware-page-harness-"),
);
writeFileSync(
  join(temporaryRoot, "adapter-attestation.js"),
  ts.transpileModule(
    readFileSync(
      join(packageRoot, "tests", "browser", "adapter-attestation.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
);
copyFileSync(
  join(packageRoot, "tests", "browser", "hardware-page-harness.js"),
  join(temporaryRoot, "hardware-page-harness.js"),
);
const { verifyBrowserRoute } = await import(
  pathToFileURL(join(temporaryRoot, "hardware-page-harness.js")).href
);
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

const packageSha256 = "a".repeat(64);
const applicationUrl =
  `https://mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${"b".repeat(32)}/`;
const assetUrl =
  `https://assets-mac-m2.webgpu-ci.forge3d.dev/runs/10/20/${"b".repeat(32)}/`;
const route = { applicationUrl, assetUrl };

test("hardware page invokes the public runtime loader in a fresh iframe realm", () => {
  const source = readFileSync(
    join(packageRoot, "tests", "browser", "hardware-page-harness.js"),
    "utf8",
  );
  assert.match(source, /document\.createElement\("iframe"\)/u);
  assert.match(source, /facade\.Forge3DRuntime\.create/u);
  assert.doesNotMatch(source, /WebAssembly\.compileStreaming/u);
});

test("page route uses isolated installed-package loader probes for all WASM controls", async () => {
  const loaderCalls = [];
  const result = await verifyBrowserRoute(route, packageSha256, {
    pageUrl: applicationUrl,
    secureContext: true,
    fetchImpl: fixtureFetch,
    loaderProbe: async (request) => {
      loaderCalls.push(request);
      if (request.wasmUrl.includes("/cors/allow/")) {
        return {
          ok: true,
          runtimeCreated: true,
          secureContext: true,
        };
      }
      return {
        ok: false,
        runtimeCreated: false,
        secureContext: true,
        normalizedForge3DError: true,
        code: "WASM_LOAD_FAILED",
      };
    },
  });

  assert.equal(result.secureContext, true);
  assert.equal(result.publicLoaderAllowedWasmPassed, true);
  assert.equal(result.wrongMimeErrorCode, "WASM_LOAD_FAILED");
  assert.equal(result.corsDenyWasmErrorCode, "WASM_LOAD_FAILED");
  assert.equal(result.corsWrongOriginWasmErrorCode, "WASM_LOAD_FAILED");
  assert.deepEqual(
    loaderCalls.map(({ facadeUrl, wasmUrl }) => ({ facadeUrl, wasmUrl })),
    [
      `${assetUrl}cors/allow/forge3d_web_bg.wasm`,
      `${applicationUrl}wrong-mime/forge3d_web_bg.wasm`,
      `${assetUrl}cors/deny/forge3d_web_bg.wasm`,
      `${assetUrl}cors/wrong-origin/forge3d_web_bg.wasm`,
    ].map((wasmUrl) => ({
      facadeUrl:
        `${applicationUrl}node_modules/@forge3d/web/dist/index.js`,
      wasmUrl,
    })),
  );
});

test("page route rejects insecure context and non-normalized loader failures", async () => {
  await assert.rejects(
    verifyBrowserRoute(route, packageSha256, {
      pageUrl: applicationUrl,
      secureContext: false,
      fetchImpl: () => {
        throw new Error("fetch must not run in an insecure context");
      },
    }),
    /not a secure context/u,
  );

  await assert.rejects(
    verifyBrowserRoute(route, packageSha256, {
      pageUrl: applicationUrl,
      secureContext: true,
      fetchImpl: fixtureFetch,
      loaderProbe: async ({ wasmUrl }) =>
        wasmUrl.includes("/cors/allow/")
          ? { ok: true, runtimeCreated: true, secureContext: true }
          : {
              ok: false,
              runtimeCreated: false,
              secureContext: true,
              normalizedForge3DError: false,
              code: "INTERNAL_ERROR",
            },
    }),
    /normalized Forge3DError WASM_LOAD_FAILED/u,
  );
});

test("page route rejects unsuccessful WASM responses even with the expected MIME", async () => {
  const loaderProbe = async ({ wasmUrl }) =>
    wasmUrl.includes("/cors/allow/")
      ? { ok: true, runtimeCreated: true, secureContext: true }
      : {
          ok: false,
          runtimeCreated: false,
          secureContext: true,
          normalizedForge3DError: true,
          code: "WASM_LOAD_FAILED",
        };
  await assert.rejects(
    verifyBrowserRoute(route, packageSha256, {
      pageUrl: applicationUrl,
      secureContext: true,
      fetchImpl: async (url) => {
        const response = await fixtureFetch(url);
        if (url === `${applicationUrl}forge3d_web_bg.wasm`) {
          return new Response(response.body, {
            status: 404,
            headers: { "Content-Type": "application/wasm" },
          });
        }
        return response;
      },
      loaderProbe,
    }),
    /MIME, package, range, or CORS proof failed/u,
  );
  await assert.rejects(
    verifyBrowserRoute(route, packageSha256, {
      pageUrl: applicationUrl,
      secureContext: true,
      fetchImpl: async (url) => {
        const response = await fixtureFetch(url);
        if (url === `${assetUrl}cors/allow/forge3d_web_bg.wasm`) {
          return new Response(response.body, {
            status: 404,
            headers: { "Content-Type": "application/wasm" },
          });
        }
        return response;
      },
      loaderProbe,
    }),
    /MIME, package, range, or CORS proof failed/u,
  );
});

async function fixtureFetch(url) {
  if (url === `${applicationUrl}package.sha256`) {
    return new Response(`${packageSha256}  package.tgz\n`, { status: 200 });
  }
  if (url === `${applicationUrl}forge3d_web_bg.wasm`) {
    return new Response(new Uint8Array([0, 97, 115, 109]), {
      status: 200,
      headers: { "Content-Type": "application/wasm" },
    });
  }
  if (url === `${assetUrl}cors/allow/terrain.bin`) {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { "Content-Range": "bytes 1-3/6" },
    });
  }
  if (url === `${assetUrl}cors/allow/forge3d_web_bg.wasm`) {
    return new Response(new Uint8Array([0, 97, 115, 109]), {
      status: 200,
      headers: { "Content-Type": "application/wasm" },
    });
  }
  if (
    url === `${assetUrl}cors/deny/terrain.bin` ||
    url === `${assetUrl}cors/wrong-origin/terrain.bin`
  ) {
    throw new TypeError("browser CORS rejection");
  }
  throw new Error(`unexpected fixture fetch: ${url}`);
}
