import { test, expect } from "../browser/webgpu-fixture";
import { readFileSync } from 'node:fs';
const native = JSON.parse(readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url), 'utf8'));
declare global { interface Window { __w20: any } }
for (const dist of [false, true]) {
  const label = dist ? 'dist' : 'source';
  test.describe(`W20 ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/examples/cartography.html?' + (dist ? 'dist' : 'source'));
      await page.waitForFunction(() => window.__w20?.ready);
    });
    test(`W20 ${label}: all 33 native map plate cases`, async ({ page }) => {
      for (const c of native.tests.filter((c: any) => c.source === 'test_map_plate_layout.py')) await test.step(`${c.source}::${c.class}::${c.test}`, async () => {
        expect(await page.evaluate(async c => await window.__w20.nativePlateCase(c.class, c.test), c)).toBe(true);
      });
    });
    test(`W20 ${label}: plate PNG/JPEG pixels, inset border, layout and bounded replacements`, async ({ page }, info) => {
      const r = await page.evaluate(async () => {
        const { makePlate } = window.__w20, p = await makePlate(), layout = await p.layout(), frame = await p.compose(), png = await p.exportPng(), jpeg = await p.exportJpeg({ quality: 1 });
        const decode = async (blob: Blob) => { const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data; return bytes; };
        const bytes = await decode(png), lossy = await decode(jpeg), inset = layout.elements.find((e: any) => e.kind === 'inset').rect;
        const before = p.getMemoryReport(); for (let i = 0; i < 30; i++) { p.setMapRegion(window.__w20.pixels(120, 80, 4, [40, 130, 80, 255]), p.bbox); await p.exportPng(); } const after = p.getMemoryReport();
        p.dispose(); return { equal: bytes.every((v, i) => v === frame.data[i]), jpeg: Array.from(lossy.slice((100 * 480 + 100) * 4, (100 * 480 + 100) * 4 + 4)), inset: frame.pixel(inset.x0 + 3, inset.y0 + 3), border: frame.pixel(inset.x0 - 1, inset.y0 - 1), layout: { map: layout.mapImage.rect, region: layout.mapRegion.rect }, before, after, disposed: p.getMemoryReport(), png: Array.from(new Uint8Array(await png.arrayBuffer())) };
      });
      expect(r.equal).toBe(true); expect(r.jpeg[0]).toBeGreaterThanOrEqual(38); expect(r.jpeg[0]).toBeLessThanOrEqual(42);
      expect(r.inset).toEqual([25, 50, 150, 255]); expect(r.border).toEqual([0, 0, 0, 255]); expect(r.layout).toEqual({ map: [20, 52, 360, 278], region: [20, 45, 360, 285] });
      expect(r.after.cpuBytes).toBe(r.before.cpuBytes); expect(r.after.workingBytes).toBe(0); expect(r.disposed.cpuBytes).toBe(0);
      await info.attach('plate.png', { body: Buffer.from(r.png), contentType: 'image/png' });
    });
    test(`W20 ${label}: standalone SVG parses, embeds fonts and renders polygon holes and labels`, async ({ page }) => {
      const r = await page.evaluate(async () => {
        const { api, vectorExports } = window.__w20, { svg } = await vectorExports(), text = await svg.text(), doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const url = URL.createObjectURL(svg), img = new Image(); try { img.src = url; await img.decode(); const canvas = new OffscreenCanvas(200, 100), ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
          const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data), labels = ctx.getImageData(35, 8, 130, 18).data; return { valid: api.validateSvg(text), errors: doc.querySelectorAll('parsererror').length, embedded: text.includes('data:font/ttf;base64,'), path: doc.querySelector('path')?.getAttribute('fill-rule'), red: pixel(10, 80), hole: pixel(100, 65), line: pixel(100, 50), darkText: labels.filter((v, i) => i % 4 !== 3 && v < 100).length, deterministic: text === await (await vectorExports()).svg.text() };
        } finally { URL.revokeObjectURL(url); }
      });
      expect(r).toMatchObject({ valid: true, errors: 0, embedded: true, path: 'evenodd', red: [255, 0, 0, 255], hole: [255, 255, 255, 255], line: [0, 0, 255, 255], deterministic: true }); expect(r.darkText).toBeGreaterThan(20);
    });
    test(`W20 ${label}: PDF page, vector/text/font objects and byte determinism`, async ({ page }, info) => {
      const r = await page.evaluate(async () => {
        const { pdf } = await window.__w20.vectorExports(), second = (await window.__w20.vectorExports()).pdf;
        const lib = await import('/dist/vendor/pdf-lib.js' as string), doc = await lib.PDFDocument.load(await pdf.arrayBuffer()), page = doc.getPage(0), streams = doc.context.enumerateIndirectObjects().flatMap(([, o]: any) => o instanceof lib.PDFRawStream ? [new TextDecoder().decode(lib.decodePDFRawStream(o).decode())] : []).join('\n'), bytes = new Uint8Array(await pdf.arrayBuffer()), other = new Uint8Array(await second.arrayBuffer());
        return { pages: doc.getPageCount(), size: page.getSize(), evenOdd: streams.includes('f*'), text: streams.includes('BT') && streams.includes('Tj'), halo: streams.includes('2 Tr'), fonts: page.node.Resources().lookup(lib.PDFName.of('Font'), lib.PDFDict).keys().length, same: bytes.every((v, i) => v === other[i]), bytes: Array.from(bytes) };
      });
      expect(r).toMatchObject({ pages: 1, size: { width: 150, height: 75 }, evenOdd: true, text: true, halo: true, same: true }); expect(r.fonts).toBeGreaterThan(0);
      await info.attach('cartography.pdf', { body: Buffer.from(r.bytes), contentType: 'application/pdf' });
    });
    test(`W20 ${label}: worker OffscreenCanvas reproduces exact main-thread pixels and exports`, async ({ page }) => {
      const r = await page.evaluate(async label => {
        const worker = new Worker('/examples/cartography-worker.js?' + label, { type: 'module' });
        try {
          const result: any = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Worker composition timed out')), 15000); worker.onmessage = e => { clearTimeout(timer); e.data.error ? reject(Error(e.data.error + '\n' + e.data.stack)) : resolve(e.data); }; worker.onerror = e => reject(Error(e.message)); worker.postMessage('compose'); });
          const p = await window.__w20.makePlate(), frame = await p.compose(), vectors = await window.__w20.vectorExports(), workerPdf = new Uint8Array(await result.pdf.arrayBuffer()); p.dispose();
          return { equal: frame.data.every((v: number, i: number) => v === result.data[i]), png: result.png.type, svg: result.svg.type, pdf: result.pdf.type, vectorEqual: await vectors.svg.text() === await result.svg.text(), pdfEqual: new Uint8Array(await vectors.pdf.arrayBuffer()).every((v, i) => v === workerPdf[i]) };
        } finally { worker.terminate(); }
      }, label);
      expect(r).toMatchObject({ equal: true, png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf', vectorEqual: true, pdfEqual: true });
    });
    test(`W20 ${label}: abort, OPFS output, disposal and canvas capability diagnostics`, async ({ page }) => {
      const r = await page.evaluate(async () => {
        const { api, makePlate } = window.__w20, p = await makePlate(); let aborted, disposed, budget;
        try { await p.exportPng({ signal: AbortSignal.abort() }); } catch (e: any) { aborted = e.code; }
        const png = await p.exportPng(), dir = await navigator.storage.getDirectory(), file = await dir.getFileHandle('w20.png', { create: true }), write = await file.createWritable(); await write.write(png); await write.close(); const loaded = await file.getFile(); await dir.removeEntry('w20.png');
        p.dispose(); try { await p.compose(); } catch (e: any) { disposed = e.code; } try { new api.MapPlate({ width: 1000, height: 1000, maxBytes: 100 }); } catch (e: any) { budget = e.code; }
        return { aborted, disposed, budget, stored: loaded.size === png.size, memory: p.getMemoryReport() };
      });
      expect(r).toMatchObject({ aborted: 'REQUEST_CANCELLED', disposed: 'RUNTIME_DISPOSED', budget: 'RESOURCE_LIMIT_EXCEEDED', stored: true, memory: { cpuBytes: 0, workingBytes: 0 } });
    });
    test(`W20 ${label}: downloadable example exposes four valid Blobs`, async ({ page }) => {
      await page.locator('#compose').click(); await expect(page.locator('#status')).toHaveText('Plate composed. Four downloads are ready.');
      for (const id of ['png', 'jpeg', 'svg', 'pdf']) await expect(page.locator('#' + id)).toHaveAttribute('href', /^blob:/);
    });
    test(`W20 ${label}: colormap File/URL/CPT/JSON imports and label/vector adapters`, async ({ page }) => {
      const r = await page.evaluate(async () => {
        const a = window.__w20.api, cpt = '# COLOR_MODEL = RGB\n0 0 0 0 1 255 255 255', blob = new File([cpt], 'gray.cpt'), url = URL.createObjectURL(blob);
        try {
          const maps = []; for (const source of [blob, url, blob.stream(), await blob.arrayBuffer()]) maps.push((await a.loadColormap(source, 'cpt', { size: 3 })).toDisplayRgba8()[4]);
          const json = await a.loadColormap(new Blob(['{"stops":[[0,"#000000"],[1,"#ffffff"]]}']), 'json', { size: 3 });
          const vectors = a.vectorSceneFromLayers([{ name: 'land', features: [{ id: 1, kind: 'polygon', rings: [[[0, 9, 0], [1, 9, 0], [0, 9, 1]]] }] }]);
          vectors.addLabelPlan({ accepted: [{ text: 'Accepted', screen_bounds: [20, 10, 40, 30], typography: { font_size: 12 } }] }, 100);
          const label = vectors.labels[0], count = vectors.polygons.length; vectors.dispose();
          const texture = json.toTexture(); return { maps, midpoint: json.sample(.5), texture: [texture.width, texture.height, texture.format], label, count };
        } finally { URL.revokeObjectURL(url); }
      });
      expect(r.maps).toEqual([128, 128, 128, 128]); expect(r.midpoint).toEqual([.5, .5, .5, 1]); expect(r.texture).toEqual([3, 1, 'rgba8unorm']); expect(r.label).toMatchObject({ text: 'Accepted', position: [30, 80], style: { fontSize: 12 } }); expect(r.count).toBe(1);
    });
    test(`W20 ${label}: saved-frame composition survives device loss and unavailable WebGPU`, async ({ page }) => {
      const r = await page.evaluate(async label => {
        const { api, makePlate } = window.__w20, p = await makePlate(), before = await p.compose(), canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const runtime = await api.Forge3DRuntime.create(canvas, { diagnostics: true });
        const internals = await import(label === 'source' ? '/src-ts/runtime-internals.ts' : '/dist/runtime-internals.js');
        const lost = new Promise<string>(resolve => internals.setRuntimeDeviceLostHandler(runtime, (e: any) => resolve(e.code))); internals.simulateRuntimeDeviceLossForTests(runtime); const loss = await lost; const after = await p.compose(); runtime.dispose();
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined }); const blob = await p.exportPng(); p.dispose();
        return { loss, same: before.data.every((v: number, i: number) => v === after.data[i]), type: blob.type, memory: p.getMemoryReport().cpuBytes };
      }, label);
      expect(r).toEqual({ loss: 'DEVICE_LOST', same: true, type: 'image/png', memory: 0 });
    });
  });
}
