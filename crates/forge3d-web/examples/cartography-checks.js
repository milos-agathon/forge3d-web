export function makeCartographyChecks(api) {
  const { MapPlate, BBox, PlateRegion, Legend, ScaleBar, NorthArrow, Colormap, colormaps } = api;
  const pixels = (w = 100, h = 100, channels = 4, rgb = [200, 0, 0, 255]) => ({ width: w, height: h, channels, data: Uint8Array.from({ length: w * h * channels }, (_, i) => rgb[i % channels]) });
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
  return { makePlate, vectorExports, pixels };
}
