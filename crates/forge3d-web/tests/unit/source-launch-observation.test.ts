import type { Browser } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import type { Forge3DBrowserProjectMetadata } from "../browser/playwright-project-metadata";
import {
  observeSourceBrowserLaunch,
  sourceLaunchObservationConsistent,
  type SourceLaunchObservation,
} from "../browser/source-launch-observation";

const webkit: Forge3DBrowserProjectMetadata = {
  project: "webkit-preflight",
  browserName: "webkit",
  channel: "playwright",
  lane: "preflight",
  launchObservation: "project-configuration",
  webgpuRequired: true,
  launchArgs: [],
};

const chromium: Forge3DBrowserProjectMetadata = {
  project: "chromium-preflight",
  browserName: "chromium",
  channel: "playwright",
  lane: "preflight",
  launchObservation: "chromium-live",
  webgpuRequired: true,
  launchArgs: ["--enable-unsafe-webgpu"],
};

describe("source browser launch observation", () => {
  it("does not call Chromium CDP/process observation for WebKit", async () => {
    const observeChromium = vi.fn(async () => {
      throw new Error("Chromium observation must not run");
    });

    const observation = await observeSourceBrowserLaunch(
      {} as Browser,
      webkit,
      observeChromium,
    );

    expect(observeChromium).not.toHaveBeenCalled();
    expect(observation).toEqual({
      effectiveLaunchArguments: [],
      launchArgumentsObserved: false,
      launchArgumentSource: "playwright-project-configuration",
      browserProcessId: null,
    });
    expect(
      sourceLaunchObservationConsistent(webkit, observation),
    ).toBe(true);
  });

  it("keeps Chromium observation live and rejects fabricated sources", async () => {
    const liveObservation: SourceLaunchObservation = {
      effectiveLaunchArguments: ["--enable-unsafe-webgpu"],
      launchArgumentsObserved: true,
      launchArgumentSource: "chromium-cdp-browser-command-line",
      browserProcessId: 4312,
    };
    const observeChromium = vi.fn(async () => liveObservation);

    await expect(
      observeSourceBrowserLaunch(
        {} as Browser,
        chromium,
        observeChromium,
      ),
    ).resolves.toEqual(liveObservation);
    expect(observeChromium).toHaveBeenCalledOnce();
    expect(
      sourceLaunchObservationConsistent(chromium, liveObservation),
    ).toBe(true);
    expect(
      sourceLaunchObservationConsistent(chromium, {
        ...liveObservation,
        launchArgumentSource: "playwright-project-configuration",
      }),
    ).toBe(false);
  });

  it("fails closed if configuration-only evidence declares arguments", async () => {
    await expect(
      observeSourceBrowserLaunch(
        {} as Browser,
        {
          ...webkit,
          launchArgs: ["--enable-unsafe-webgpu"],
        },
      ),
    ).rejects.toThrow(/requires zero launch arguments/u);
  });
});
