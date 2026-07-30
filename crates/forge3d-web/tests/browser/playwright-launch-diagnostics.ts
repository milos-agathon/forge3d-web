import type { Browser } from "@playwright/test";

import { observeChromiumLaunch } from "../../scripts/browser-launch-provenance.mjs";
import {
  configuredLaunchArgumentsObserved,
  launchFlagPresence,
  launchFlagsPresent,
  preflightLaunchIdentityConsistent,
  type Forge3DBrowserProjectMetadata,
} from "./playwright-project-metadata";
import {
  observeSourceBrowserLaunch,
  sourceLaunchObservationConsistent,
} from "./source-launch-observation";

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
  declaredEngine: "chromium" | "firefox" | "webkit";
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
  sourceObservationConsistent: boolean;
}

export async function collectPlaywrightLaunchDiagnostics(
  browser: PlaywrightBrowserIdentity,
  project: Forge3DBrowserProjectMetadata,
  observeChromium: ChromiumLaunchObserver = observeChromiumLaunch,
): Promise<PlaywrightLaunchDiagnostics> {
  const declaredEngine =
    project.browserName === "firefox"
      ? "firefox"
      : project.browserName === "webkit"
        ? "webkit"
        : "chromium";
  const actualEngine = browser.browserType().name();
  if (actualEngine !== declaredEngine) {
    throw new Error(
      `Playwright project ${project.project} declares ${declaredEngine} but launched ${actualEngine}`,
    );
  }

  const configuredArguments = [...project.launchArgs];
  const launch = await observeSourceBrowserLaunch(
    browser as Browser,
    project,
    observeChromium as Parameters<
      typeof observeSourceBrowserLaunch
    >[2],
  );
  const observationConsistent = sourceLaunchObservationConsistent(
    project,
    launch,
  );
  if (!observationConsistent) {
    throw new Error(
      `Playwright project ${project.project} produced launch evidence inconsistent with ${project.launchObservation}`,
    );
  }
  const liveObservation = project.launchObservation === "chromium-live";
  return completeDiagnostics({
    project,
    declaredEngine,
    actualEngine,
    provenance: liveObservation
      ? "live-browser"
      : "project-configuration",
    configuredArguments,
    effectiveArguments: [...launch.effectiveLaunchArguments],
    observationSource: launch.launchArgumentSource,
    observed: launch.launchArgumentsObserved,
    browserProcessId: launch.browserProcessId,
    preferenceMode: project.preferenceMode ?? null,
    firefoxUserPrefs:
      project.firefoxUserPrefs === undefined
        ? null
        : { ...project.firefoxUserPrefs },
    supportLevel: project.supportLevel ?? null,
    sourceObservationConsistent: observationConsistent,
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
  sourceObservationConsistent,
}: {
  project: Forge3DBrowserProjectMetadata;
  declaredEngine: "chromium" | "firefox" | "webkit";
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
  sourceObservationConsistent: boolean;
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
      observed &&
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
    sourceObservationConsistent,
  };
}
