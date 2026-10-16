import { Forge3DError } from "./index.js";
import type {
  MemoryCategory,
  MemoryOverflowPolicy,
  MemoryReport,
  QualityDowngrade,
  RenderQuality,
} from "./index.js";

const QUALITY_LADDER: readonly RenderQuality[] = [
  "ultra",
  "high",
  "medium",
  "low",
];

const QUALITY_SCALE_PERCENT: Record<RenderQuality, number> = {
  ultra: 100,
  high: 75,
  medium: 50,
  low: 25,
};

const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "buffers",
  "textures",
  "staging",
  "readback",
  "tile-cache",
  "render-bundles",
  "other",
];

interface SceneAllocation {
  category: MemoryCategory;
  requestedBytes: number;
  admittedBytes: number;
  downgrade: QualityDowngrade;
}

export class SceneMemoryTracker {
  readonly #budgetBytes: number;
  #currentBytes = 0;
  #peakBytes = 0;
  #effectiveQuality: RenderQuality = "ultra";
  readonly #allocations = new Map<string, SceneAllocation>();
  readonly #categories = new Map<MemoryCategory, number>();
  readonly #downgrades: QualityDowngrade[] = [];

  constructor(budgetBytes: number) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "budgetBytes must be a positive safe integer",
      );
    }
    this.#budgetBytes = budgetBytes;
  }

  allocate(
    key: string,
    category: MemoryCategory,
    requestedBytes: number,
    quality: RenderQuality,
    policy: MemoryOverflowPolicy,
  ): QualityDowngrade {
    if (typeof key !== "string" || key.length === 0) {
      throw new Forge3DError("INVALID_INPUT", "key must be a nonempty string");
    }
    if (!MEMORY_CATEGORIES.includes(category)) {
      throw new Forge3DError("INVALID_INPUT", `unknown category ${String(category)}`);
    }
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "requestedBytes must be a positive safe integer",
      );
    }
    if (!QUALITY_LADDER.includes(quality)) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `unknown quality ${String(quality)}`,
      );
    }
    if (policy !== "reject" && policy !== "downscale") {
      throw new Forge3DError(
        "INVALID_INPUT",
        `unknown overflow policy ${String(policy)}`,
      );
    }
    const existing = this.#allocations.get(key);
    if (existing !== undefined) {
      if (
        existing.category === category &&
        existing.requestedBytes === requestedBytes
      ) {
        return { ...existing.downgrade };
      }
      throw new Forge3DError(
        "INVALID_INPUT",
        `conflicting allocation key ${key}`,
      );
    }

    const decision = this.#admit(requestedBytes, quality, policy);
    const admittedBytes = decision.admittedBytes;
    this.#allocations.set(key, {
      category,
      requestedBytes,
      admittedBytes,
      downgrade: decision,
    });
    this.#currentBytes += admittedBytes;
    this.#peakBytes = Math.max(this.#peakBytes, this.#currentBytes);
    this.#categories.set(
      category,
      (this.#categories.get(category) ?? 0) + admittedBytes,
    );
    this.#effectiveQuality = decision.effective;
    if (decision.effective !== decision.requested) {
      this.#downgrades.push({ ...decision });
    }
    return { ...decision };
  }

  release(key: string): boolean {
    const allocation = this.#allocations.get(key);
    if (allocation === undefined) {
      return false;
    }
    this.#allocations.delete(key);
    this.#currentBytes -= allocation.admittedBytes;
    const remaining =
      (this.#categories.get(allocation.category) ?? 0) - allocation.admittedBytes;
    this.#categories.set(allocation.category, remaining);
    return true;
  }

  clear(): void {
    this.#allocations.clear();
    this.#categories.clear();
    this.#currentBytes = 0;
  }

  report(): MemoryReport {
    const categories = {} as Record<MemoryCategory, number>;
    for (const category of MEMORY_CATEGORIES) {
      categories[category] = this.#categories.get(category) ?? 0;
    }
    return {
      currentBytes: this.#currentBytes,
      peakBytes: this.#peakBytes,
      budgetBytes: this.#budgetBytes,
      utilization: this.#currentBytes / this.#budgetBytes,
      allocationCount: this.#allocations.size,
      categories,
      effectiveQuality: this.#effectiveQuality,
      downgrades: this.#downgrades.map((downgrade) => ({ ...downgrade })),
    };
  }

  #admit(
    requestedBytes: number,
    quality: RenderQuality,
    policy: MemoryOverflowPolicy,
  ): QualityDowngrade {
    if (this.#fits(requestedBytes)) {
      return {
        requested: quality,
        effective: quality,
        requestedBytes,
        admittedBytes: requestedBytes,
      };
    }
    if (policy === "reject") {
      throw limitExceeded(requestedBytes);
    }
    const start = QUALITY_LADDER.indexOf(quality);
    if (start < 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `unknown quality ${String(quality)}`,
      );
    }
    for (let i = start + 1; i < QUALITY_LADDER.length; i += 1) {
      const level = QUALITY_LADDER[i]!;
      const scaled = requestedBytes * QUALITY_SCALE_PERCENT[level];
      if (!Number.isSafeInteger(scaled)) {
        continue;
      }
      const admittedBytes = Math.ceil(scaled / 100);
      if (this.#fits(admittedBytes)) {
        return {
          requested: quality,
          effective: level,
          requestedBytes,
          admittedBytes,
        };
      }
    }
    throw limitExceeded(requestedBytes);
  }

  #fits(bytes: number): boolean {
    const total = this.#currentBytes + bytes;
    return Number.isSafeInteger(total) && total <= this.#budgetBytes;
  }
}

function limitExceeded(requestedBytes: number): Forge3DError {
  return new Forge3DError(
    "RESOURCE_LIMIT_EXCEEDED",
    `request of ${requestedBytes} bytes exceeds the memory budget`,
  );
}
