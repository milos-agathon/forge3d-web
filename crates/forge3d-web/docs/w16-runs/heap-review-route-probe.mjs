import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { chromium, firefox } = (await import(pathToFileURL(resolve(root, 'node_modules/@playwright/test/index.js')).href)).default;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') { res.end('<!doctype html><title>Worker route diagnostic</title>'); return; }
  try {
    res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.wasm' ? 'application/wasm' : 'application/octet-stream');
    res.end(readFileSync(resolve(root, '.' + path)));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [engine, launcher] of [['chromium', chromium], ['firefox', firefox]]) {
    for (const surface of ['page', 'context']) {
      const browser = await launcher.launch();
      try {
        const context = await browser.newContext(), page = await context.newPage();
        let hits = 0;
        await (surface === 'page' ? page : context).route('**/assets/laz/laz-perf.js', async route => {
          hits++;
          const response = await route.fetch();
          const source = await response.text();
          await route.fulfill({ response, body: source.replace('export default createLazPerf;', `export default async function(o) {
            const module = await createLazPerf(o); self.postMessage({state:'native-heap-created'}); return module;
          }`) });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async () => {
          const api = await import('/dist/index.js');
          const bytes = new Uint8Array(await (await fetch('/tests/fixtures/w16/autzen_trim.laz')).arrayBuffer());
          let telemetry = 0;
          const pool = new api.Forge3DWorkerPool({size:1, mainThreadHandler:api.createPointCloudWorkerHandler(), workerFactory: () => {
            const worker = new Worker('/examples/test-w16-stuck-worker.js?dist', {type:'module'}), channel = new MessageChannel();
            worker.onmessage = ({data}) => { if(data.state==='native-heap-created') telemetry++; };
            worker.postMessage({port:channel.port2}, [channel.port2]);
            return {port:channel.port1, terminate:()=>worker.terminate()};
          }});
          try {
            const points = await pool.run({kind:'laz-file',bytes},{requireHardStop:true,timeoutMs:10000});
            await new Promise(resolve=>setTimeout(resolve,1000));
            return {count:points.positions.length/3,telemetry};
          } finally { pool.dispose(); }
        });
        console.log(JSON.stringify({engine, surface, hits, ...result}));
      } finally { await browser.close(); }
    }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
