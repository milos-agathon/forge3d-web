import type { Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Observe the real calls without retaining GPU objects or replacing results. */
export async function installW19GpuTimings(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Entry = { method: string; label: string; startedAt: number; elapsedMs?: number; outcome?: string; adapter?: string };
        const entries: Entry[] = [];
        const state = { entries, dropped: 0 };
        Object.defineProperty(window, '__forge3dW19GpuTimings', { value: state });
        function observe(prototype: any, method: string) {
            const original = prototype?.[method];
            if (typeof original !== 'function') return;
            prototype[method] = function (...args: any[]) {
                if (entries.length >= 2048) { state.dropped++; return Reflect.apply(original, this, args); }
                const entry: Entry = { method, label: args[0]?.label ?? '', startedAt: performance.now(), outcome: 'pending' };
                entries.push(entry);
                const finish = (outcome: string, value?: any) => {
                    entry.elapsedMs = performance.now() - entry.startedAt;
                    entry.outcome = outcome;
                    if (method === 'requestAdapter' && value?.info) {
                        entry.adapter = [value.info.vendor, value.info.architecture, value.info.isFallbackAdapter].join(' / ');
                    }
                };
                try {
                    const value = Reflect.apply(original, this, args);
                    if (value instanceof Promise) void value.then(result => finish('resolved', result), () => finish('rejected'));
                    else finish('returned');
                    return value;
                } catch (error) { finish('threw'); throw error; }
            };
        }
        if (typeof GPU === 'undefined') return;
        observe(GPU.prototype, 'requestAdapter');
        observe(GPUAdapter.prototype, 'requestDevice');
        for (const method of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline', 'pushErrorScope', 'popErrorScope', 'destroy']) {
            observe(GPUDevice.prototype, method);
        }
        observe(GPUBuffer.prototype, 'mapAsync');
        observe(GPUQueue.prototype, 'onSubmittedWorkDone');
    });
}

export async function attachW19GpuTimings(page: Page, info: TestInfo): Promise<void> {
    const timings = await page.evaluate(() => (window as any).__forge3dW19GpuTimings ?? null)
        .catch(error => ({ unavailable: String(error) }));
    // The line reporter does not persist attachment bodies for artifact upload.
    const path = info.outputPath('w19-native-gpu-timings.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ title: info.title, status: info.status, timings }, null, 2));
    await info.attach('w19-native-gpu-timings.json', {
        path,
        contentType: 'application/json',
    });
}
