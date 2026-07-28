import { describe, expect, it } from "vitest";

import { resolveEvidenceMode } from "../browser/evidence-mode";

describe("browser evidence mode", () => {
  it("defaults to the required lane", () => {
    expect(resolveEvidenceMode(undefined)).toBe("required");
  });

  it("accepts the hosted probe lane", () => {
    expect(resolveEvidenceMode("probe")).toBe("probe");
  });

  it("rejects unknown evidence labels", () => {
    expect(() => resolveEvidenceMode("pass")).toThrow(
      "evidence mode must be either required or probe",
    );
  });
});
