import { readFileSync } from 'node:fs';

/** URL inputs make reads observable when a product gate is moved after IO. */
export function productUrlGateCases(api: any): [string, () => unknown][] {
  const url = 'https://example.invalid/w21-gated-source';
  const style = api.parseStyle({ version: 8, sources: { gated: { type: 'geojson', data: url } }, layers: [] });
  return [
    ['loadBuildings(URL)', () => api.loadBuildings(url)],
    ['loadBuildingTilesMetadata(URL)', () => api.loadBuildingTilesMetadata(url)],
    ['loadStyle(URL)', () => api.loadStyle(url)],
    ['loadStyleLayers(URL)', () => api.loadStyleLayers(style)],
    ['loadBundle(URL)', () => api.loadBundle(url)],
  ];
}

/** Every currently integrated product gate, with valid in-memory inputs. */
export function productGateCases(api: any): [string, () => unknown][] {
  const geojson = { type: 'FeatureCollection', features: [] };
  const cityjson = { type: 'CityJSON', version: '1.1', CityObjects: {}, vertices: [] };
  const style = api.parseStyle({ version: 8, layers: [] });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const bundle = new Uint8Array(readFileSync(new URL('../fixtures/w19/native-v2.forge3d', import.meta.url)));
  return [
    ['loadBuildings(GeoJSON)', () => api.loadBuildings(bytes(geojson))],
    ['loadBuildings(CityJSON)', () => api.loadBuildings(bytes(cityjson), { format: 'cityjson' })],
    ['parseGeoJsonBuildings', () => api.parseGeoJsonBuildings(geojson)],
    ['parseCityJsonBuildings', () => api.parseCityJsonBuildings(cityjson)],
    ['loadBuildingTilesMetadata', () => api.loadBuildingTilesMetadata(bytes({ root: {} }))],
    ['loadStyle', () => api.loadStyle(bytes({ version: 8, layers: [] }))],
    ['compileStyle', () => api.compileStyle(style, {})],
    ['loadStyleLayers', () => api.loadStyleLayers(style)],
    ['saveBundle', () => api.saveBundle({ base: { crs: 'LOCAL', camera: { kind: 'orbit-camera', target: [0, 0, 0], distance: 10 }, output: { width: 8, height: 8 }, layers: [] } })],
    ['loadBundle', () => api.loadBundle(bundle)],
  ];
}
