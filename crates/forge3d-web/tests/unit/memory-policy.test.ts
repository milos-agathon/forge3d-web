import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import { SceneMemoryTracker } from "../../src-ts/memory-policy.js";

function expectLimit(factory: () => unknown): void {
  try {
    factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    expect((error as Forge3DError).code).toBe("RESOURCE_LIMIT_EXCEEDED");
    return;
  }
  throw new Error("expected RESOURCE_LIMIT_EXCEEDED");
}

describe("SceneMemoryTracker", () => {
  it("rejects invalid budgets and allocations", () => {
    expect(() => new SceneMemoryTracker(0)).toThrowError(Forge3DError);
    expect(() => new SceneMemoryTracker(-1)).toThrowError(Forge3DError);
    const tracker = new SceneMemoryTracker(1024);
    expect(() =>
      tracker.allocate("a", "buffers", 0, "high", "reject"),
    ).toThrowError(Forge3DError);
    expect(() =>
      tracker.allocate("a", "buffers", 1.5, "high", "reject"),
    ).toThrowError(Forge3DError);
  });

  it("deduplicates identical keys and rejects conflicting keys", () => {
    const tracker = new SceneMemoryTracker(1024);
    tracker.allocate("scene", "buffers", 100, "high", "reject");
    const repeat = tracker.allocate("scene", "buffers", 100, "high", "reject");
    expect(repeat.requestedBytes).toBe(100);
    expect(tracker.report().currentBytes).toBe(100);
    expect(tracker.report().allocationCount).toBe(1);

    expect(() =>
      tracker.allocate("scene", "buffers", 50, "high", "reject"),
    ).toThrowError(Forge3DError);
    expect(() =>
      tracker.allocate("scene", "textures", 100, "high", "reject"),
    ).toThrowError(Forge3DError);
    expect(tracker.report().currentBytes).toBe(100);
  });

  it("tracks categories and reports all keys", () => {
    const tracker = new SceneMemoryTracker(1024);
    tracker.allocate("a", "buffers", 100, "high", "reject");
    tracker.allocate("b", "textures", 200, "high", "reject");
    tracker.allocate("c", "textures", 50, "high", "reject");

    const report = tracker.report();
    expect(report.currentBytes).toBe(350);
    expect(report.allocationCount).toBe(3);
    expect(report.utilization).toBeCloseTo(350 / 1024, 12);
    expect(report.categories).toEqual({
      buffers: 100,
      textures: 250,
      staging: 0,
      readback: 0,
      "tile-cache": 0,
      "render-bundles": 0,
      other: 0,
    });
  });

  it("preserves peak across release and clear", () => {
    const tracker = new SceneMemoryTracker(1024);
    tracker.allocate("a", "buffers", 300, "high", "reject");
    tracker.allocate("b", "buffers", 200, "high", "reject");
    expect(tracker.report().peakBytes).toBe(500);

    expect(tracker.release("a")).toBe(true);
    expect(tracker.release("a")).toBe(false);
    expect(tracker.report().currentBytes).toBe(200);
    expect(tracker.report().peakBytes).toBe(500);

    tracker.clear();
    const report = tracker.report();
    expect(report.currentBytes).toBe(0);
    expect(report.allocationCount).toBe(0);
    expect(report.peakBytes).toBe(500);
    for (const bytes of Object.values(report.categories)) {
      expect(bytes).toBe(0);
    }
    expect(report.downgrades).toEqual([]);
  });

  it("rejects before mutating state", () => {
    const tracker = new SceneMemoryTracker(100);
    tracker.allocate("a", "buffers", 60, "high", "reject");
    expectLimit(() =>
      tracker.allocate("b", "buffers", 41, "high", "reject"),
    );
    expectLimit(() =>
      tracker.allocate("b", "buffers", 41, "low", "downscale"),
    );

    const report = tracker.report();
    expect(report.currentBytes).toBe(60);
    expect(report.allocationCount).toBe(1);
    expect(report.downgrades).toEqual([]);
  });

  it("downscales deterministically and never upgrades", () => {
    const tracker = new SceneMemoryTracker(100);

    const high = tracker.allocate("a", "buffers", 100, "high", "downscale");
    expect(high).toEqual({
      requested: "high",
      effective: "high",
      requestedBytes: 100,
      admittedBytes: 100,
    });

    tracker.release("a");
    const medium = tracker.allocate("a", "buffers", 120, "high", "downscale");
    expect(medium).toEqual({
      requested: "high",
      effective: "medium",
      requestedBytes: 120,
      admittedBytes: 60,
    });

    tracker.release("a");
    const low = tracker.allocate("a", "buffers", 300, "high", "downscale");
    expect(low).toEqual({
      requested: "high",
      effective: "low",
      requestedBytes: 300,
      admittedBytes: 75,
    });

    tracker.release("a");
    expectLimit(() =>
      tracker.allocate("a", "buffers", 500, "high", "downscale"),
    );

    const ultra = tracker.allocate("u", "buffers", 10, "low", "downscale");
    expect(ultra.effective).toBe("low");

    const report = tracker.report();
    expect(report.effectiveQuality).toBe("low");
    expect(report.downgrades).toEqual([
      {
        requested: "high",
        effective: "medium",
        requestedBytes: 120,
        admittedBytes: 60,
      },
      {
        requested: "high",
        effective: "low",
        requestedBytes: 300,
        admittedBytes: 75,
      },
    ]);
    expect(report.effectiveQuality).toBe("low");
  });

  it("uses ceil arithmetic for downscaled bytes", () => {
    const tracker = new SceneMemoryTracker(10);
    const decision = tracker.allocate("odd", "buffers", 21, "high", "downscale");
    expect(decision.admittedBytes).toBe(Math.ceil(21 * 0.25));
    expect(decision.effective).toBe("low");
  });

  it("rejects invalid quality and policy before mutation", () => {
    const tracker = new SceneMemoryTracker(1024);
    tracker.allocate("a", "buffers", 10, "high", "reject");
    const before = tracker.report();

    for (const invoke of [
      () => tracker.allocate("b", "buffers", 10, "bogus" as never, "reject"),
      () => tracker.allocate("b", "buffers", 10, "high", "bogus" as never),
      () =>
        tracker.allocate("b", "buffers", 10, "bogus" as never, "bogus" as never),
      () =>
        tracker.allocate(
          "b",
          "buffers",
          Number.MAX_SAFE_INTEGER,
          "bogus" as never,
          "reject",
        ),
    ]) {
      try {
        invoke();
        throw new Error("expected INVALID_INPUT");
      } catch (error) {
        expect(error).toBeInstanceOf(Forge3DError);
        expect((error as Forge3DError).code).toBe("INVALID_INPUT");
      }
    }
    expect(tracker.report()).toEqual(before);
  });

  it("keeps reports defensive", () => {
    const tracker = new SceneMemoryTracker(100);
    tracker.allocate("a", "buffers", 10, "high", "reject");
    const report = tracker.report();
    report.categories.buffers = 999;
    report.downgrades.push({
      requested: "low",
      effective: "low",
      requestedBytes: 1,
      admittedBytes: 1,
    });
    const next = tracker.report();
    expect(next.categories.buffers).toBe(10);
    expect(next.downgrades).toEqual([]);
  });
});
