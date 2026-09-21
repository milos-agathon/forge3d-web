import type {
  MemoryCategory,
  MemoryReport,
  PassRenderStats,
  QualityDowngrade,
  RenderQuality,
  RenderStats,
} from "./index.js";

const QUALITIES = new Set<string>(["ultra", "high", "medium", "low"]);
const TIMING_SOURCES = new Set<string>(["gpu-timestamp", "cpu"]);
const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "buffers",
  "textures",
  "staging",
  "readback",
  "tile-cache",
  "render-bundles",
  "other",
];

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function normalizeRenderStats(value: unknown): RenderStats | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const stats = value as Record<string, unknown>;
  if (
    !finiteNonNegative(stats.frameIndex) ||
    !finiteNonNegative(stats.frameTimeMs) ||
    !finiteNonNegative(stats.drawCalls) ||
    !finiteNonNegative(stats.triangles)
  ) {
    return undefined;
  }
  if (!Array.isArray(stats.passes)) {
    return undefined;
  }
  const passes: PassRenderStats[] = [];
  for (const entry of stats.passes) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const pass = entry as Record<string, unknown>;
    if (
      typeof pass.name !== "string" ||
      !finiteNonNegative(pass.milliseconds) ||
      typeof pass.timing !== "string" ||
      !TIMING_SOURCES.has(pass.timing)
    ) {
      return undefined;
    }
    passes.push({
      name: pass.name,
      milliseconds: pass.milliseconds,
      timing: pass.timing as PassRenderStats["timing"],
    });
  }
  return {
    frameIndex: stats.frameIndex,
    frameTimeMs: stats.frameTimeMs,
    drawCalls: stats.drawCalls,
    triangles: stats.triangles,
    passes,
  };
}

export function normalizeMemoryReport(
  value: unknown,
): MemoryReport | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const report = value as Record<string, unknown>;
  if (
    !finiteNonNegative(report.currentBytes) ||
    !finiteNonNegative(report.peakBytes) ||
    !finiteNonNegative(report.budgetBytes) ||
    !finiteNonNegative(report.utilization) ||
    !finiteNonNegative(report.allocationCount)
  ) {
    return undefined;
  }
  if (
    typeof report.effectiveQuality !== "string" ||
    !QUALITIES.has(report.effectiveQuality)
  ) {
    return undefined;
  }
  const categories = {} as Record<MemoryCategory, number>;
  const sourceCategories =
    typeof report.categories === "object" && report.categories !== null
      ? (report.categories as Record<string, unknown>)
      : {};
  for (const category of MEMORY_CATEGORIES) {
    const bytes = sourceCategories[category];
    if (bytes !== undefined && !finiteNonNegative(bytes)) {
      return undefined;
    }
    categories[category] = bytes ?? 0;
  }
  if (!Array.isArray(report.downgrades)) {
    return undefined;
  }
  const downgrades: QualityDowngrade[] = [];
  for (const entry of report.downgrades) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const downgrade = entry as Record<string, unknown>;
    if (
      typeof downgrade.requested !== "string" ||
      !QUALITIES.has(downgrade.requested) ||
      typeof downgrade.effective !== "string" ||
      !QUALITIES.has(downgrade.effective) ||
      !finiteNonNegative(downgrade.requestedBytes) ||
      !finiteNonNegative(downgrade.admittedBytes)
    ) {
      return undefined;
    }
    downgrades.push({
      requested: downgrade.requested as RenderQuality,
      effective: downgrade.effective as RenderQuality,
      requestedBytes: downgrade.requestedBytes,
      admittedBytes: downgrade.admittedBytes,
    });
  }
  return {
    currentBytes: report.currentBytes,
    peakBytes: report.peakBytes,
    budgetBytes: report.budgetBytes,
    utilization: report.utilization,
    allocationCount: report.allocationCount,
    categories,
    effectiveQuality: report.effectiveQuality as RenderQuality,
    downgrades,
  };
}
