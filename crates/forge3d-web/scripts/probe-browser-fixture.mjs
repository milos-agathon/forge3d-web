import { connect } from "node:tls";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function probePublicCertificate(host, port = 443) {
  if (!/^[a-z0-9-]+\.webgpu-ci\.forge3d\.dev$/u.test(host)) {
    throw new Error("certificate probe host is outside checked browser-lab DNS");
  }
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        const certificate = socket.getPeerCertificate(true);
        const result = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ?? null,
          subject: certificate.subject?.CN ?? null,
          issuer: certificate.issuer?.CN ?? null,
          validFrom: certificate.valid_from,
          validTo: certificate.valid_to,
          fingerprint256: certificate.fingerprint256,
        };
        socket.end();
        if (!result.authorized || !result.issuer || !result.fingerprint256) {
          reject(new Error(`public certificate validation failed for ${host}`));
          return;
        }
        resolve(result);
      },
    );
    socket.once("error", reject);
  });
}

export function validateRawFixtureProbe({
  applicationHost,
  assetHost,
  basePath,
  expectedPackageSha256,
  packageResponse,
  wasmResponse,
  rangeResponse,
  denyResponse,
  wrongOriginResponse,
}) {
  if (
    !/^\/runs\/[1-9][0-9]*\/[1-9][0-9]*\/[0-9a-f]{32}\/$/u.test(basePath) ||
    !/^[0-9a-f]{64}$/u.test(expectedPackageSha256)
  ) {
    throw new Error("probe binding is malformed");
  }
  if (applicationHost === assetHost) {
    throw new Error("application and asset hosts must be distinct");
  }
  const packageHash = packageResponse.body.trim().split(/\s+/u)[0];
  if (packageResponse.status !== 200 || packageHash !== expectedPackageSha256) {
    throw new Error("served package SHA-256 does not match promoted package");
  }
  if (
    wasmResponse.status !== 200 ||
    wasmResponse.headers["content-type"] !== "application/wasm"
  ) {
    throw new Error("served WASM MIME is not application/wasm");
  }
  if (
    rangeResponse.status !== 206 ||
    !rangeResponse.headers["content-range"]?.startsWith("bytes 1-3/") ||
    rangeResponse.headers["access-control-allow-origin"] !==
      `https://${applicationHost}`
  ) {
    throw new Error("allowed CORS range response is not exact");
  }
  if (denyResponse.headers["access-control-allow-origin"] !== undefined) {
    throw new Error("deny route exposed an allow-origin header");
  }
  if (
    wrongOriginResponse.headers["access-control-allow-origin"] !==
    "https://invalid.example"
  ) {
    throw new Error("wrong-origin route did not return the fixed invalid origin");
  }
  return {
    ok: true,
    applicationHost,
    assetHost,
    basePath,
    packageSha256: expectedPackageSha256,
  };
}

async function fetchRecord(url, options) {
  const response = await fetch(url, options);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
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
  const binding = JSON.parse(readFileSync(args.get("--binding"), "utf8"));
  const applicationOrigin = `https://${binding.applicationHost}`;
  const assetOrigin = `https://${binding.assetHost}`;
  const app = (path) => `${applicationOrigin}${binding.basePath}${path}`;
  const asset = (path) => `${assetOrigin}${binding.basePath}${path}`;
  const [applicationCertificate, assetCertificate] = await Promise.all([
    probePublicCertificate(binding.applicationHost),
    probePublicCertificate(binding.assetHost),
  ]);
  const [packageResponse, wasmResponse, rangeResponse, denyResponse, wrongOriginResponse] =
    await Promise.all([
      fetchRecord(app("package.sha256")),
      fetchRecord(app("forge3d_web_bg.wasm")),
      fetchRecord(asset("cors/allow/terrain.bin"), {
        headers: {
          Origin: applicationOrigin,
          Range: "bytes=1-3",
        },
      }),
      fetchRecord(asset("cors/deny/terrain.bin"), {
        headers: { Origin: applicationOrigin },
      }),
      fetchRecord(asset("cors/wrong-origin/terrain.bin"), {
        headers: { Origin: applicationOrigin },
      }),
    ]);
  const result = validateRawFixtureProbe({
    ...binding,
    packageResponse: {
      ...packageResponse,
      body: packageResponse.body.toString("utf8"),
    },
    wasmResponse,
    rangeResponse,
    denyResponse,
    wrongOriginResponse,
  });
  console.log(
    JSON.stringify({
      ...result,
      certificates: {
        application: applicationCertificate,
        asset: assetCertificate,
      },
    }),
  );
}
