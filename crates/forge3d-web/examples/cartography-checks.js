export function makeCartographyChecks(api) {
  const { MapPlate, BBox, PlateRegion, Legend, ScaleBar, NorthArrow, Colormap, colormaps } = api;
  const assert = (value, message) => { if (!value) throw Error(message); };
  const pixels = (w = 100, h = 100, channels = 4, rgb = [200, 0, 0, 255]) => ({ width: w, height: h, channels, data: Uint8Array.from({ length: w * h * channels }, (_, i) => rgb[i % channels]) });
  const sample = () => new Colormap('sample', Float32Array.from({ length: 1024 }, (_, i) => i % 4 === 0 ? Math.floor(i / 4) / 255 : i % 4 === 1 ? .5 : i % 4 === 2 ? 1 - Math.floor(i / 4) / 255 : 1));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function nativePlateCase(cls, test) {
    const id = cls + '::' + test;
    switch (id) {
      case 'TestBBox::test_bbox_properties': { const b = new BBox(-122, 46, -121, 47); assert(equal([b.width, b.height, b.centerLat], [1, 1, 46.5]), id); break; }
      case 'TestBBox::test_bbox_immutable': { const b = new BBox(0, 0, 1, 1); let failed = false; try { b.west = 10; } catch { failed = true; } assert(failed && b.west === 0, id); break; }
      case 'TestPlateRegion::test_region_dimensions': { const r = new PlateRegion(10, 20, 110, 220); assert(equal([r.width, r.height, r.rect], [100, 200, [10, 20, 110, 220]]), id); break; }
      case 'TestMapPlateConfig::test_default_config': { const p = new MapPlate(); assert(equal([p.config.width, p.config.height, p.config.margin, p.config.background], [1600, 1000, [60, 200, 80, 40], [1, 1, 1, 1]]), id); p.dispose(); break; }
      case 'TestMapPlateConfig::test_custom_config': { const p = new MapPlate({ width: 800, height: 600, margin: [10, 10, 10, 10] }); assert(p.config.width === 800 && p.config.height === 600, id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_plate_dimensions': { const p = new MapPlate({ width: 800, height: 600 }), f = await p.compose(); assert(f.width === 800 && f.height === 600 && f.data.length === 800 * 600 * 4, id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_default_background_white': { const p = new MapPlate({ width: 100, height: 100 }); assert(equal((await p.compose()).pixel(50, 50), [255, 255, 255, 255]), id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_custom_background': { const p = new MapPlate({ width: 100, height: 100, background: [128 / 255, 64 / 255, 32 / 255, 1] }); assert(equal((await p.compose()).pixel(50, 50), [128, 64, 32, 255]), id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_map_region_blitted': { const p = new MapPlate({ width: 200, height: 200, margin: [20, 20, 20, 20] }); p.setMapRegion(pixels(), new BBox(0, 0, 1, 1)); assert((await p.compose()).pixel(100, 100)[0] === 200, id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_rgb_image_converted_to_rgba': { const p = new MapPlate({ width: 100, height: 100, margin: [10, 10, 10, 10] }); p.setMapRegion(pixels(50, 50, 3, [0, 128, 0]), new BBox(0, 0, 1, 1)); assert(equal((await p.compose()).pixel(50, 50), [0, 128, 0, 255]), id); p.dispose(); break; }
      case 'TestMapPlateLayout::test_grayscale_image_converted_to_rgba': { const p = new MapPlate({ width: 100, height: 100, margin: [10, 10, 10, 10] }); p.setMapRegion(pixels(50, 50, 1, [100]), new BBox(0, 0, 1, 1)); assert(equal((await p.compose()).pixel(50, 50), [100, 100, 100, 255]), id); p.dispose(); break; }
      case 'TestMapPlateTitle::test_add_title': { const p = new MapPlate({ width: 400, height: 300 }); p.addTitle('Test Title', { fontSize: 20 }); const f = await p.compose(); assert(f.data.some((v, i) => i % 4 !== 3 && v < 100) && (await p.layout()).elements[0].kind === 'title', id); p.dispose(); break; }
      case 'TestMapPlateExport::test_export_png': case 'TestMapPlateExport::test_export_jpeg': { const p = new MapPlate({ width: 200, height: 150 }), blob = test.endsWith('png') ? await p.exportPng() : await p.exportJpeg(), b = await createImageBitmap(blob); assert(b.width === 200 && b.height === 150 && blob.type === (test.endsWith('png') ? 'image/png' : 'image/jpeg'), id); b.close(); p.dispose(); break; }
      case 'TestLegendConfig::test_default_config': { const c = new Legend(sample(), [0, 1]).config; assert(c.orientation === 'vertical' && c.tickCount === 5 && c.barHeight === 250, id); break; }
      case 'TestLegendConfig::test_custom_config': { const c = new Legend(sample(), [0, 1], { orientation: 'horizontal', tickCount: 10, barHeight: 100 }).config; assert(c.orientation === 'horizontal' && c.tickCount === 10, id); break; }
      case 'TestLegendGeneration::test_legend_ticks_count': assert(new Legend(sample(), [0, 1000]).getTicks().length === 5, id); break;
      case 'TestLegendGeneration::test_legend_ticks_values': assert(equal(new Legend(sample(), [0, 4000]).getTicks().map(v => v[0]), [0, 1000, 2000, 3000, 4000]), id); break;
      case 'TestLegendGeneration::test_legend_ticks_labels': assert(equal(new Legend(sample(), [0, 1000], { tickCount: 3, labelFormat: '{:.1f}' }).getTicks().map(v => v[1]), ['0.0 m', '500.0 m', '1000.0 m']), id); break;
      case 'TestLegendGeneration::test_legend_render_shape': { const f = await new Legend(sample(), [0, 1000], { barHeight: 200, barWidth: 20 }).render(); assert(f.data instanceof Uint8Array && f.data.length === f.width * f.height * 4, id); break; }
      case 'TestLegendGeneration::test_legend_render_vertical': { const f = await new Legend(sample(), [0, 100], { barHeight: 100, barWidth: 15 }).render(); assert(f.height >= 100, id); break; }
      case 'TestLegendGeneration::test_legend_render_horizontal': { const f = await new Legend(sample(), [0, 100], { orientation: 'horizontal', barHeight: 100, barWidth: 15 }).render(); assert(f.width >= 100 && f.width > f.height, id); break; }
      case 'TestLegendGeneration::test_legend_gradient_converts_linear_rgb_to_display_srgb': { const f = new Legend(new Float32Array([.25, .25, .25, 1, .25, .25, .25, 1]), [0, 1], { barWidth: 1, barHeight: 4 }).gradient(); assert(equal(f.pixel(0, 0), [137, 137, 137, 255]), id); break; }
      case 'TestScaleBarConfig::test_default_config': { const c = new ScaleBar(100).config; assert(c.units === 'km' && c.style === 'alternating' && c.divisions === 4, id); break; }
      case 'TestScaleBarConfig::test_custom_units': assert(new ScaleBar(100, { units: 'mi' }).config.units === 'mi', id); break;
      case 'TestScaleBarGeodetic::test_meters_per_pixel_equator': { const m = ScaleBar.computeMetersPerPixel(new BBox(0, 0, 1, 1), 1000); assert(m > 100 && m < 120, id); break; }
      case 'TestScaleBarGeodetic::test_meters_per_pixel_mid_latitude': { const m = ScaleBar.computeMetersPerPixel(new BBox(0, 45, 1, 46), 1000); assert(m > 70 && m < 90, id); break; }
      case 'TestScaleBarGeodetic::test_meters_per_pixel_high_latitude': { const m = ScaleBar.computeMetersPerPixel(new BBox(0, 70, 1, 71), 1000); assert(m > 30 && m < 50, id); break; }
      case 'TestScaleBarGeodetic::test_meters_per_pixel_scales_with_width': { const b = new BBox(0, 0, 1, 1); assert(ScaleBar.computeMetersPerPixel(b, 1000) === ScaleBar.computeMetersPerPixel(b, 2000) * 2, id); break; }
      case 'TestScaleBarRender::test_scale_bar_renders': case 'TestScaleBarRender::test_scale_bar_simple_style': case 'TestScaleBarRender::test_scale_bar_different_units': { for (const units of test.endsWith('units') ? ['m', 'km', 'mi', 'ft'] : ['km']) { const f = await new ScaleBar(100, { units, style: test.endsWith('style') ? 'simple' : 'alternating' }).render(); assert(f.width > 0 && f.height > 0 && f.data.length === f.width * f.height * 4, id); } break; }
      case 'TestMapPlateIntegration::test_full_plate_composition': { const p = new MapPlate({ width: 800, height: 600, margin: [50, 150, 50, 30] }), b = new BBox(-122, 46, -121, 47); p.setMapRegion(pixels(500, 400, 4, [0, 128, 0, 255]), b).addTitle('Integration Test Map').addLegend(await new Legend(sample(), [0, 1000], { barHeight: 200 }).render()).addScaleBar(await new ScaleBar(ScaleBar.computeMetersPerPixel(b, 500)).render()); const frame = await p.compose(); assert(frame.width === 800 && frame.height === 600 && frame.pixel(300, 300)[1] === 128 && (await p.exportPng()).size > 100, id); p.dispose(); break; }
      default: throw Error('Unported native test: ' + id);
    }
    return true;
  }
  async function makePlate() {
    const p = new MapPlate({ width: 480, height: 320, margin: [45, 120, 35, 20] });
    p.setMapRegion(pixels(120, 80, 4, [40, 130, 80, 255]), new BBox(-122, 46, -121, 47)).addTitle('Mountain atlas', { fontSize: 20 });
    p.addLegend(await new Legend(colormaps.get('forge3d:viridis'), [0, 3000], { barHeight: 140, fontSize: 10, labelSuffix: ' m' }).render());
    p.addScaleBar(await new ScaleBar(200, { widthPx: 140, fontSize: 10 }).render());
    p.addNorthArrow(await new NorthArrow({ size: 40, rotationDeg: 30, fontSize: 10 }).render());
    p.addInset(pixels(30, 20, 4, [25, 50, 150, 255]), { size: [60, 40] });
    return p;
  }
  async function vectorExports() {
    const s = new api.VectorScene().addPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], { holes: [[[25, 25], [75, 25], [75, 75], [25, 75]]], fillColor: [1, 0, 0, 1], strokeWidth: 0 });
    s.addPolyline([[0, 50], [100, 50]], { strokeColor: [0, 0, 1, 1], strokeWidth: 2 }).addLabel('Montaña & Peak', [50, 85], { fontSize: 12, haloWidth: 1 });
    const options = { width: 200, height: 100, dpi: 96, bounds: new api.Bounds(), background: [1, 1, 1, 1] }, svg = await api.exportSvg(s, options), pdf = await api.exportPdf(s, options); s.dispose(); return { svg, pdf };
  }
  return { nativePlateCase, makePlate, vectorExports, pixels };
}
