import { test, expect } from "../browser/webgpu-fixture";
import { readFileSync } from 'node:fs';
import { runNativePlateCase } from '../browser/w20-native-plate-cases.js';
const native = JSON.parse(readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url), 'utf8'));
const layoutOracle = JSON.parse(readFileSync(new URL('../fixtures/w20/layout-oracle.json', import.meta.url), 'utf8'));
const textOracle = JSON.parse(readFileSync(new URL('../fixtures/w20/text-layout-oracle.json', import.meta.url), 'utf8'));
declare global { interface Window { __w20: any } }
test.use({ trace: 'retain-on-failure' });
for (const dist of [false, true]) {
  const label = dist ? 'dist' : 'source';
  test.describe(`W20 ${label}`, () => {
    test.beforeEach(async ({ page }, info) => {
      const started = Date.now(), errors: string[] = [], failedRequests: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      const onRequestFailed = (request: import('@playwright/test').Request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
      const onResponse = (response: import('@playwright/test').Response) => {
        if (response.status() >= 400) failedRequests.push(`${response.url()}: HTTP ${response.status()}`);
      };
      page.on('pageerror', onError);
      page.on('requestfailed', onRequestFailed);
      page.on('response', onResponse);
      try {
        await page.goto('/examples/cartography.html?' + (dist ? 'dist' : 'source'));
        await page.waitForFunction(() => window.__w20?.ready);
      } catch (error) {
        await info.attach('w20-startup.json', {
          body: JSON.stringify({ url: page.url(), elapsedMs: Date.now() - started, errors, failedRequests }, null, 2),
          contentType: 'application/json',
        });
        throw new Error(`W20 ${label} startup failed: ${[...errors, ...failedRequests].join('\n') || 'ready was not reached'}`, { cause: error });
      } finally {
        page.off('pageerror', onError);
        page.off('requestfailed', onRequestFailed);
        page.off('response', onResponse);
      }
    });
    test(`W20 ${label}: native title bounds cover the expanded text corpus`, async ({ page }, info) => {
      const r = await page.evaluate(async rows => {
        const a = window.__w20.api, results = [];
        for (const c of rows) {
          const p = new a.MapPlate({ width: 320, height: 200 }).addTitle(c.text, { fontSize: c.size });
          const rect = (await p.layout()).elements[0].rect; p.dispose();
          results.push({ text: c.text, size: c.size, widthError: Math.abs(rect.width - 20 - c.width), heightError: Math.abs(rect.height - 20 - c.height) });
        }
        return results;
      }, textOracle.filter((c: any) => c.browser));
      expect(r).toHaveLength(63);
      for (const c of r) { expect(c.widthError, JSON.stringify(c)).toBe(0); expect(c.heightError, JSON.stringify(c)).toBeLessThanOrEqual(1); }
      await info.attach('native-text-layout.json', { body: JSON.stringify(r), contentType: 'application/json' });
    });
    for (const [script, text] of [['arabic', 'مرحبا بالعالم'], ['devanagari', 'नमस्ते']]) test(`W20 ${label}: ${script} SVG/PDF exports`, async ({ page }, info) => {
      const r = await page.evaluate(async text => {
        const a = window.__w20.api, s = new a.VectorScene().addLabel(text, [50, 50], { fontSize: 28, haloWidth: 0 });
        try { const opts = { width: 300, height: 100, bounds: new a.Bounds(), dpi: 96, background: [1, 1, 1, 1] }, pdf = await a.exportPdf(s, opts), svg = await a.exportSvg(s, opts), markup = await svg.text(); return { type: pdf.type, svg: svg.type, valid: a.validateSvg(markup), unicode: markup.includes(text), bytes: Array.from(new Uint8Array(await pdf.arrayBuffer())) }; }
        finally { s.dispose(); }
      }, text);
      expect(r.type).toBe('application/pdf'); expect(r.svg).toBe('image/svg+xml'); expect(r.valid && r.unicode).toBe(true); expect(r.bytes.length).toBeGreaterThan(1000);
      await info.attach(script + '.pdf', { body: Buffer.from(r.bytes), contentType: 'application/pdf' });
    });
    test(`W20 ${label}: all 33 native map plate cases`, async ({ page }) => {
      for (const c of native.tests.filter((c: any) => c.source === 'test_map_plate_layout.py')) await test.step(`${c.source}::${c.class}::${c.test}`, async () => {
        const result = await page.evaluate(runNativePlateCase, { cls: c.class, test: c.test });
        expect(result.id).toBe(c.class + '::' + c.test); expect(result.assertions).toBeGreaterThan(0);
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
    test.describe(() => {
      // Hosted Chromium can intermittently fail before the example module is ready.
      // Retry only this case in that workflow; keep its deadlines and assertions.
      test.describe.configure({ retries: process.env.FORGE3D_W20_STARTUP_RETRY === '1' ? 1 : 0 });
      test(`W20 ${label}: downloadable example exposes four valid Blobs`, async ({ page }) => {
        await page.locator('#compose').click(); await expect(page.locator('#status')).toHaveText('Plate composed. Four downloads are ready.');
        for (const id of ['png', 'jpeg', 'svg', 'pdf']) await expect(page.locator('#' + id)).toHaveAttribute('href', /^blob:/);
      });
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
    test(`W20 ${label}: native glyphs, furniture and composed layout stay within one pixel`, async ({ page }, info) => {
      const r = await page.evaluate(async control => {
        const a = window.__w20.api; await a.loadCartographicFonts();
        const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('2d')!;
        const metrics = [];
        for (const m of control.metrics) {
          const title = new a.MapPlate({ width: 480, height: 320 }).addTitle(m.text, { fontSize: m.size });
          const rect = (await title.layout()).elements[0].rect; title.dispose();
          ctx.font = `700 ${m.size}px "DejaVu Sans"`; const b = ctx.measureText(m.text);
          metrics.push({ text: m.text, widthError: Math.abs((m.bold ? Math.round(b.width) : rect.width - 20) - m.width), heightError: Math.abs((m.bold ? Math.round(b.actualBoundingBoxAscent + b.actualBoundingBoxDescent) : rect.height - 20) - m.height) });
        }
        const frames: Record<string, any> = {};
        frames.legend = await new a.Legend(a.colormaps.get('forge3d:viridis'), [0, 3000], { barHeight: 140, fontSize: 10, title: 'Elevation' }).render();
        frames.scale = await new a.ScaleBar(200, { widthPx: 140, fontSize: 10 }).render();
        frames.wideScale = await new a.ScaleBar(1e5, { widthPx: 40, units: 'm' }).render();
        for (const angle of [0, 30, 90, -45]) frames['arrow' + angle] = await new a.NorthArrow({ size: 40, rotationDeg: angle, fontSize: 10 }).render();
        const p = new a.MapPlate({ width: 480, height: 320, margin: [45, 120, 35, 20] });
        p.setMapRegion(window.__w20.pixels(120, 80, 4, [40, 130, 80, 255]), new a.BBox(-122, 46, -121, 47)).addTitle('Mountain atlas', { fontSize: 20 });
        // Deliberately reverse calls: drawing order must still be native's fixed order.
        p.addInset(window.__w20.pixels(30, 20, 4, [25, 50, 150, 255]), { size: [60, 40] });
        p.addNorthArrow(frames.arrow30).addScaleBar(frames.scale).addLegend(frames.legend);
        const layout = await p.layout(); frames.plate = await p.compose(); p.dispose();
        const title = new a.MapPlate({ width: 480, height: 320, background: [0, 0, 0, 0] }).addTitle('Mountain atlas', { fontSize: 20 });
        const tl = (await title.layout()).elements[0].rect, tf = await title.compose(); title.dispose();
        const bytes = new Uint8Array(tl.width * tl.height * 4);
        for (let y = 0; y < tl.height; y++) bytes.set(tf.data.subarray(((y + tl.y0) * tf.width + tl.x0) * 4, ((y + tl.y0) * tf.width + tl.x1) * 4), y * tl.width * 4);
        frames.title = { width: tl.width, height: tl.height, data: bytes };
        const mask = (f: any) => { const out = new Set<number>(); for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) { const i = (y * f.width + x) * 4; if (f.data[i + 3] > 128 && Math.max(f.data[i], f.data[i + 1], f.data[i + 2]) < 120) out.add(y * 10000 + x); } return out; };
        const withinOne = (left: Set<number>, right: Set<number>) => [...left].filter(k => [-1, 0, 1].some(dy => [-1, 0, 1].some(dx => right.has(k + dy * 10000 + dx)))).length / left.size;
        const images = []; let wrongRotation = 1;
        for (const [name, reference] of Object.entries(control.images) as [string, any][]) {
          const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(reference.png), c => c.charCodeAt(0))], { type: 'image/png' }));
          const surface = new OffscreenCanvas(bmp.width, bmp.height), cx = surface.getContext('2d')!; cx.drawImage(bmp, 0, 0); bmp.close();
          const original = { width: surface.width, height: surface.height, data: cx.getImageData(0, 0, surface.width, surface.height).data }, actual = frames[name];
          const expectedMask = mask(original), actualMask = mask(actual);
          images.push({ name, sizeError: Math.max(Math.abs(actual.width - reference.width), Math.abs(actual.height - reference.height)), inkCount: actualMask.size, withinOne: Math.min(withinOne(expectedMask, actualMask), withinOne(actualMask, expectedMask)) });
          if (name === 'arrow30') wrongRotation = Math.min(withinOne(expectedMask, mask(frames.arrow0)), withinOne(mask(frames.arrow0), expectedMask));
        }
        const rects = [{ kind: 'map', rect: layout.mapImage.rect }, ...layout.elements.map((e: any) => ({ kind: e.kind, rect: e.rect.rect }))];
        const stack = new a.MapPlate({ width: 100, height: 100, margin: [0, 0, 0, 0] });
        stack.addInset(window.__w20.pixels(50, 50, 4, [0, 0, 255, 255]), { position: 'center', borderWidth: 0 });
        stack.addNorthArrow(window.__w20.pixels(50, 50, 4, [0, 255, 0, 255]), 'center');
        stack.addScaleBar(window.__w20.pixels(50, 50, 4, [255, 0, 0, 255]), 'center');
        stack.addLegend(window.__w20.pixels(50, 50, 4, [255, 255, 0, 255]), 'center');
        const overlap = (await stack.compose()).pixel(50, 50); stack.dispose();
        return { metrics, images, rects, wrongRotation, overlap };
      }, layoutOracle);
      await info.attach('native-layout.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
      for (const m of r.metrics) { expect(m.widthError, JSON.stringify(m)).toBeLessThanOrEqual(1); expect(m.heightError, JSON.stringify(m)).toBeLessThanOrEqual(1); }
      expect(r.rects.map((e: any) => e.kind)).toEqual(layoutOracle.rects.map((e: any) => e.kind));
      r.rects.forEach((e: any, i: number) => e.rect.forEach((v: number, j: number) => expect(Math.abs(v - layoutOracle.rects[i].rect[j]), e.kind).toBeLessThanOrEqual(1)));
      for (const im of r.images) { expect(im.sizeError, JSON.stringify(im)).toBeLessThanOrEqual(1); expect(im.inkCount).toBeGreaterThan(10); expect(im.withinOne, JSON.stringify(im)).toBeGreaterThan(.97); }
      expect(r.wrongRotation).toBeLessThan(.9); expect(r.overlap).toEqual([0, 0, 255, 255]);
    });
    test(`W20 ${label}: actual GPU sampling consumes colormap texture bytes`, async ({ page }) => {
      const r = await page.evaluate(async () => {
        const gpu = (navigator as any).gpu, adapter = await gpu.requestAdapter(), device = await adapter.requestDevice(), a = window.__w20.api;
        const provider = new a.ColormapRegistry(false); provider.registerProvider('app', (name: string) => a.parseColormapJson({ name, stops: [[0, [0, 0, 0, .25]], [1, [1, .5, .25, 1]]] }, 4));
        const desc = provider.get('APP:gpu').toTexture();
        const texture = device.createTexture({ size: [desc.width, desc.height], format: desc.format, usage: 2 | 4 });
        const output = device.createBuffer({ size: 4 * 4 * 4, usage: 128 | 4 }), read = device.createBuffer({ size: 4 * 4 * 4, usage: 1 | 8 });
        try {
          device.queue.writeTexture({ texture }, desc.data, { bytesPerRow: 16 }, [4, 1]);
          const module = device.createShaderModule({ code: `@group(0) @binding(0) var colors: texture_2d<f32>; @group(0) @binding(1) var nearest: sampler; @group(0) @binding(2) var<storage,read_write> result: array<vec4<f32>>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3<u32>) { result[id.x] = textureSampleLevel(colors, nearest, vec2<f32>((f32(id.x)+0.5)/4.0,0.5),0.0); }` });
          const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
          const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) }, { binding: 2, resource: { buffer: output } }] });
          const sample = async () => { const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end(); encoder.copyBufferToBuffer(output, 0, read, 0, 64); device.queue.submit([encoder.finish()]); await read.mapAsync(1); const values = Array.from(new Float32Array(read.getMappedRange().slice(0))); read.unmap(); return values.map((v: number) => Math.round(v * 255)); };
          const actual = await sample(); const corrupted = desc.data.slice(); corrupted[0] = 255; device.queue.writeTexture({ texture }, corrupted, { bytesPerRow: 16 }, [4, 1]); const negative = await sample();
          return { expected: Array.from(desc.data), actual, negative };
        } finally { read.destroy(); output.destroy(); texture.destroy(); device.destroy(); }
      });
      expect(r.actual).toEqual(r.expected); expect(r.negative).not.toEqual(r.expected); expect(r.negative[0]).toBe(255);
    });
    test(`W20 ${label}: horizontal ticks, transparent JPEG and furniture cancellation`, async ({ page }) => {
      const r = await page.evaluate(async () => {
        const a = window.__w20.api, legend = await new a.Legend(a.colormaps.get('forge3d:viridis'), [0, 100], { orientation: 'horizontal', barHeight: 100, barWidth: 15 }).render();
        const ticks = [10, 59, 109].map(x => legend.pixel(x, 30));
        const p = new a.MapPlate({ width: 32, height: 32, background: [1, 1, 1, 0], margin: [0, 0, 0, 0] });
        const alpha = (await p.compose()).pixel(16,16)[3], jpeg = await p.exportJpeg(), bmp = await createImageBitmap(jpeg), canvas = new OffscreenCanvas(32, 32), ctx = canvas.getContext('2d')!; ctx.drawImage(bmp, 0, 0); bmp.close(); p.dispose();
        const codes = []; for (const f of [new a.Legend(a.colormaps.get('forge3d:viridis'), [0, 1]), new a.ScaleBar(100), new a.NorthArrow()]) for (const opts of [{ signal: AbortSignal.abort() }, { maxBytes: 1 }]) try { await f.render(opts); codes.push('missing'); } catch (e: any) { codes.push(e.code); }
        const white = Array.from(ctx.getImageData(16,16,1,1).data);
        const colored = new a.MapPlate({ width: 32, height: 32, background: [64/255,128/255,192/255,0], margin: [0,0,0,0] });
        const coloredJpeg = await colored.exportJpeg({ quality: 1 }), image = await createImageBitmap(coloredJpeg); ctx.drawImage(image,0,0); image.close(); colored.dispose();
        return { ticks, alpha, jpeg: Array.from(ctx.getImageData(0,0,1,1).data), white, codes };
      });
      expect(r.ticks).toEqual([[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
      expect(r.white).toEqual([255, 255, 255, 255]); expect(r.alpha).toBe(0);
      [64,128,192,255].forEach((v,i)=>expect(Math.abs(r.jpeg[i]! - v)).toBeLessThanOrEqual(2));
      expect(r.codes).toEqual(Array.from({ length: 3 }, () => ['REQUEST_CANCELLED', 'RESOURCE_LIMIT_EXCEEDED']).flat());
    });
    test(`W20 ${label}: pending font loads cancel, fail structurally and retry`, async ({ page }) => {
      let held: any;
      await page.route('**/DejaVuSans.ttf', route => { held = route; });
      const cancelled = await page.evaluate(async () => {
        const a = window.__w20.api, controller = new AbortController();
        const pending = new a.Legend(a.colormaps.get('forge3d:viridis'), [0, 1]).render({ signal: controller.signal });
        setTimeout(() => controller.abort(), 30);
        try { await pending; return 'missing'; } catch (e: any) { return e.code; }
      });
      expect(cancelled).toBe('REQUEST_CANCELLED'); await expect.poll(() => Boolean(held)).toBe(true);
      await page.evaluate(() => { window.__w20.fontLoadResult = window.__w20.api.loadCartographicFonts().then(() => null, (e: any) => ({ code: e.code, reason: e.details.reason })); });
      await held.fulfill({ status: 404, body: 'missing font' });
      const failed = await page.evaluate(() => window.__w20.fontLoadResult);
      expect(failed).toEqual({ code: 'IO_ERROR', reason: 'font-load-failed' });
      await page.unroute('**/DejaVuSans.ttf');
      expect(await page.evaluate(async () => (await new window.__w20.api.NorthArrow().render()).data.length)).toBe(76 * 76 * 4);
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
