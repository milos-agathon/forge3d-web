import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

export function realmFixturePlugin(root) {
  let fixtureRoot;
  let wasmBytes;
  let assetFetches = 0;
  let bridgeFetches = 0;
  const heldResponses = new Map();
  const routeAttempts = new Map();

  return {
    name: "forge3d-realm-coordination-fixture",
    async configureServer(server) {
      fixtureRoot = mkdtempSync(join(tmpdir(), "forge3d-realm-fixture-"));
      await Promise.all([
        buildFacadeCopy(root, fixtureRoot, "a"),
        buildFacadeCopy(root, fixtureRoot, "b"),
      ]);
      wasmBytes = readFileSync(resolve(root, "pkg/forge3d_web_bg.wasm"));
      server.httpServer?.once("close", () => {
        rmSync(fixtureRoot, { recursive: true, force: true });
      });

      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://fixture.invalid");
        const bundleMatch = url.pathname.match(
          /^\/tests\/realm-fixture\/(a|b)\/index\.js$/u,
        );
        if (bundleMatch !== null) {
          response.setHeader("content-type", "text/javascript");
          response.end(
            readFileSync(join(fixtureRoot, bundleMatch[1], "index.js")),
          );
          return;
        }
        if (url.pathname === "/tests/realm-fixture/pkg/forge3d_web.js") {
          bridgeFetches += 1;
          response.setHeader("content-type", "text/javascript");
          response.end(readFileSync(resolve(root, "pkg/forge3d_web.js")));
          return;
        }
        if (url.pathname === "/tests/realm-fixture/metrics") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              assetFetches,
              bridgeFetches,
              held: [...heldResponses.keys()],
            }),
          );
          return;
        }
        if (url.pathname === "/tests/realm-fixture/release") {
          const id = url.searchParams.get("id") ?? "default";
          const held = heldResponses.get(id);
          if (held === undefined) {
            response.statusCode = 409;
            response.end("no held response");
            return;
          }
          heldResponses.delete(id);
          held.setHeader("content-type", "application/wasm");
          held.end(wasmBytes);
          response.statusCode = 204;
          response.end();
          return;
        }
        if (
          url.pathname === "/tests/realm-fixture/runtime.wasm" ||
          url.pathname === "/tests/realm-fixture/runtime-other.wasm" ||
          /^\/tests\/realm-fixture\/(?:a|b)\/forge3d_web_bg\.wasm$/u.test(url.pathname)
        ) {
          assetFetches += 1;
          const id = url.searchParams.get("id") ?? "default";
          const attempt = (routeAttempts.get(id) ?? 0) + 1;
          routeAttempts.set(id, attempt);
          if (id.startsWith("hold-")) {
            heldResponses.set(id, response);
            response.once("close", () => {
              if (heldResponses.get(id) === response) heldResponses.delete(id);
            });
            return;
          }
          if (id.startsWith("mime-retry-") && attempt === 1) {
            response.setHeader("content-type", "text/plain");
            response.end(wasmBytes);
            return;
          }
          response.setHeader("content-type", "application/wasm");
          response.end(wasmBytes);
          return;
        }
        next();
      });
    },
  };
}

async function buildFacadeCopy(root, fixtureRoot, copy) {
  await build({
    configFile: false,
    root,
    logLevel: "error",
    build: {
      target: "es2022",
      outDir: join(fixtureRoot, copy),
      emptyOutDir: true,
      lib: {
        entry: resolve(root, "src-ts/index.ts"),
        formats: ["es"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: {
          banner: `const __forge3dRealmFixtureCopy = ${JSON.stringify(copy)};`,
        },
      },
    },
  });
}
