import { expect, test, skipRenderAssertionsWhenProbing } from "../browser/webgpu-fixture";
import { expectVectorOit, maskDualSource } from "../browser/w12-oit";

test.beforeEach(async ({ page, webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await page.goto("/examples/test-w12-camera.html");
    await page.waitForFunction(() => (window as any).__w12CameraReady);
});

for (const mutation of ["translation", "projection"] as const) {
    for (const kind of ["selection", "hover"] as const) {
        test(`R2 ${kind} tint and outline follow a camera ${mutation}`, async ({ page }) => {
            const result = await page.evaluate(({ kind, mutation }) =>
                (window as any).__w12CameraHighlight(kind, mutation), { kind, mutation });
            expect(result.oldCovered, JSON.stringify(result)).toBeGreaterThan(100);
            expect(result.covered).toBeGreaterThan(100);
            expect(result.overlapping).toBe(0);
            expect(result.tinted).toBe(result.covered);
            expect(result.staleGreen).toBe(0);
            expect(result.freshDelta, JSON.stringify(result)).toBe(0);
        });
    }

    test(`R3 immediate point/rect/lasso picks use the camera ${mutation}`, async ({ page }) => {
        const result = await page.evaluate(mutation =>
            (window as any).__w12CameraPicks(mutation), mutation);
        expect(result.cases).toHaveLength(3);
        expect(result.oldCenter).not.toEqual(result.newCenter);
        for (const item of result.cases) {
            const message = JSON.stringify({ mutation, ...item });
            const ids = (value: any): number[] => Array.isArray(value)
                ? value.map(hit => hit.id) : value === null ? [] : [value.id];
            expect(ids(item.warmed), message).toEqual([1]);
            expect(item.immediate, message).toEqual(item.fresh);
            expect(ids(item.immediate), message).toEqual([]);
            expect(ids(item.newHit), message).toEqual([1]);
            expect(item.immediateRenders, message).toBe(1);
        }
    });
}

test("near zero-offset drapes retain depth bias and identical CPU/GPU projection", async ({ page }) => {
    const rows = await page.evaluate(() => (window as any).__w12NearDrape());
    expect(rows).toHaveLength(4);
    for (const row of rows) {
        const message = JSON.stringify({ row, rows });
        expect(row.report.effectiveCulling, message).toBe(row.culling);
        expect(row.red, message).toBeGreaterThan(100);
        expect(row.picked, message).toBeGreaterThan(100);
        expect(row.aligned, message).toBe(row.picked);
        expect(row.byteIdentical, message).toBe(true);
        expect(row.vertexCount, message).toBeGreaterThan(0);
    }
});

for (const masked of [false, true]) test(`ordinary and far depths preserve terrain occlusion and nearest opaque order with ${masked ? "masked dual-source" : "adapter capabilities"}`, async ({ page }) => {
    test.setTimeout(120000);
    if (masked) {
        await maskDualSource(page);
        await page.waitForFunction(() => (window as any).__w12CameraReady);
    }
    const rows = await page.evaluate(() => (window as any).__w12DepthOcclusion());
    expect(rows).toHaveLength(41);
    for (const row of rows) {
        const message = JSON.stringify({ row, rows });
        if (row.kind === "arithmetic") {
            expect(row.gpuReport.effectiveCulling, message).toBe("gpu");
            expect(row.cpuReport.effectiveCulling, message).toBe("cpu");
            expect(row.gpuCovered, message).toBeGreaterThan(100);
            expect(row.cpuCovered, message).toBeGreaterThan(100);
            expect(row.colorDelta, message).toBeLessThanOrEqual(1);
            expect(row.idDelta, message).toBe(0);
            expect(row.byteIdentical, message).toBe(true);
            expect(row.vertexCount, message).toBeGreaterThan(1000);
            continue;
        }
        expect(row.reference.back, message).toBeGreaterThan(row.reference.front);
        expect(row.reference.separation, message).toBeGreaterThan(2 ** -24);
        expect(row.reference.separation, message).toBeGreaterThan(.01 * 1e-5);
        expect(row.reference.coarseFront, message).toBe(row.reference.coarseBack);
        expect(row.reference.coarseBack, message).toBeLessThan(row.reference.front);
        expect(row.report.effectiveCulling, message).toBe(row.culling);
        expect(row.byteIdentical, message).toBe(true);
        expect(row.vertexCount, message).toBeGreaterThan(0);
        if (row.kind === "terrain") {
            expect(row.terrainCovered, message).toBeGreaterThan(1000);
            expect(row.red, message).toBe(0);
            expect(row.picked, message).toBe(0);
            expect(row.terrainDelta, message).toBe(0);
        } else {
            expect(typeof row.available, message).toBe("boolean");
            if (masked) expect(row.available, message).toBe(false);
            expectVectorOit(row.report, row.mode, row.available, message);
            expect(row.covered, message).toBeGreaterThan(100);
            expect(row.wrongPick, message).toBe(0);
            expect(row.wrongColor, message).toBe(0);
            expect(row.centerId, message).toBe(1);
            expect(row.centerColor, message).toEqual([255, 0, 0, 255]);
        }
    }
});
