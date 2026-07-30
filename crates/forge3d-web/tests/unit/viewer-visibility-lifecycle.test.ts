import { describe, expect, it } from "vitest";

import {
  resolveViewerVisibilityLifecycleMode,
} from "../browser/viewer-visibility-lifecycle.mjs";

describe("viewer visibility lifecycle mode", () => {
  it("requires actual tab visibility for headed Chromium", () => {
    expect(
      resolveViewerVisibilityLifecycleMode({
        headed: true,
        browserEngine: "chromium",
      }),
    ).toEqual({
      mode: "headed-real-tab",
      visibilityStateSource: "actual-document",
      actualDocumentVisibilityTransitions: true,
      physicalSupportEvidence: false,
      supportPromotionEligible: false,
    });
  });

  it("keeps headed Firefox lifecycle evidence explicitly synthetic", () => {
    expect(
      resolveViewerVisibilityLifecycleMode({
        headed: true,
        browserEngine: "firefox",
      }),
    ).toEqual({
      mode: "deterministic-synthetic-document-visibility",
      visibilityStateSource: "deterministic-synthetic-document-override",
      actualDocumentVisibilityTransitions: false,
      physicalSupportEvidence: false,
      supportPromotionEligible: false,
    });
  });

  it("keeps headless Chromium lifecycle evidence explicitly synthetic", () => {
    expect(
      resolveViewerVisibilityLifecycleMode({
        headed: false,
        browserEngine: "chromium",
      }),
    ).toEqual({
      mode: "deterministic-synthetic-document-visibility",
      visibilityStateSource: "deterministic-synthetic-document-override",
      actualDocumentVisibilityTransitions: false,
      physicalSupportEvidence: false,
      supportPromotionEligible: false,
    });
  });

  it.each([undefined, "webkit", "firefoxx"])(
    "fails closed for unknown headed engine %s",
    (browserEngine) => {
      expect(() =>
        resolveViewerVisibilityLifecycleMode({
          headed: true,
          browserEngine,
        }),
      ).toThrow(/browser engine must be chromium or firefox/u);
    },
  );

  it.each([undefined, 1, "true"])(
    "fails closed for malformed headed mode %s",
    (headed) => {
      expect(() =>
        resolveViewerVisibilityLifecycleMode({
          headed,
          browserEngine: "firefox",
        }),
      ).toThrow(/headed mode must be a boolean/u);
    },
  );
});
