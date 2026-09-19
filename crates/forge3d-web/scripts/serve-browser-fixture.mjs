import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoutes = new Map([
  ["index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
  [
    "lifecycle-viewer.html",
    { file: "lifecycle-viewer.html", contentType: "text/html; charset=utf-8", lifecycle: true },
  ],
  [
    "lifecycle-away.html",
    { file: "lifecycle-away.html", contentType: "text/html; charset=utf-8", lifecycle: true },
  ],
  [
    "viewer-bfcache-lifecycle.js",
    { file: "viewer-bfcache-lifecycle.js", contentType: "text/javascript; charset=utf-8", lifecycle: true },
  ],
  [
    "adapter-attestation.js",
    { file: "adapter-attestation.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "hardware-page-harness.js",
    { file: "hardware-page-harness.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "saf02-conformance.js",
    { file: "saf02-conformance.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "viewer-benchmark-browser.js",
    { file: "viewer-benchmark-browser.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "chr03-lanes.js",
    { file: "chr03-lanes.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "chr04-lanes.js",
    { file: "chr04-lanes.js", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "package.sha256",
    { file: "package.sha256", contentType: "text/plain; charset=utf-8" },
  ],
  [
    "forge3d_web_bg.wasm",
    { file: "forge3d_web_bg.wasm", contentType: "application/wasm" },
  ],
  [
    "wrong-mime/forge3d_web_bg.wasm",
    { file: "forge3d_web_bg.wasm", contentType: "application/octet-stream" },
  ],
  [
    "terrain.bin",
    { file: "terrain.bin", contentType: "application/octet-stream", ranges: true },
  ],
  [
    "terrain-range.bin",
    { file: "terrain-range.bin", contentType: "application/octet-stream", ranges: true },
  ],
]);
const assetNameRoutes = new Map([
  [
    "terrain.bin",
    { file: "terrain.bin", contentType: "application/octet-stream", ranges: true },
  ],
  [
    "terrain-range.bin",
    { file: "terrain-range.bin", contentType: "application/octet-stream", ranges: true },
  ],
  [
    "forge3d_web_bg.wasm",
    { file: "forge3d_web_bg.wasm", contentType: "application/wasm" },
  ],
]);

export function resolveFixtureResponse({
  role,
  fixtureRoot,
  applicationHost,
  assetHost,
  basePath,
  request,
  state = createFixtureState(),
}) {
  assertConfiguration({ role, applicationHost, assetHost, basePath });
  const expectedHost = role === "application" ? applicationHost : assetHost;
  if (request.host !== expectedHost) {
    return response(421, commonHeaders(), Buffer.from("misdirected request\n"));
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return response(
      405,
      { ...commonHeaders(), Allow: "GET, HEAD, OPTIONS" },
      Buffer.from("method not allowed\n"),
    );
  }
  const parsedUrl = new URL(request.url, `https://${expectedHost}`);
  if (!parsedUrl.pathname.startsWith(basePath)) {
    return response(404, commonHeaders(), Buffer.from("not found\n"));
  }
  const relativePath = parsedUrl.pathname.slice(basePath.length) || "index.html";
  if (relativePath.includes("..") || relativePath.includes("\\")) {
    return response(404, commonHeaders(), Buffer.from("not found\n"));
  }
  if (role === "application") {
    return applicationResponse({
      fixtureRoot,
      relativePath,
      request,
      applicationHost,
      state,
    });
  }
  return assetResponse({
    fixtureRoot,
    relativePath,
    request,
    applicationHost,
  });
}

export function createFixtureState() {
  return { wasmRetryGets: new Map() };
}

function applicationResponse({ fixtureRoot, relativePath, request, applicationHost, state }) {
  if (
    request.origin &&
    request.origin !== `https://${applicationHost}`
  ) {
    return response(403, commonHeaders(), Buffer.from("origin denied\n"));
  }
  if (request.method === "OPTIONS") {
    return response(405, { ...commonHeaders(), Allow: "GET, HEAD" }, Buffer.alloc(0));
  }
  if (/^saf02\/retry\/[0-9a-f]{32}\/forge3d_web_bg\.wasm$/u.test(relativePath)) {
    const key = relativePath;
    const attempts = state.wasmRetryGets.get(key) ?? 0;
    if (request.method === "GET") state.wasmRetryGets.set(key, attempts + 1);
    return fileResponse({
      fixtureRoot,
      route: {
        file: "forge3d_web_bg.wasm",
        contentType: attempts === 0 ? "application/octet-stream" : "application/wasm",
      },
      request,
      headers: {
        ...commonHeaders(),
        "Content-Type": attempts === 0 ? "application/octet-stream" : "application/wasm",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
  const route = resolveApplicationRoute(relativePath);
  if (!route) {
    return response(404, commonHeaders(), Buffer.from("not found\n"));
  }
  return fileResponse({
    fixtureRoot,
    route,
    request,
    headers: {
      ...commonHeaders(route.lifecycle === true),
      "Content-Type": route.contentType,
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

function assetResponse({ fixtureRoot, relativePath, request, applicationHost }) {
  const match = relativePath.match(
    /^cors\/(allow|deny|wrong-origin)\/(?:(range-exact|range-ignored|range-416)\/)?(terrain(?:-range)?\.bin|forge3d_web_bg\.wasm)$/u,
  );
  if (!match) {
    return response(404, commonHeaders(), Buffer.from("not found\n"));
  }
  if (request.origin !== `https://${applicationHost}`) {
    return response(403, commonHeaders(), Buffer.from("origin denied\n"));
  }
  const policy = match[1];
  const control = match[2] ?? null;
  const route = assetNameRoutes.get(match[3]);
  const headers = {
    ...commonHeaders(),
    "Content-Type": route.contentType,
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  applyCorsPolicy(headers, policy, applicationHost);
  if (request.method === "OPTIONS") {
    if (policy === "allow") {
      headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Range";
      headers["Access-Control-Max-Age"] = "0";
    }
    return response(204, headers, Buffer.alloc(0));
  }
  if (control === "range-416" && request.range) {
    const body = readFileSync(resolve(fixtureRoot, route.file));
    return response(416, {
      ...headers,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${body.length}`,
    }, Buffer.alloc(0));
  }
  if (control === "range-ignored" && request.range) {
    return fileResponse({
      fixtureRoot,
      route: { ...route, ranges: false },
      request: { ...request, range: undefined },
      headers,
    });
  }
  return fileResponse({ fixtureRoot, route, request, headers });
}

function applyCorsPolicy(headers, policy, applicationHost) {
  if (policy === "deny") {
    return;
  }
  headers["Access-Control-Allow-Origin"] =
    policy === "allow"
      ? `https://${applicationHost}`
      : "https://invalid.example";
  headers.Vary = "Origin";
  if (policy === "allow") {
    headers["Access-Control-Expose-Headers"] =
      "Accept-Ranges, Content-Length, Content-Range";
  }
}

function fileResponse({ fixtureRoot, route, request, headers }) {
  const root = resolve(fixtureRoot);
  const path = resolve(root, route.file);
  const relativePath = relative(root, path);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("fixture route escaped its root");
  }
  const body = readFileSync(path);
  if (route.ranges) {
    headers["Accept-Ranges"] = "bytes";
  }
  const range = route.ranges ? parseRange(request.range, body.length) : null;
  if (request.range && !range) {
    return response(
      416,
      { ...headers, "Content-Range": `bytes */${body.length}` },
      Buffer.alloc(0),
    );
  }
  if (range) {
    const slice = body.subarray(range.start, range.end + 1);
    return response(
      206,
      {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${body.length}`,
        "Content-Length": String(slice.length),
      },
      request.method === "HEAD" ? Buffer.alloc(0) : slice,
    );
  }
  return response(
    200,
    { ...headers, "Content-Length": String(body.length) },
    request.method === "HEAD" ? Buffer.alloc(0) : body,
  );
}

function resolveApplicationRoute(relativePath) {
  const fixed = applicationRoutes.get(relativePath);
  if (fixed) return fixed;
  if (
    /^node_modules\/@forge3d\/web\/dist\/[a-z0-9_-]+\.(?:js|wasm)$/u.test(
      relativePath,
    )
  ) {
    return {
      file: relativePath,
      contentType: relativePath.endsWith(".wasm")
        ? "application/wasm"
        : "text/javascript; charset=utf-8",
    };
  }
  if (
    /^tests\/browser\/benchmark\/benchmark-(?:manifest-v1\.json|terrain-v1\.f32le|trace-v1\.json)$/u.test(
      relativePath,
    )
  ) {
    return {
      file: relativePath,
      contentType: relativePath.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "application/octet-stream",
    };
  }
  return null;
}

function parseRange(value, length) {
  if (!value) return null;
  const match = value.match(/^bytes=([0-9]+)-([0-9]*)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : length - 1;
  const end = Math.min(requestedEnd, length - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    return null;
  }
  return { start, end };
}

function commonHeaders(cacheCompatible = false) {
  return {
    "Cache-Control": cacheCompatible ? "private, max-age=0" : "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function response(status, headers, body) {
  return { status, headers, body };
}

function assertConfiguration({ role, applicationHost, assetHost, basePath }) {
  if (!["application", "asset"].includes(role)) {
    throw new Error("role must be application or asset");
  }
  if (
    !/^[a-z0-9-]+\.webgpu-ci\.forge3d\.dev$/u.test(applicationHost) ||
    !/^assets-[a-z0-9-]+\.webgpu-ci\.forge3d\.dev$/u.test(assetHost)
  ) {
    throw new Error("hosts must be checked browser-lab DNS names");
  }
  if (!/^\/runs\/[1-9][0-9]*\/[1-9][0-9]*\/[0-9a-f]{32}\/$/u.test(basePath)) {
    throw new Error("base path must contain run ID, job ID, and 128-bit nonce");
  }
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
  const port = Number(args.get("--port"));
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("--port must be a positive integer");
  }
  const configuration = {
    role: args.get("--role"),
    fixtureRoot: args.get("--fixture-root"),
    applicationHost: args.get("--application-host"),
    assetHost: args.get("--asset-host"),
    basePath: args.get("--base-path"),
  };
  const state = createFixtureState();
  assertConfiguration(configuration);
  const server = createServer((request, result) => {
    try {
      const resolved = resolveFixtureResponse({
        ...configuration,
        state,
        request: {
          method: request.method,
          url: request.url,
          host: request.headers.host,
          origin: request.headers.origin,
          range: request.headers.range,
        },
      });
      result.writeHead(resolved.status, resolved.headers);
      result.end(resolved.body);
    } catch {
      result.writeHead(500, commonHeaders());
      result.end("internal fixture error\n");
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, role: configuration.role, port }));
  });
}
