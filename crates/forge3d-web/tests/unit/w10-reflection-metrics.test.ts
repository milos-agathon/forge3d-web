import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { reflectionContributionMetrics, reflectionContributionPasses, reflectionContributionNegativeControls } from "../../examples/w10-reflection-metrics.js";

const enabled = readFileSync(new URL("../golden/w10/native/terrain-water-planar.rgba", import.meta.url));
const disabled = readFileSync(new URL("../golden/w10/native/terrain-water-planar-disabled.rgba", import.meta.url));

it("accepts the independently rendered native signed RGB contribution", () => {
  const metrics = reflectionContributionMetrics(enabled, disabled, enabled, disabled);
  expect(metrics.nativeMeanAbsRgb).toBeGreaterThan(0.5);
  expect(metrics.amplitudeRatio).toBe(1);
  expect(metrics.signedCorrelation).toBeCloseTo(1, 12);
  expect(metrics.changedPixelIoU).toBe(1);
  expect(metrics.signAgreement).toBe(1);
  expect(reflectionContributionPasses(metrics)).toBe(true);
});

it("rejects half strength, displaced, inverted, and inert reflection controls", () => {
  expect(reflectionContributionNegativeControls(enabled, disabled)).toEqual({halfAmplitudeRejected: true, displacedRejected: true});
  const inverted = Float64Array.from(enabled, (value, i) => disabled[i]! - (value - disabled[i]!));
  const invertedMetrics = reflectionContributionMetrics(inverted, disabled, enabled, disabled);
  expect(invertedMetrics.amplitudeRatio).toBe(1);
  expect(invertedMetrics.signedCorrelation).toBeCloseTo(-1, 12);
  expect(reflectionContributionPasses(invertedMetrics)).toBe(false);
  expect(reflectionContributionPasses(reflectionContributionMetrics(disabled, disabled, enabled, disabled))).toBe(false);
  expect(reflectionContributionPasses(reflectionContributionMetrics(disabled, disabled, disabled, disabled))).toBe(false);
});
