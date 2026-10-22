import { fileURLToPath } from "node:url";

export function verifyBrowserPreflightResults(results) {
  const required = ["build-and-contract", "chromium-preflight", "firefox-preflight"];
  if (!results || typeof results !== "object" ||
      Object.keys(results).sort().join(",") !== [...required].sort().join(",")) {
    throw new Error("Browser preflight requires the package build and both engine matrices");
  }
  for (const job of required) {
    if (results[job]?.result !== "success") {
      throw new Error(`${job} did not succeed: ${results[job]?.result ?? "missing"}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyBrowserPreflightResults(JSON.parse(process.env.FORGE3D_PREFLIGHT_RESULTS ?? "null"));
  console.log("Package build and all Chromium/Firefox shards passed");
}
