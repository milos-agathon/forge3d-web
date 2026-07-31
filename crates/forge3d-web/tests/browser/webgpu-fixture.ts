import { expect, test as base } from "@playwright/test";

import {
  collectPlaywrightLaunchDiagnostics,
  type PlaywrightLaunchDiagnostics,
} from "./playwright-launch-diagnostics";
import {
  launchFlagPresence,
  launchFlagsPresent,
  preflightLaunchIdentityConsistent,
  readForge3DBrowserProjectMetadata,
  resolveWebGpuRequired,
  type Forge3DBrowserProjectMetadata,
} from "./playwright-project-metadata";

interface AdapterDiagnostics {
  requestAttempted: boolean;
  acquired: boolean;
  fallback: boolean | null;
  identity: string | null;
  limits: Record<string, number>;
  error: { name: string; message: string } | null;
}

interface ViewerRuntimeDiagnostics {
  attempted: boolean;
  created: boolean;
  status: string | null;
  deviceState: string | null;
  diagnostics: {
    activeRuntimes: number;
    renderRequests: number;
    submittedFrames: number;
    skippedFrames: number;
  } | null;
  disposedStatus: string | null;
  activeRuntimesAfterDispose: number | null;
  error: { code: string | null; name: string; message: string } | null;
}

export interface WebGpuAvailability {
  project: Forge3DBrowserProjectMetadata;
  projectPolicyRequired: boolean;
  ambientRequired: boolean;
  required: boolean;
  hasNavigatorGpu: boolean;
  adapterAvailable: boolean;
  secureContext: boolean;
  userAgent: string;
}

export interface WebGpuDiagnostics extends WebGpuAvailability {
  browserVersion: string;
  adapter: AdapterDiagnostics;
  viewerRuntime: ViewerRuntimeDiagnostics;
  launch: {
    declaredEngine: "chromium" | "firefox" | "webkit";
    actualEngine: string;
    provenance: "live-browser" | "project-configuration" | null;
    configuredArguments: string[];
    effectiveArguments: string[];
    observationSource: string | null;
    observed: boolean;
    browserProcessId: number | null;
    preferenceMode: "default" | "override" | null;
    firefoxUserPrefs: Record<string, boolean> | null;
    supportLevel: "ENGINE_PASS" | "NOT_PROVEN" | null;
    flagPresence: ReturnType<typeof launchFlagPresence>;
    configuredLaunchFlagsPresent: boolean;
    effectiveLaunchFlagsPresent: boolean;
    configuredArgumentsObserved: boolean;
    preflightIdentityConsistent: boolean;
    sourceObservationConsistent: boolean;
    error: { name: string; message: string } | null;
  };
}

interface Forge3DFixtures {
  webgpuAvailability: WebGpuAvailability;
  webgpuCapabilityGuard: void;
  webgpuDiagnostics: WebGpuDiagnostics;
}

export function serializePlaywrightLaunchArguments(
  project: Pick<Forge3DBrowserProjectMetadata, "launchArgs">,
  launch: PlaywrightLaunchDiagnostics | undefined,
): { configuredArguments: string[]; effectiveArguments: string[] } {
  return {
    configuredArguments: [...project.launchArgs],
    effectiveArguments: [...(launch?.effectiveArguments ?? [])],
  };
}

export const test = base.extend<Forge3DFixtures>({
  webgpuAvailability: async ({ page }, use, testInfo) => {
    const project = readForge3DBrowserProjectMetadata(
      testInfo.project.metadata,
    );
    const ambientRequired =
      process.env.FORGE3D_WEBGPU_REQUIRED === "1";
    const projectPolicyRequired =
      project.lane === "branded" || project.webgpuRequired;
    const required = resolveWebGpuRequired(
      project,
      process.env.FORGE3D_WEBGPU_REQUIRED,
    );
    await page.goto("/examples/test-interactive-viewer.html");
    const availability = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      const adapter = gpu ? await gpu.requestAdapter() : null;
      return {
        hasNavigatorGpu: Boolean(gpu),
        adapterAvailable: Boolean(adapter),
        secureContext: window.isSecureContext,
        userAgent: navigator.userAgent,
      };
    });
    const result = {
      project,
      projectPolicyRequired,
      ambientRequired,
      required,
      ...availability,
    };
    await testInfo.attach("forge3d-webgpu-probe.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    if (required) {
      expect(
        result.hasNavigatorGpu,
        `${project.project} requires WebGPU but navigator.gpu is missing`,
      ).toBe(true);
      expect(
        result.adapterAvailable,
        `${project.project} requires WebGPU but no adapter is available`,
      ).toBe(true);
    }
    await use(result);
  },
  webgpuCapabilityGuard: [
    async ({ webgpuAvailability }, use) => {
      void webgpuAvailability;
      await use();
    },
    { auto: true },
  ],
  webgpuDiagnostics: async (
    { browser, page, webgpuAvailability },
    use,
    testInfo,
  ) => {
    let launch: PlaywrightLaunchDiagnostics | undefined;
    let launchError: { name: string; message: string } | null = null;
    try {
      launch = await collectPlaywrightLaunchDiagnostics(
        browser,
        webgpuAvailability.project,
      );
    } catch (error) {
      launchError = serializeNodeError(error);
    }
    const runtime = await page.evaluate(async () => {
      const serializeError = (error: unknown) => {
        const candidate =
          typeof error === "object" && error !== null
            ? (error as {
                code?: unknown;
                name?: unknown;
                message?: unknown;
              })
            : {};
        return {
          code:
            typeof candidate.code === "string" ? candidate.code : null,
          name:
            typeof candidate.name === "string"
              ? candidate.name
              : "Error",
          message:
            typeof candidate.message === "string"
              ? candidate.message
              : String(error),
        };
      };
      const gpu = navigator.gpu;
      let adapter: GPUAdapter | null = null;
      let adapterError: ReturnType<typeof serializeError> | null = null;
      if (gpu) {
        try {
          adapter = await gpu.requestAdapter();
        } catch (error) {
          adapterError = serializeError(error);
        }
      }
      const info = adapter?.info as
        | (GPUAdapterInfo & { isFallbackAdapter?: boolean })
        | undefined;
      const directFallback = (
        adapter as (GPUAdapter & { isFallbackAdapter?: boolean }) | null
      )?.isFallbackAdapter;
      const fallback =
        typeof directFallback === "boolean"
          ? directFallback
          : typeof info?.isFallbackAdapter === "boolean"
            ? info.isFallbackAdapter
            : null;
      const identity = [
        info?.vendor,
        info?.architecture,
        info?.device,
        info?.description,
      ]
        .filter(Boolean)
        .join(" / ");
      const adapterDiagnostics: AdapterDiagnostics = {
        requestAttempted: Boolean(gpu),
        acquired: Boolean(adapter),
        fallback,
        identity: identity || null,
        limits: adapter
          ? {
              maxTextureDimension2D:
                adapter.limits.maxTextureDimension2D,
              maxTextureArrayLayers:
                adapter.limits.maxTextureArrayLayers,
              maxBindGroups: adapter.limits.maxBindGroups,
              maxBindingsPerBindGroup:
                adapter.limits.maxBindingsPerBindGroup,
              maxBufferSize: adapter.limits.maxBufferSize,
              maxStorageBufferBindingSize:
                adapter.limits.maxStorageBufferBindingSize,
            }
          : {},
        error: adapterError,
      };

      let viewerRuntime: ViewerRuntimeDiagnostics = {
        attempted: true,
        created: false,
        status: null,
        deviceState: null,
        diagnostics: null,
        disposedStatus: null,
        activeRuntimesAfterDispose: null,
        error: null,
      };
      try {
        const viewer =
          await window.__forge3dInteractiveViewer.create({
            controls: false,
            resize: false,
          });
        const diagnostics = viewer.getDiagnostics();
        viewerRuntime = {
          ...viewerRuntime,
          created: true,
          status: viewer.status,
          deviceState: viewer.getCapabilities().deviceState,
          diagnostics: {
            activeRuntimes: diagnostics.activeRuntimes,
            renderRequests: diagnostics.renderRequests,
            submittedFrames: diagnostics.submittedFrames,
            skippedFrames: diagnostics.skippedFrames,
          },
        };
        viewer.dispose();
        viewerRuntime.disposedStatus = viewer.status;
        viewerRuntime.activeRuntimesAfterDispose =
          viewer.getDiagnostics().activeRuntimes;
      } catch (error) {
        viewerRuntime.error = serializeError(error);
      }
      return { adapter: adapterDiagnostics, viewerRuntime };
    });
    const { configuredArguments, effectiveArguments } =
      serializePlaywrightLaunchArguments(
        webgpuAvailability.project,
        launch,
      );
    const diagnostics: WebGpuDiagnostics = {
      ...webgpuAvailability,
      browserVersion: browser.version(),
      adapter: runtime.adapter,
      viewerRuntime: runtime.viewerRuntime,
      launch: {
        declaredEngine:
          launch?.declaredEngine ??
          (webgpuAvailability.project.browserName === "firefox"
            ? "firefox"
            : webgpuAvailability.project.browserName === "webkit"
              ? "webkit"
              : "chromium"),
        actualEngine:
          launch?.actualEngine ?? browser.browserType().name(),
        provenance: launch?.provenance ?? null,
        configuredArguments,
        effectiveArguments,
        observationSource: launch?.observationSource ?? null,
        observed: launch?.observed === true,
        browserProcessId: launch?.browserProcessId ?? null,
        preferenceMode:
          launch?.preferenceMode ??
          webgpuAvailability.project.preferenceMode ??
          null,
        firefoxUserPrefs:
          launch?.firefoxUserPrefs ??
          (webgpuAvailability.project.firefoxUserPrefs === undefined
            ? null
            : { ...webgpuAvailability.project.firefoxUserPrefs }),
        supportLevel:
          launch?.supportLevel ??
          webgpuAvailability.project.supportLevel ??
          null,
        flagPresence:
          launch?.flagPresence ??
          launchFlagPresence(
            configuredArguments,
            effectiveArguments,
          ),
        configuredLaunchFlagsPresent:
          launch?.configuredLaunchFlagsPresent ??
          launchFlagsPresent(configuredArguments),
        effectiveLaunchFlagsPresent:
          launch?.effectiveLaunchFlagsPresent ??
          launchFlagsPresent(effectiveArguments),
        configuredArgumentsObserved:
          launch?.configuredArgumentsObserved ?? false,
        preflightIdentityConsistent:
          launch?.preflightIdentityConsistent ??
          preflightLaunchIdentityConsistent(
            webgpuAvailability.project,
            configuredArguments,
            effectiveArguments,
          ),
        sourceObservationConsistent:
          launch?.sourceObservationConsistent ?? false,
        error: launchError,
      },
    };
    const serialized = JSON.stringify(diagnostics, null, 2);
    console.info("Forge3D WebGPU diagnostics", serialized);
    await testInfo.attach("forge3d-webgpu-diagnostics.json", {
      body: serialized,
      contentType: "application/json",
    });

    await use(diagnostics);

    expect(diagnostics.launch.error).toBeNull();
    expect(
      diagnostics.launch.actualEngine,
      `${diagnostics.project.project} launched the wrong Playwright engine`,
    ).toBe(diagnostics.launch.declaredEngine);
    expect(diagnostics.launch.sourceObservationConsistent).toBe(true);
    if (diagnostics.project.launchObservation === "chromium-live") {
      expect(
        diagnostics.launch.observed,
        `${diagnostics.project.project} did not expose effective Chromium launch arguments`,
      ).toBe(true);
      expect(diagnostics.launch.provenance).toBe("live-browser");
    } else {
      expect(diagnostics.launch.observed).toBe(false);
      expect(diagnostics.launch.provenance).toBe(
        "project-configuration",
      );
      expect(diagnostics.launch.effectiveArguments).toEqual([]);
    }
    expect(
      diagnostics.launch.configuredArgumentsObserved,
      diagnostics.project.launchObservation === "chromium-live"
        ? `${diagnostics.project.project} did not apply all configured launch arguments`
        : `${diagnostics.project.project} configuration-only evidence must not claim live launch-argument observation`,
    ).toBe(diagnostics.project.launchObservation === "chromium-live");
    expect(
      diagnostics.launch.preflightIdentityConsistent,
      "browser evidence with WebGPU-enabling flags must identify the chromium-preflight project",
    ).toBe(true);
    expect(
      diagnostics.launch.sourceObservationConsistent,
      `${diagnostics.project.project} source launch observation does not match its declared proof mode`,
    ).toBe(true);
    if (diagnostics.required) {
      expect(
        diagnostics.viewerRuntime.created,
        `${diagnostics.project.project} requires a working Forge3D viewer/runtime`,
      ).toBe(true);
    }
  },
});

export function skipRenderAssertionsWhenProbing(
  availability: WebGpuAvailability,
) {
  test.skip(
    !availability.required &&
      (!availability.hasNavigatorGpu || !availability.adapterAvailable),
    "Probe lane recorded unavailable WebGPU; render assertions are not applicable",
  );
}

export { expect };

function serializeNodeError(
  error: unknown,
): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
