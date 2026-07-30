import {
  isLiveChromiumLaunchArgumentSource,
  observeChromiumLaunch,
} from "../../scripts/browser-launch-provenance.mjs";
import {
  configuredLaunchArgumentsObserved,
  launchFlagPresence,
  launchFlagsPresent,
  preflightLaunchIdentityConsistent,
  type Forge3DBrowserProjectMetadata,
} from "./playwright-project-metadata";

interface PlaywrightBrowserIdentity {
  browserType(): {
    name(): string;
  };
}

interface ChromiumLaunchObservation {
  effectiveLaunchArguments: string[];
  launchArgumentsObserved: boolean;
  launchArgumentSource: string;
  browserProcessId: number | null;
}

type ChromiumLaunchObserver = (
  browser: PlaywrightBrowserIdentity,
) => Promise<ChromiumLaunchObservation>;

export interface PlaywrightLaunchDiagnostics {
  declaredEngine: "chromium" | "firefox";
  actualEngine: string;
  provenance: "live-browser" | "project-configuration";
  configuredArguments: string[];
  effectiveArguments: string[];
  observationSource: string;
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
}

export async function collectPlaywrightLaunchDiagnostics(
  browser: PlaywrightBrowserIdentity,
  project: Forge3DBrowserProjectMetadata,
  observeChromium: ChromiumLaunchObserver = observeChromiumLaunch,
): Promise<PlaywrightLaunchDiagnostics> {
  const declaredEngine =
    project.browserName === "firefox" ? "firefox" : "chromium";
  const actualEngine = browser.browserType().name();
  if (actualEngine !== declaredEngine) {
    throw new Error(
      `Playwright project ${project.project} declares ${declaredEngine} but launched ${actualEngine}`,
    );
  }

  const configuredArguments = [...project.launchArgs];
  if (declaredEngine === "firefox") {
    return completeDiagnostics({
      project,
      declaredEngine,
      actualEngine,
      provenance: "project-configuration",
      configuredArguments,
      effectiveArguments: [],
      observationSource: "playwright-project-configuration",
      observed: false,
      browserProcessId: null,
      preferenceMode: project.preferenceMode ?? null,
      firefoxUserPrefs:
        project.firefoxUserPrefs === undefined
          ? null
          : { ...project.firefoxUserPrefs },
      supportLevel: project.supportLevel ?? null,
    });
  }

  const launch = await observeChromium(browser);
  if (
    launch.launchArgumentsObserved !== true ||
    !isLiveChromiumLaunchArgumentSource(launch.launchArgumentSource)
  ) {
    throw new Error(
      `Playwright project ${project.project} requires live Chromium launch provenance`,
    );
  }
  return completeDiagnostics({
    project,
    declaredEngine,
    actualEngine,
    provenance: "live-browser",
    configuredArguments,
    effectiveArguments: [...launch.effectiveLaunchArguments],
    observationSource: launch.launchArgumentSource,
    observed: true,
    browserProcessId: launch.browserProcessId,
    preferenceMode: null,
    firefoxUserPrefs: null,
    supportLevel: null,
  });
}

function completeDiagnostics({
  project,
  declaredEngine,
  actualEngine,
  provenance,
  configuredArguments,
  effectiveArguments,
  observationSource,
  observed,
  browserProcessId,
  preferenceMode,
  firefoxUserPrefs,
  supportLevel,
}: {
  project: Forge3DBrowserProjectMetadata;
  declaredEngine: "chromium" | "firefox";
  actualEngine: string;
  provenance: "live-browser" | "project-configuration";
  configuredArguments: string[];
  effectiveArguments: string[];
  observationSource: string;
  observed: boolean;
  browserProcessId: number | null;
  preferenceMode: "default" | "override" | null;
  firefoxUserPrefs: Record<string, boolean> | null;
  supportLevel: "ENGINE_PASS" | "NOT_PROVEN" | null;
}): PlaywrightLaunchDiagnostics {
  return {
    declaredEngine,
    actualEngine,
    provenance,
    configuredArguments,
    effectiveArguments,
    observationSource,
    observed,
    browserProcessId,
    preferenceMode,
    firefoxUserPrefs,
    supportLevel,
    flagPresence: launchFlagPresence(
      configuredArguments,
      effectiveArguments,
    ),
    configuredLaunchFlagsPresent:
      launchFlagsPresent(configuredArguments),
    effectiveLaunchFlagsPresent:
      launchFlagsPresent(effectiveArguments),
    configuredArgumentsObserved:
      configuredLaunchArgumentsObserved(
        configuredArguments,
        effectiveArguments,
      ),
    preflightIdentityConsistent:
      preflightLaunchIdentityConsistent(
        project,
        configuredArguments,
        effectiveArguments,
      ),
  };
}
