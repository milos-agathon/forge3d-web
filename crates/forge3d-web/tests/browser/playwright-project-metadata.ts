import {
  resolveEvidenceMode,
  type EvidenceMode,
} from "./evidence-mode";

export interface Forge3DBrowserProjectMetadata {
  project:
    | "chromium-preflight"
    | "chrome-stable"
    | "edge-stable"
    | "firefox-preflight"
    | "firefox-nightly-experimental"
    | "webkit-preflight";
  browserName: "chromium" | "chrome" | "edge" | "firefox" | "webkit";
  channel: "playwright" | "chrome" | "msedge";
  lane: "preflight" | "branded" | "experimental";
  launchObservation: "chromium-live" | "project-configuration";
  webgpuRequired: boolean;
  launchArgs: string[];
  preferenceMode?: "default" | "override";
  firefoxUserPrefs?: Record<string, boolean>;
  supportLevel?: "ENGINE_PASS" | "NOT_PROVEN";
}

export interface LaunchFlagPresence {
  configured: boolean;
  observed: boolean;
}

export type LaunchFlagCategory =
  | "unsafeWebGpu"
  | "gpuBlocklistBypass"
  | "vulkanEnableOrForce"
  | "angleForce";

export function readForge3DBrowserProjectMetadata(
  metadata: unknown,
): Forge3DBrowserProjectMetadata {
  if (!isRecord(metadata) || !isRecord(metadata.forge3dBrowser)) {
    throw new Error("Playwright project is missing forge3dBrowser metadata");
  }
  const candidate = metadata.forge3dBrowser;
  if (
    !isOneOf(candidate.project, [
      "chromium-preflight",
      "chrome-stable",
      "edge-stable",
      "firefox-preflight",
      "firefox-nightly-experimental",
      "webkit-preflight",
    ]) ||
    !isOneOf(candidate.browserName, [
      "chromium",
      "chrome",
      "edge",
      "firefox",
      "webkit",
    ]) ||
    !isOneOf(candidate.channel, ["playwright", "chrome", "msedge"]) ||
    !isOneOf(candidate.lane, ["preflight", "branded", "experimental"]) ||
    !isOneOf(candidate.launchObservation, [
      "chromium-live",
      "project-configuration",
    ]) ||
    typeof candidate.webgpuRequired !== "boolean" ||
    !Array.isArray(candidate.launchArgs) ||
    candidate.launchArgs.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("Playwright forge3dBrowser metadata is malformed");
  }

  const expected = {
    "chromium-preflight": {
      browserName: "chromium",
      channel: "playwright",
      lane: "preflight",
      launchObservation: "chromium-live",
    },
    "chrome-stable": {
      browserName: "chrome",
      channel: "chrome",
      lane: "branded",
      launchObservation: "chromium-live",
    },
    "edge-stable": {
      browserName: "edge",
      channel: "msedge",
      lane: "branded",
      launchObservation: "chromium-live",
    },
    "webkit-preflight": {
      browserName: "webkit",
      channel: "playwright",
      lane: "preflight",
      launchObservation: "project-configuration",
    },
    "firefox-preflight": {
      browserName: "firefox",
      channel: "playwright",
      lane: "preflight",
      launchObservation: "project-configuration",
    },
    "firefox-nightly-experimental": {
      browserName: "firefox",
      channel: "playwright",
      lane: "experimental",
      launchObservation: "project-configuration",
    },
  }[candidate.project];
  if (
    candidate.browserName !== expected.browserName ||
    candidate.channel !== expected.channel ||
    candidate.lane !== expected.lane ||
    candidate.launchObservation !== expected.launchObservation ||
    (candidate.project === "webkit-preflight" &&
      candidate.launchArgs.length !== 0)
  ) {
    throw new Error(
      "Playwright forge3dBrowser project identity is inconsistent",
    );
  }

  const firefoxFields =
    candidate.project === "firefox-preflight"
      ? readFirefoxFields(candidate, {
          preferenceMode: "default",
          firefoxUserPrefs: {},
          supportLevel: "ENGINE_PASS",
          webgpuRequired: true,
        })
      : candidate.project === "firefox-nightly-experimental"
        ? readFirefoxFields(candidate, {
            preferenceMode: "override",
            firefoxUserPrefs: { "dom.webgpu.enabled": true },
            supportLevel: "NOT_PROVEN",
            webgpuRequired: false,
          })
        : {};

  return {
    project: candidate.project,
    browserName: candidate.browserName,
    channel: candidate.channel,
    lane: candidate.lane,
    launchObservation: candidate.launchObservation,
    webgpuRequired: candidate.webgpuRequired,
    launchArgs: [...candidate.launchArgs],
    ...firefoxFields,
  };
}

export function resolveWebGpuRequired(
  metadata: Pick<
    Forge3DBrowserProjectMetadata,
    "lane" | "webgpuRequired"
  >,
  ambientRequired: string | undefined,
): boolean {
  return (
    metadata.lane === "branded" ||
    metadata.webgpuRequired ||
    ambientRequired === "1"
  );
}

export function resolveSourceBenchmarkEvidenceMode(
  metadata: Pick<
    Forge3DBrowserProjectMetadata,
    "project" | "lane"
  >,
  ambientMode: string | undefined,
): EvidenceMode {
  const projectMode =
    metadata.lane === "branded" ? "required" : "probe";
  if (ambientMode === undefined) {
    return projectMode;
  }
  const resolvedAmbientMode = resolveEvidenceMode(ambientMode);
  if (resolvedAmbientMode !== projectMode) {
    throw new Error(
      `source benchmark evidence mode ${resolvedAmbientMode} conflicts with ${metadata.project} ${metadata.lane} lane`,
    );
  }
  return projectMode;
}

function readFirefoxFields(
  candidate: Record<string, unknown>,
  expected: {
    preferenceMode: "default" | "override";
    firefoxUserPrefs: Record<string, boolean>;
    supportLevel: "ENGINE_PASS" | "NOT_PROVEN";
    webgpuRequired: boolean;
  },
): Pick<
  Forge3DBrowserProjectMetadata,
  "preferenceMode" | "firefoxUserPrefs" | "supportLevel"
> {
  if (
    candidate.preferenceMode !== expected.preferenceMode ||
    candidate.supportLevel !== expected.supportLevel ||
    candidate.webgpuRequired !== expected.webgpuRequired ||
    !Array.isArray(candidate.launchArgs) ||
    candidate.launchArgs.length !== 0 ||
    !sameBooleanRecord(candidate.firefoxUserPrefs, expected.firefoxUserPrefs)
  ) {
    throw new Error(
      "Playwright Firefox preference or support metadata is inconsistent",
    );
  }
  return {
    preferenceMode: expected.preferenceMode,
    firefoxUserPrefs: { ...expected.firefoxUserPrefs },
    supportLevel: expected.supportLevel,
  };
}

function sameBooleanRecord(
  candidate: unknown,
  expected: Record<string, boolean>,
): boolean {
  if (!isRecord(candidate)) return false;
  const candidateEntries = Object.entries(candidate);
  const expectedEntries = Object.entries(expected);
  return (
    candidateEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([key, value]) => candidate[key] === value,
    )
  );
}

export function launchFlagPresence(
  configuredArguments: readonly string[],
  effectiveArguments: readonly string[],
): Record<LaunchFlagCategory, LaunchFlagPresence> {
  return Object.fromEntries(
    launchFlagCategories.map((category) => [
      category,
      {
        configured: configuredArguments.some((argument) =>
          belongsToLaunchFlagCategory(argument, category),
        ),
        observed: effectiveArguments.some((argument) =>
          belongsToLaunchFlagCategory(argument, category),
        ),
      },
    ]),
  ) as Record<LaunchFlagCategory, LaunchFlagPresence>;
}

export function launchFlagsPresent(
  arguments_: readonly string[],
): boolean {
  return launchFlagCategories.some((category) =>
    arguments_.some((argument) =>
      belongsToLaunchFlagCategory(argument, category),
    ),
  );
}

export function configuredLaunchArgumentsObserved(
  configuredArguments: readonly string[],
  effectiveArguments: readonly string[],
): boolean {
  return configuredArguments.every((configured) =>
    effectiveArguments.includes(configured),
  );
}

export function preflightLaunchIdentityConsistent(
  metadata: Pick<Forge3DBrowserProjectMetadata, "project" | "lane">,
  configuredArguments: readonly string[],
  effectiveArguments: readonly string[],
): boolean {
  const presence = launchFlagPresence(
    configuredArguments,
    effectiveArguments,
  );
  const flagged = Object.values(presence).some(
    ({ configured, observed }) => configured || observed,
  );
  return (
    !flagged ||
    (metadata.project === "chromium-preflight" &&
      metadata.lane === "preflight")
  );
}

const launchFlagCategories: readonly LaunchFlagCategory[] = [
  "unsafeWebGpu",
  "gpuBlocklistBypass",
  "vulkanEnableOrForce",
  "angleForce",
];

function belongsToLaunchFlagCategory(
  argument: string,
  category: LaunchFlagCategory,
): boolean {
  if (category === "unsafeWebGpu") {
    return argument === "--enable-unsafe-webgpu";
  }
  if (category === "gpuBlocklistBypass") {
    return argument === "--ignore-gpu-blocklist";
  }
  if (category === "vulkanEnableOrForce") {
    return (
      argument === "--enable-vulkan" ||
      argument === "--use-vulkan" ||
      argument.startsWith("--use-vulkan=") ||
      (argument.startsWith("--enable-features=") &&
        argument
          .slice("--enable-features=".length)
          .split(",")
          .some((feature) => /^Vulkan(?:$|<)/u.test(feature)))
    );
  }
  return argument === "--use-angle" || argument.startsWith("--use-angle=");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOneOf<const Value extends string>(
  value: unknown,
  expected: readonly Value[],
): value is Value {
  return typeof value === "string" && expected.includes(value as Value);
}
