const api = location.search.includes('source') ? await import('/src-ts/index.ts') : await import('../dist/index.js');
const registry = new api.CodecRegistry();
const status = document.querySelector('#status');
window.__w22 = { api, registry, ready: false };
// Keep the first canvas available for WebGPU callers of the example.
async function run() {
  const bytes = new Uint8Array([...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),128,64,32,129]);
  const decoded = await registry.decode('hdr', bytes);
  const replayed = await registry.replay(decoded.cacheKey, { format:'hdr' });
  const report = { capabilities:registry.capabilities(), decodedPixel:[...decoded.value.data], replayedPixel:[...replayed.value.data], cacheKey:decoded.cacheKey };
  let runtime;
  try {
    runtime = await api.Forge3DRuntime.create(document.querySelector('canvas'), { width:96,height:64,devicePixelRatio:1 });
    const frame = new api.HdrFrame(1,1,decoded.value.data);
    const guides = new api.AovFrame({width:1,height:1,near:0.1,far:10,albedo:new Float32Array([1,0.5,0.25]),normal:new Float32Array([0,1,0])});
    const denoised = await registry.denoise(runtime,frame,guides);
    report.denoisedPixel = [...denoised.data];
  } catch (error) {
    report.denoiseUnavailable = {code:error.code,message:error.message};
  } finally { runtime?.dispose(); }
  status.textContent = JSON.stringify(report,null,2);
  window.__w22.demo = report;
}
try { await run(); } catch(error) { status.textContent = `${error.code ?? 'ERROR'}: ${error.message}`;window.__w22.error=String(error); }
window.__w22.ready = true;
addEventListener('pagehide', () => { void registry.dispose(); }, { once:true });
