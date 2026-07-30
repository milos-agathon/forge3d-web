import {
  resolveEvidenceMode,
  type EvidenceMode,
} from "./evidence-mode";

export interface Forge3DBrowserProjectMetadata {
  project:
    | "chromium-preflight"
    | "chrome-stable"
    | "edge-stable"
    | "webkit-preflight";
  browserName: "chromium" | "chrome" | "edge" | "webkit";
  channel: "playwright" | "chrome" | "msedge";
  lane: "preflight" | "branded";
  launchObservation: "chromium-live" | "project-configuration";
  webgpuRequired: boolean;
  launchArgs: string[];
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
      "webkit-preflight",
    ]) ||
    !isOneOf(candidate.browserName, [
      "chromium",
      "chrome",
      "edge",
      "webkit",
    ]) ||
    !isOneOf(candidate.channel, ["playwright", "chrome", "msedge"]) ||
    !isOneOf(candidate.lane, ["preflight", "branded"]) ||
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
  return {
    project: candidate.project,
    browserName: candidate.browserName,
    channel: candidate.channel,
    lane: candidate.lane,
    launchObservation: candidate.launchObservation,
    webgpuRequired: candidate.webgpuRequired,
    launchArgs: [...candidate.launchArgs],
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
    metadata.lane === "preflight" ? "probe" : "required";
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
