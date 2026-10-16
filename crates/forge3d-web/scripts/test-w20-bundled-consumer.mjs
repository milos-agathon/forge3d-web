import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from '@playwright/test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), installed = resolve(process.argv[2] ?? root);
const temp = mkdtempSync(join(tmpdir(), 'forge3d-w20-bundled-')), output = join(temp, 'www');
const packageModule = JSON.stringify(join(installed, 'dist/index.js').replaceAll('\\', '/'));
const workflows = `async function workflows(){const errors=[],types=[];const run=async(name,fn)=>{try{types.push([name,await fn()])}catch(e){errors.push({name,code:e.code,message:e.message})}};
await run('legend',async()=>{const f=await new api.Legend(api.colormaps.get('forge3d:viridis'),[0,1000]).render();return f.width>0&&f.height>0});
await run('title',async()=>{const p=new api.MapPlate({width:320,height:200});try{p.addTitle('Bundled map');return(await p.exportPng()).type}finally{p.dispose()}});
await run('svg',async()=>{const s=new api.VectorScene().addLabel('Montaña',[0,0]);try{return(await api.exportSvg(s)).type}finally{s.dispose()}});
await run('pdf',async()=>{const s=new api.VectorScene().addLabel('Montaña',[0,0]);try{return(await api.exportPdf(s)).type}finally{s.dispose()}});
for(const [language,text] of [['arabic','مرحبا بالعالم'],['devanagari','नमस्ते']])for(const [format,exporter] of [['svg',api.exportSvg],['pdf',api.exportPdf]])await run(format+'-'+language,async()=>{const s=new api.VectorScene().addLabel(text,[0,0]);try{return(await exporter(s)).type}finally{s.dispose()}});
return {errors,types}}`;
const main = `import * as api from ${packageModule};${workflows}
window.result=(async()=>{const main=await workflows();const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});try{const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timeout')),30000);worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))}});return {main,worker:result}}finally{worker.terminate()}})();`;
const worker = `import * as api from ${packageModule};${workflows}workflows().then(result=>self.postMessage(result));`;
writeFileSync(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="./main.js"></script>');
writeFileSync(join(temp, 'main.js'), main); writeFileSync(join(temp, 'worker.js'), worker);
const report = [];
const browser = await chromium.launch();
try {
  for (const mode of ['bundled-root', 'bundled-subpath', 'cdn-subpath']) {
    const base = mode === 'bundled-subpath' ? '/atlas/' : '/', cdn = '/cdn/@forge3d/web@1.26.3/';
    if (mode !== 'cdn-subpath') await build({ configFile: false, root: temp, base, publicDir: false, worker: { format: 'es' }, logLevel: 'silent', build: { outDir: output, assetsInlineLimit: 0, minify: true } });
    const requests = [], server = createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); let bytes, extension;
        if (mode === 'cdn-subpath' && ['/', '/main.js', '/worker.js'].includes(pathname)) {
          bytes = Buffer.from(pathname === '/' ? readFileSync(join(temp, 'index.html')) : (pathname === '/main.js' ? main : worker).replace(packageModule, JSON.stringify(cdn + 'dist/index.js'))); extension = pathname === '/' ? '.html' : '.js';
        } else {
          const originRoot = mode === 'cdn-subpath' ? installed : output, prefix = mode === 'cdn-subpath' ? cdn : base;
          if (!pathname.startsWith(prefix)) throw Error('outside served prefix');
          const suffix = pathname.slice(prefix.length) || 'index.html', path = resolve(originRoot, suffix), rel = relative(originRoot, path);
          if (isAbsolute(rel) || rel.startsWith('..')) throw Error('outside consumer');
          bytes = readFileSync(path); extension = extname(path);
        }
        requests.push({ path: pathname, status: 200 });
        res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }[extension] ?? 'application/octet-stream' }); res.end(bytes);
      } catch { requests.push({ path: req.url, status: 404 }); res.writeHead(404); res.end(); }
    });
    let page;
    try {
      await new Promise(r => server.listen(0, '127.0.0.1', r)); page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}${base}`); const result = await page.evaluate(() => window.result);
      for (const context of ['main', 'worker']) {
        assert.deepEqual(result[context].errors, [], mode + ':' + context + ':' + JSON.stringify(result));
        assert.deepEqual(result[context].types, [['legend', true], ['title', 'image/png'], ['svg', 'image/svg+xml'], ['pdf', 'application/pdf'], ['svg-arabic','image/svg+xml'], ['pdf-arabic','application/pdf'], ['svg-devanagari','image/svg+xml'], ['pdf-devanagari','application/pdf']]);
      }
      assert(requests.some(r => /\.ttf$/.test(r.path) && r.status === 200), 'consumer must request real font assets');
      assert(!requests.some(r => r.status === 404 && !r.path.includes('favicon')), JSON.stringify(requests.filter(r => r.status === 404)));
      report.push({ mode, result, requests });
    } finally { await page?.close(); await new Promise(r => server.close(r)); }
  }
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(join(root, 'test-results/w20-bundled-consumer.json'), JSON.stringify({ installed, report }, null, 2) + '\n');
  console.log('W20 bundled root/subpath and CDN-style subpath: 48 main/worker workflows passed');
} finally { await browser.close(); }
