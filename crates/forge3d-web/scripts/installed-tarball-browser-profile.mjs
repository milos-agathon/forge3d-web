const EVIDENCE_MODES = new Set(["required", "probe"]);
const BROWSER_CHANNELS = new Set(["chrome", "bundled"]);

export function resolveInstalledTarballBrowserProfile({
  evidenceMode,
  browserChannel,
  operatingSystem,
}) {
  if (!EVIDENCE_MODES.has(evidenceMode)) {
    throw new Error("evidenceMode must be either required or probe");
  }
  if (browserChannel !== undefined && !BROWSER_CHANNELS.has(browserChannel)) {
    throw new Error(
      "FORGE3D_BROWSER_CHANNEL must be either chrome or bundled",
    );
  }

  const resolvedChannel =
    browserChannel ?? (evidenceMode === "required" ? "chrome" : "bundled");
  if (evidenceMode === "required" && resolvedChannel === "bundled") {
    throw new Error(
      "required exact-tarball evidence cannot use bundled Chromium",
    );
  }

  if (evidenceMode === "required") {
    return {
      project: "installed-tarball-chrome-stable",
      lane: "required",
      browserName: "chrome",
      browserChannel: "chrome",
      playwrightChannel: "chrome",
      launchArguments: [],
      runtimeResult: "PASS",
    };
  }

  const launchArguments = [
    "--enable-unsafe-webgpu",
    ...(operatingSystem === "win32" ? ["--use-angle=d3d11"] : []),
  ];
  if (resolvedChannel === "chrome") {
    return {
      project: "installed-tarball-chrome-preflight",
      lane: "probe",
      browserName: "chrome",
      browserChannel: "chrome",
      playwrightChannel: "chrome",
      launchArguments,
      runtimeResult: "PROBE",
    };
  }

  return {
    project: "installed-tarball-chromium-preflight",
    lane: "probe",
    browserName: "chromium",
    browserChannel: "playwright",
    playwrightChannel: null,
    launchArguments,
    runtimeResult: "PROBE",
  };
}
