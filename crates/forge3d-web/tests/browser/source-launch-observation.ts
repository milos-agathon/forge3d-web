import type { Browser } from "@playwright/test";

import {
  isPlaywrightSourceLaunchObservationConsistent,
  observeChromiumLaunch,
  observePlaywrightSourceLaunch,
} from "../../scripts/browser-launch-provenance.mjs";
import type { Forge3DBrowserProjectMetadata } from "./playwright-project-metadata";

export interface SourceLaunchObservation {
  effectiveLaunchArguments: string[];
  launchArgumentsObserved: boolean;
  launchArgumentSource: string;
  browserProcessId: number | null;
}

type ChromiumLaunchObserver = (
  browser: Browser,
) => Promise<SourceLaunchObservation>;

export async function observeSourceBrowserLaunch(
  browser: Browser,
  project: Forge3DBrowserProjectMetadata,
  observeChromium: ChromiumLaunchObserver = observeChromiumLaunch,
): Promise<SourceLaunchObservation> {
  return observePlaywrightSourceLaunch(browser, project, {
    observeChromium,
  });
}

export function sourceLaunchObservationConsistent(
  project: Forge3DBrowserProjectMetadata,
  observation: SourceLaunchObservation | undefined,
): boolean {
  return isPlaywrightSourceLaunchObservationConsistent(
    project,
    observation,
  );
}
