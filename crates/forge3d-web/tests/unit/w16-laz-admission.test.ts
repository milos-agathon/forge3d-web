import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Forge3DWorkerPool, serveForge3DMessagePort, decodeLaz, parseLasHeader } from "../../src-ts/index.js";
import { PointSource } from "../../src-ts/pointcloud-source.js";
import { withLazAdmission, lazAdmissionBytes, LAZ_MAX_ADMITTED_BYTES, LAZ_MAX_QUEUED_JOBS } from "../../src-ts/laz-admission.js";

const bytes = new Uint8Array(readFileSync(new URL("../fixtures/w16/autzen_trim.laz", import.meta.url)));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function ownedPool(handler: (payload: unknown) => Promise<unknown>, timeoutMs?: number) {
  const peers: MessagePort[] = [], terminate = vi.fn();
  const pool = new Forge3DWorkerPool({ size: 4,
    ...(timeoutMs === undefined ? {} : { jobTimeoutMs: timeoutMs }),
    mainThreadHandler: handler,
    workerFactory: () => {
      const channel = new MessageChannel(); peers.push(channel.port2);
      serveForge3DMessagePort(channel.port2, { run: handler });
      return { port: channel.port1, terminate };
    },
  });
  return { pool, terminate, dispose: () => { pool.dispose(); peers.forEach((port) => port.close()); } };
}

describe("W16 shared LAZ admission", () => {
  it("bounds queued jobs and releases reservations after cancellation", async () => {
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const controller = new AbortController(), entered = vi.fn();
    const queued = Array.from({ length: LAZ_MAX_QUEUED_JOBS }, () =>
      withLazAdmission(1, { signal: controller.signal }, async () => { entered(); }));
    const outcomes = Promise.allSettled(queued);
    await expect(withLazAdmission(1, {}, async () => {})).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
      details: { reason: "laz-admission-limit", queued: LAZ_MAX_QUEUED_JOBS } });
    controller.abort();
    expect((await outcomes).every((outcome) => outcome.status === "rejected" && outcome.reason.code === "REQUEST_CANCELLED")).toBe(true);
    expect(entered).not.toHaveBeenCalled();
    release(); await active; await flush();
    await expect(withLazAdmission(1, {}, async () => 7)).resolves.toBe(7);
    await flush();
  });
  it("caps aggregate retained bytes before dispatch and restores admission after completion", async () => {
    let release!: () => void;
    const active = withLazAdmission(LAZ_MAX_ADMITTED_BYTES, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const entered = vi.fn();
    await expect(withLazAdmission(1, {}, async () => { entered(); })).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
      details: { reason: "laz-admission-limit", admittedBytes: LAZ_MAX_ADMITTED_BYTES } });
    expect(entered).not.toHaveBeenCalled();
    release(); await active; await flush();
    await expect(withLazAdmission(LAZ_MAX_ADMITTED_BYTES, {}, async () => 1)).resolves.toBe(1);
    await flush();
  });
  it("reserves input copies and both sides of a structured-cloned decoded result", async () => {
    // A 5M-record LAS 7 request reserves 480 MB of records/results before input
    // copies. A 20 MB input crosses the shared 512 MiB limit before any dispatch.
    const reservation = lazAdmissionBytes(20 * 1024 * 1024, 36, 5_000_000), entered = vi.fn();
    expect(reservation).toBeGreaterThan(LAZ_MAX_ADMITTED_BYTES);
    await expect(withLazAdmission(reservation, {}, async () => { entered(); })).rejects.toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED", details: { reason: "laz-admission-limit" },
    });
    expect(entered).not.toHaveBeenCalled();
  });
  it("rejects public and supplied-pool subviews whose cloned backing stores exceed the remaining budget", async () => {
    const backing = new Uint8Array(bytes.length + 4096), input = backing.subarray(1024, 1024 + bytes.length);
    input.set(bytes);
    const header = parseLasHeader(input),
      viewOnlyReservation = lazAdmissionBytes(input.byteLength, header.recordLength, header.pointCount);
    let release!: () => void;
    // The old view-length reservation would fit with one byte to spare. Both
    // caller and structured-cloned worker retain the extra backing-store bytes.
    const active = withLazAdmission(LAZ_MAX_ADMITTED_BYTES - viewOnlyReservation - 1, {},
      () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const worker = vi.fn(); vi.stubGlobal("Worker", worker);
    const handler = vi.fn(async () => ({ positions: new Float64Array([1, 2, 3]) })), owned = ownedPool(handler),
      source = new PointSource({ workerPool: owned.pool });
    try {
      await expect(decodeLaz(input)).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
        details: { reason: "laz-admission-limit" } });
      await expect(source.decode({ kind: "laz-file", bytes: input }, async () => { throw Error("fallback"); }))
        .rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED", details: { reason: "laz-admission-limit" } });
      expect(worker).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
      expect(owned.pool.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
      expect(input).toEqual(bytes); expect(input.buffer.byteLength).toBe(bytes.length + 4096);
    } finally { source.dispose(); owned.dispose(); release(); await active; await flush(); vi.unstubAllGlobals(); }
  });
  it("counts waiting time against the same deadline and preserves caller input on queued expiry", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const entered = vi.fn(), input = bytes.slice();
    const waiting = withLazAdmission(input.length, { timeoutMs: 10 }, async () => { entered(); });
    const failed = expect(waiting).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
      details: { reason: "worker-deadline-exceeded", timeoutMs: 10 } });
    try {
      await vi.advanceTimersByTimeAsync(10); await failed;
      expect(entered).not.toHaveBeenCalled(); expect(input.byteLength).toBe(bytes.length);
    } finally { release(); await active; await flush(); vi.useRealTimers(); }
  });
  it("limits native work across independent caller-supplied dataset pools", async () => {
    const releases: Array<() => void> = [];
    let running = 0, maximum = 0;
    const handler = async () => {
      running++; maximum = Math.max(maximum, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--; return { positions: new Float64Array([1, 2, 3]) };
    };
    const a = ownedPool(handler), b = ownedPool(handler),
      first = new PointSource({ workerPool: a.pool }), second = new PointSource({ workerPool: b.pool });
    try {
      const jobs = [first, second, first].map((source) => source.decode({ kind: "laz-file", bytes }, async () => { throw Error("fallback"); }));
      for (let i = 0; i < jobs.length; i++) {
        await vi.waitFor(() => expect(releases.length).toBe(i + 1));
        expect(a.pool.getDiagnostics().active + b.pool.getDiagnostics().active).toBe(1);
        releases[i]!(); await jobs[i];
      }
      await Promise.all(jobs); expect(maximum).toBe(1);
    } finally { first.dispose(); second.dispose(); a.dispose(); b.dispose(); await flush(); }
  });
  it("honors a supplied pool's shorter deadline while waiting for another dataset", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const handler = vi.fn(async () => ({ positions: new Float64Array([1, 2, 3]) })), owned = ownedPool(handler, 10),
      source = new PointSource({ workerPool: owned.pool });
    const pending = source.decode({ kind: "laz-file", bytes }, async () => { throw Error("fallback"); });
    const failed = expect(pending).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
      details: { reason: "worker-deadline-exceeded", timeoutMs: 10 } });
    try {
      await vi.advanceTimersByTimeAsync(10); await failed;
      expect(handler).not.toHaveBeenCalled(); expect(owned.pool.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
    } finally { source.dispose(); owned.dispose(); release(); await active; await flush(); vi.useRealTimers(); }
  });
  it("public decode cancellation while waiting does not construct a worker", async () => {
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const worker = vi.fn(); vi.stubGlobal("Worker", worker);
    const controller = new AbortController(), pending = decodeLaz(bytes, { signal: controller.signal });
    controller.abort();
    try {
      await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
      expect(worker).not.toHaveBeenCalled(); expect(bytes.byteLength).toBeGreaterThan(0);
    } finally { release(); await active; await flush(); vi.unstubAllGlobals(); }
  });
  it("shares one native permit across independently imported package graphs", async () => {
    vi.resetModules();
    const otherGraph = await import("../../src-ts/laz-admission.js");
    expect(otherGraph.withLazAdmission).not.toBe(withLazAdmission);
    vi.useFakeTimers();
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const entered = vi.fn(), waiting = otherGraph.withLazAdmission(1, { timeoutMs: 10 }, async () => { entered(); });
    const failed = expect(waiting).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
      details: { reason: "worker-deadline-exceeded", timeoutMs: 10 } });
    try {
      await vi.advanceTimersByTimeAsync(10); await failed;
      expect(entered).not.toHaveBeenCalled();
      release(); await active; await flush();
      await expect(otherGraph.withLazAdmission(1, {}, async () => 9)).resolves.toBe(9);
      await flush();
    } finally { release(); await active; await flush(); vi.useRealTimers(); }
  });
  it("preserves a pool's shorter waiting deadline when the dataset comes from another package graph", async () => {
    vi.resetModules();
    const otherGraph = await import("../../src-ts/pointcloud-source.js");
    expect(otherGraph.PointSource).not.toBe(PointSource);
    vi.useFakeTimers();
    let release!: () => void;
    const active = withLazAdmission(1, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await flush();
    const handler = vi.fn(async () => ({ positions: new Float64Array([1, 2, 3]) })), owned = ownedPool(handler, 10),
      source = new otherGraph.PointSource({ workerPool: owned.pool });
    let outcome: unknown;
    const pending = source.decode({ kind: "laz-file", bytes }, async () => { throw Error("fallback"); })
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(outcome).toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED",
        details: { reason: "worker-deadline-exceeded", timeoutMs: 10 } });
      expect(handler).not.toHaveBeenCalled(); expect(owned.pool.getDiagnostics()).toMatchObject({ active: 0, queued: 0 });
    } finally { source.dispose(); owned.dispose(); release(); await active; await pending; await flush(); vi.useRealTimers(); }
  });
});
