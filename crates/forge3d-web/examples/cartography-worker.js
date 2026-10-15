import { makeCartographyChecks } from './cartography-checks.js';
const apiReady = (new URLSearchParams(location.search).has('source') ? import('../src-ts/index.ts') : import('../dist/index.js'));
onmessage = async () => {
  let plate;
  try { const api = await apiReady; plate = await makeCartographyChecks(api).makePlate(); const frame = await plate.compose(), png = await plate.exportPng(), vectors = await makeCartographyChecks(api).vectorExports(); const data = frame.toRgba8(); postMessage({ width: frame.width, height: frame.height, data, png, ...vectors }, [data.buffer]); }
  catch (e) { postMessage({ error: String(e), stack: e.stack }); }
  finally { plate?.dispose(); }
};
