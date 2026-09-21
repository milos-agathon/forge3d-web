import {
  copyFileSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoWorkspaceDependencies } from "./assemble-browser-package-artifact.mjs";

export function materializeBrowserFixture({
  consumerDirectory,
  packageSha256,
}) {
  if (!/^[0-9a-f]{64}$/u.test(packageSha256 ?? "")) {
    throw new Error("package SHA-256 must be 64 lowercase hex characters");
  }
  const root = resolve(consumerDirectory);
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  assertNoWorkspaceDependencies(packageJson);
  const packageRoot = join(root, "node_modules", "@forge3d", "web");
  for (const path of [
    packageJsonPath,
    join(packageRoot, "dist", "index.js"),
    join(packageRoot, "dist", "forge3d_web.js"),
    join(packageRoot, "dist", "forge3d_web_bg.wasm"),
    join(root, "test-interactive-viewer.html"),
    join(root, "test-lifecycle-away.html"),
    join(root, "tests", "webdriver", "safari-viewer.mjs"),
    join(root, "node_modules", "selenium-webdriver", "package.json"),
    join(
      root,
      "tests",
      "browser",
      "benchmark",
      "benchmark-terrain-v1.f32le",
    ),
  ]) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`browser fixture input must be a regular file: ${path}`);
    }
  }
  const sourceHtml = readFileSync(
    join(root, "test-interactive-viewer.html"),
    "utf8",
  );
  const seleniumPackage = JSON.parse(readFileSync(
    join(root, "node_modules", "selenium-webdriver", "package.json"),
    "utf8",
  ));
  if (seleniumPackage.name !== "selenium-webdriver" || seleniumPackage.version !== "4.35.0") {
    throw new Error("browser fixture must materialize exact selenium-webdriver 4.35.0");
  }
  const nonceRelativeHtml = sourceHtml.replaceAll(
    '"/node_modules/',
    '"./node_modules/',
  );
  if (
    !nonceRelativeHtml.includes(
      '"./node_modules/@forge3d/web/dist/index.js"',
    )
  ) {
    throw new Error("browser fixture import map is not nonce-path relative");
  }
  writeFileSync(join(root, "index.html"), nonceRelativeHtml, {
    encoding: "utf8",
    mode: 0o600,
  });
  const lifecycleModule = "./viewer-bfcache-lifecycle.js";
  const lifecycleInstaller = `  <script type="module">
      import { installViewerBfcacheLifecycle } from "${lifecycleModule}";
      installViewerBfcacheLifecycle(window.__forge3dInteractiveViewer);
    </script>`;
  const lifecycleHtml = nonceRelativeHtml.includes("</body>")
    ? nonceRelativeHtml.replace("</body>", `${lifecycleInstaller}\n  </body>`)
    : `${nonceRelativeHtml}\n${lifecycleInstaller}\n`;
  writeFileSync(join(root, "lifecycle-viewer.html"), lifecycleHtml, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    join(root, "lifecycle-away.html"),
    "<!doctype html><meta charset=\"utf-8\"><title>Forge3D lifecycle away</title><p>away</p>\n",
    { encoding: "utf8", mode: 0o600 },
  );
  copyFileSync(join(packageRoot, "dist", "index.js"), join(root, "app.js"));
  copyFileSync(
    join(packageRoot, "dist", "forge3d_web_bg.wasm"),
    join(root, "forge3d_web_bg.wasm"),
  );
  copyFileSync(
    join(
      root,
      "tests",
      "browser",
      "benchmark",
      "benchmark-terrain-v1.f32le",
    ),
    join(root, "terrain.bin"),
  );
  const terrain = readFileSync(join(root, "terrain.bin"));
  writeFileSync(
    join(root, "terrain-range.bin"),
    Buffer.concat([Buffer.alloc(4), terrain]),
    { mode: 0o600 },
  );
  for (const file of [
    "adapter-attestation.js",
    "hardware-page-harness.js",
    "saf02-conformance.js",
    "viewer-benchmark-browser.js",
    "chr03-lanes.js",
    "chr04-lanes.js",
    "ffx03-lanes.js",
    "viewer-bfcache-lifecycle.js",
  ]) {
    const source = join(root, "tests", "browser", file);
    const stats = lstatSync(source);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`browser hardware module must be a regular file: ${source}`);
    }
    copyFileSync(source, join(root, file));
  }
  writeFileSync(
    join(root, "package.sha256"),
    `${packageSha256}  @forge3d-web-package.tgz\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    consumerDirectory: root,
    packageSha256,
    applicationEntry: "index.html",
    wasm: "forge3d_web_bg.wasm",
    terrain: "terrain.bin",
    rangedTerrain: "terrain-range.bin",
    benchmarkModule: "viewer-benchmark-browser.js",
    lifecycleViewer: "lifecycle-viewer.html",
    lifecycleAway: "lifecycle-away.html",
    safariAcceptanceModule: "tests/webdriver/safari-viewer.mjs",
    seleniumVersion: "4.35.0",
  };
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const record = materializeBrowserFixture({
    consumerDirectory: args.get("--consumer"),
    packageSha256: args.get("--package-sha256"),
  });
  console.log(JSON.stringify({ ok: true, ...record }));
}
