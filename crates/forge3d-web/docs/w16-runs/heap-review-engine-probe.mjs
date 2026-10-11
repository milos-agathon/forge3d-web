import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
// Run from the web package root; an optional argument saves the proof JSON.
const root = process.cwd();
const outputPath = process.argv[2];
const { firefox, chromium } = (await import(pathToFileURL(resolve(root, 'node_modules/@playwright/test/index.js')).href)).default;
const { createServer } = await import(pathToFileURL(resolve(root, 'node_modules/vite/dist/node/index.js')).href);
const server = await createServer({ root, configFile: false, logLevel: 'warn', server: { host: '127.0.0.1', port: 0, strictPort: true } });
await server.listen();
const proofs = [];
try {
  for (const [engine, launcher] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/examples/test-clear.html`);
      for (const dist of [false, true]) {
        const proof = await page.evaluate(async dist => {
          const api = await (dist ? import('/dist/index.js') : import('/src-ts/index.ts'));
          const bytes = new Uint8Array(await (await fetch('/tests/fixtures/w16/autzen_trim.laz')).arrayBuffer());
          const expected = (await (await fetch('/tests/fixtures/w16/copc-ept-tiles-v1.json')).json()).autzen;
          const digest = async array => [...new Uint8Array(await crypto.subtle.digest('SHA-256', array.buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');
          const runs = [];
          for (const cached of [false, true]) {
            let created = 0;
            const pool = new api.Forge3DWorkerPool({ size: 1, mainThreadHandler: api.createPointCloudWorkerHandler(), workerFactory: () => {
              created++;
              const worker = new Worker('/examples/test-w16-heap-worker.js?' + (dist?'dist&':'') + (cached?'cached':''), {type:'module'});
              const channel = new MessageChannel(); worker.postMessage({port:channel.port2}, [channel.port2]);
              return {port:channel.port1,terminate:()=>worker.terminate()};
            }});
            try {
              const outputs = [];
              for (let i=0;i<2;i++) {
                const dataset = await api.openLaz(bytes,{workerPool:pool});
                try { const data=await dataset.readPoints('0-0-0-0'); outputs.push({count:dataset.totalPoints,positions:await digest(data.positions),colors:await digest(data.colors)}); }
                finally { dataset.dispose(); }
              }
              const heaps = await pool.run({kind:'test-heap-observations'}, {timeoutMs:1000,requireHardStop:true});
              runs.push({cached,created,heaps,outputs});
            } finally { pool.dispose(); }
          }
          const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
          return {runs,expected,webGpuAdapterAvailable:!!adapter};
        },dist);
        const fresh = run => run.heaps.length===2 && run.heaps[0].module!==run.heaps[1].module && run.heaps[0].memory!==run.heaps[1].memory && run.heaps[0].buffer!==run.heaps[1].buffer;
        for (const run of proof.runs) {
          assert.equal(run.created,1); assert.equal(run.heaps.length,2);
          for(const out of run.outputs) assert.deepEqual(out,{count:proof.expected.count,positions:proof.expected.positionsSha256,colors:proof.expected.colorsSha256});
        }
        assert(fresh(proof.runs[0])); assert(!fresh(proof.runs[1]));
        assert.deepEqual(proof.runs[1].heaps[0],proof.runs[1].heaps[1]);
        proofs.push({engine,mode:dist?'dist':'source',positiveFresh:true,cachedControlFresh:false,...proof});
        console.log(JSON.stringify(proofs.at(-1)));
        if (outputPath) writeFileSync(outputPath,JSON.stringify(proofs,null,2)+'\n');
      }
    } finally {await browser.close();}
  }
} finally {await server.close();}
