import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetRegistry } from "../../src-ts/datasets.js";
import { fetchRemoteDatasetWithRetry } from "../../scripts/remote-dataset-retry.mjs";

const bytes = new Uint8Array([1, 2, 3]);
const name = "sample-buildings";
const registries: DatasetRegistry[] = [];
function registry(maxAssetBytes?: number) {
  const native = new DatasetRegistry({ cache: null });
  const entry = { ...native.info(name), byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), version: "retry-negative-control" };
  native.dispose();
  const result = new DatasetRegistry({ entries: [entry], cache: null,
    baseUrl: "https://self.test/", maxAssetBytes });
  registries.push(result);
  return result;
}
function interruptedBody() {
  let pulled = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!pulled) { pulled = true; controller.enqueue(bytes.slice(0, 1)); }
    else controller.error(new TypeError("terminated"));
  } }));
}
afterEach(() => { for (const r of registries.splice(0)) r.dispose(); vi.unstubAllGlobals(); });

it("retries an interrupted real registry stream with fresh deadlines, then verifies complete bytes", async () => {
  const r = registry(), failures: any[] = [], signals: AbortSignal[] = [];
  const fetch = vi.fn(async (_url, options) => {
    signals.push(options.signal);
    return signals.length === 1 ? interruptedBody() : new Response(bytes);
  });
  vi.stubGlobal("fetch", fetch);
  const wait = vi.fn(async () => {});
  expect(await fetchRemoteDatasetWithRetry(r, name, { wait, onFailure: (f: any) => {
    failures.push(f); expect(r.getDiagnostics().memoryBytes).toBe(0);
  } })).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(signals[0]).not.toBe(signals[1]);
  expect(signals.every((s) => !s.aborted)).toBe(true);
  expect(wait).toHaveBeenCalledExactlyOnceWith(1000);
  expect(failures).toMatchObject([{ name, url: r.url(name).href, attempt: 1, maxAttempts: 3,
    deadlineMs: 120000, retrying: true, code: "IO_ERROR",
    details: { kind: "asset-io", asset: name, reason: "TypeError: terminated" } }]);
  expect(r.getDiagnostics().activeRequests).toBe(0);
});

it("keeps three interrupted streams fatal and records every attempt", async () => {
  const r = registry(), failures: any[] = [], wait = vi.fn(async () => {});
  const fetch = vi.fn(async () => interruptedBody()); vi.stubGlobal("fetch", fetch);
  await expect(fetchRemoteDatasetWithRetry(r, name, { wait, onFailure: (f: any) => failures.push(f) }))
    .rejects.toMatchObject({ code: "IO_ERROR", details: { reason: "TypeError: terminated" } });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(wait.mock.calls).toEqual([[1000], [2000]]);
  expect(failures.map((f) => [f.attempt, f.retrying])).toEqual([[1, true], [2, true], [3, false]]);
  expect(r.getDiagnostics()).toMatchObject({ memoryBytes: 0, activeRequests: 0 });
});

it("never retries complete corrupt bytes even when a subsequent response would be valid", async () => {
  const r = registry(), wait = vi.fn(), onFailure = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 4])))
    .mockResolvedValueOnce(new Response(bytes)); vi.stubGlobal("fetch", fetch);
  await expect(fetchRemoteDatasetWithRetry(r, name, { wait, onFailure }))
    .rejects.toMatchObject({ code: "IO_ERROR", details: { kind: "asset-integrity" } });
  expect(fetch).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  expect(onFailure.mock.calls[0][0].retrying).toBe(false);
});

it("never retries resource limits", async () => {
  const r = registry(2), wait = vi.fn(), onFailure = vi.fn(), fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(fetchRemoteDatasetWithRetry(r, name, { wait, onFailure }))
    .rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
  expect(fetch).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  expect(onFailure).toHaveBeenCalledTimes(1);
});

it("never retries typed cancellation", async () => {
  const r = registry(), wait = vi.fn(), onFailure = vi.fn();
  const fetch = vi.fn(async () => { throw new DOMException("Aborted", "AbortError"); });
  vi.stubGlobal("fetch", fetch);
  await expect(fetchRemoteDatasetWithRetry(r, name, { wait, onFailure }))
    .rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
});

it.each(["HTTP", "other transport", "wrong asset"])("does not retry %s errors", async (kind) => {
  const r = registry(), wait = vi.fn(), onFailure = vi.fn();
  const fetch = vi.fn(async () => {
    if (kind === "HTTP") return new Response("", { status: 503 });
    throw new TypeError("fetch failed");
  });
  if (kind === "wrong asset") vi.spyOn(r, "fetch").mockRejectedValue({ code: "IO_ERROR",
    details: { kind: "asset-io", asset: "another", reason: "TypeError: terminated" } });
  vi.stubGlobal("fetch", fetch);
  await expect(fetchRemoteDatasetWithRetry(r, name, { wait, onFailure })).rejects.toMatchObject({ code: "IO_ERROR" });
  expect(wait).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledTimes(1);
  if (kind !== "wrong asset") expect(fetch).toHaveBeenCalledTimes(1);
});
