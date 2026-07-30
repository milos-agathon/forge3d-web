export interface HttpsReadinessProbe {
  applicationOrigin: string;
  assetOrigin: string;
  basePath: string;
  expectedPackageSha256: string;
}

export async function runHttpsReadinessProbe(
  probe: HttpsReadinessProbe,
): Promise<Record<string, boolean>> {
  if (
    !/^https:\/\/[a-z0-9-]+\.webgpu-ci\.forge3d\.dev$/u.test(
      probe.applicationOrigin,
    ) ||
    !/^https:\/\/assets-[a-z0-9-]+\.webgpu-ci\.forge3d\.dev$/u.test(
      probe.assetOrigin,
    ) ||
    !/^\/runs\/[1-9][0-9]*\/[1-9][0-9]*\/[0-9a-f]{32}\/$/u.test(
      probe.basePath,
    ) ||
    !/^[0-9a-f]{64}$/u.test(probe.expectedPackageSha256)
  ) {
    throw new Error("HTTPS readiness probe input is not policy-bound");
  }
  const app = (path: string) =>
    `${probe.applicationOrigin}${probe.basePath}${path}`;
  const asset = (path: string) =>
    `${probe.assetOrigin}${probe.basePath}${path}`;
  const packageResponse = await fetch(app("package.sha256"), {
    cache: "no-store",
  });
  const wasmResponse = await fetch(app("forge3d_web_bg.wasm"), {
    cache: "no-store",
  });
  const rangeResponse = await fetch(asset("cors/allow/terrain.bin"), {
    cache: "no-store",
    headers: { Range: "bytes=1-3" },
  });
  const allowedWasm = await fetch(
    asset("cors/allow/forge3d_web_bg.wasm"),
    { cache: "no-store" },
  );
  const denyTerrain = await browserCorsFails(
    asset("cors/deny/terrain.bin"),
  );
  const wrongTerrain = await browserCorsFails(
    asset("cors/wrong-origin/terrain.bin"),
  );
  const denyWasm = await browserCorsFails(
    asset("cors/deny/forge3d_web_bg.wasm"),
  );
  const wrongWasm = await browserCorsFails(
    asset("cors/wrong-origin/forge3d_web_bg.wasm"),
  );
  const packageHash = (await packageResponse.text()).trim().split(/\s+/u)[0];
  const checks = {
    secureContext: globalThis.isSecureContext === true,
    packageHash:
      packageResponse.ok && packageHash === probe.expectedPackageSha256,
    wasmMime:
      wasmResponse.ok &&
      wasmResponse.headers.get("content-type")?.split(";", 1)[0] ===
        "application/wasm",
    corsTerrainAllow:
      rangeResponse.status === 206 &&
      rangeResponse.headers.get("content-range") !== null,
    corsTerrainDeny: denyTerrain,
    corsTerrainWrongOrigin: wrongTerrain,
    corsWasmAllow:
      allowedWasm.ok &&
      allowedWasm.headers.get("content-type")?.split(";", 1)[0] ===
        "application/wasm",
    corsWasmDeny: denyWasm,
    corsWasmWrongOrigin: wrongWasm,
    rangeExposed:
      rangeResponse.headers.get("content-range")?.startsWith("bytes 1-3/") ===
      true,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`HTTPS readiness probe failed: ${failed.join(", ")}`);
  }
  return checks;
}

async function browserCorsFails(url: string): Promise<boolean> {
  try {
    await fetch(url, { cache: "no-store" });
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}
