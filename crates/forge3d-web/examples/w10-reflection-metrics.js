// Compare signed RGB enabled-minus-disabled images. Whole-frame SSIM can hide
// an attenuated reflection because unchanged terrain occupies most of the image.
export function reflectionContributionMetrics(enabled, disabled, nativeEnabled, nativeDisabled) {
  const count = enabled.length;
  if (!count || count % 4 || [disabled, nativeEnabled, nativeDisabled].some(a => a.length !== count)) {
    throw new Error("Reflection contribution images must have equal RGBA dimensions");
  }
  let webAbs = 0, nativeAbs = 0, sumWeb = 0, sumNative = 0;
  let webSquared = 0, nativeSquared = 0, product = 0;
  let intersection = 0, union = 0, nativeNonzero = 0, signMatches = 0;
  for (let i = 0; i < count; i += 4) {
    let webChanged = false, nativeChanged = false;
    for (let c = 0; c < 3; c++) {
      const web = enabled[i + c] - disabled[i + c];
      const native = nativeEnabled[i + c] - nativeDisabled[i + c];
      webAbs += Math.abs(web); nativeAbs += Math.abs(native);
      sumWeb += web; sumNative += native;
      webSquared += web * web; nativeSquared += native * native; product += web * native;
      webChanged ||= web !== 0; nativeChanged ||= native !== 0;
      if (native !== 0) { nativeNonzero++; signMatches += Math.sign(web) === Math.sign(native) ? 1 : 0; }
    }
    intersection += webChanged && nativeChanged ? 1 : 0;
    union += webChanged || nativeChanged ? 1 : 0;
  }
  const rgbCount = count / 4 * 3;
  const varianceWeb = Math.max(0, webSquared - sumWeb * sumWeb / rgbCount);
  const varianceNative = Math.max(0, nativeSquared - sumNative * sumNative / rgbCount);
  const denominator = Math.sqrt(varianceWeb * varianceNative);
  return {
    webMeanAbsRgb: webAbs / rgbCount,
    nativeMeanAbsRgb: nativeAbs / rgbCount,
    amplitudeRatio: nativeAbs > 0 ? webAbs / nativeAbs : 0,
    signedCorrelation: denominator > 0 ? (product - sumWeb * sumNative / rgbCount) / denominator : 0,
    changedPixelIoU: union > 0 ? intersection / union : 0,
    signAgreement: nativeNonzero > 0 ? signMatches / nativeNonzero : 0,
  };
}

export function reflectionContributionPasses(metrics) {
  return metrics.nativeMeanAbsRgb > 0.5
    && metrics.amplitudeRatio >= 0.9 && metrics.amplitudeRatio <= 1.1
    && metrics.signedCorrelation >= 0.98
    && metrics.changedPixelIoU >= 0.98 && metrics.signAgreement >= 0.99;
}

// Preserve the independent reference; synthesize controls from its signed
// contribution. The old half-strength rendering and a displaced reflection
// must fail even when the whole-frame image remains visually similar.
export function reflectionContributionNegativeControls(enabled, disabled) {
  const half = Float64Array.from(enabled, (value, i) => disabled[i] + (value - disabled[i]) * 0.5);
  const shifted = Float64Array.from(disabled);
  const pixelCount = enabled.length / 4, shift = Math.floor(pixelCount / 2);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const source = ((pixel + shift) % pixelCount) * 4, target = pixel * 4;
    for (let c = 0; c < 3; c++) shifted[target + c] += enabled[source + c] - disabled[source + c];
  }
  return {
    halfAmplitudeRejected: !reflectionContributionPasses(reflectionContributionMetrics(half, disabled, enabled, disabled)),
    displacedRejected: !reflectionContributionPasses(reflectionContributionMetrics(shifted, disabled, enabled, disabled)),
  };
}
