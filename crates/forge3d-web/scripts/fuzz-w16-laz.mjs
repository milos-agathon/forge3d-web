import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Run after npm run build:ts && npm run prepare-dist. Cases run one at a time.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
const seedPath = resolve(root, 'tests/fixtures/w16-security/laz-corpus-seed.json');
const seedBytes = readFileSync(seedPath), seed = JSON.parse(seedBytes);
const manifestBytes = readFileSync(resolve(root, 'tests/fixtures/w16/copc-ept-tiles-v1.json'));
const manifest = JSON.parse(manifestBytes);
const wasm = readFileSync(resolve(root, 'assets/laz/laz-perf.wasm'));
// Read the actual declared WASM linear-memory limit, rather than infer it from
// the package's decoded-output budget (which is a different allocation).
function wasmMemoryLimits(bytes) {
  let offset = 8;
  const leb = () => { let n = 0, s = 0, b; do { b = bytes[offset++]; n += (b & 127) * 2 ** s; s += 7; } while (b & 128); return n; };
  while (offset < bytes.length) {
    const section = bytes[offset++], length = leb(), end = offset + length;
    if (section === 5) {
      assert.equal(leb(), 1, 'Expected one codec memory');
      const flags = leb(), initialPages = leb();
      assert(flags & 1, 'Codec memory must have a declared maximum');
      return { initialBytes: initialPages * 65536, maximumBytes: leb() * 65536 };
    }
    offset = end;
  }
  throw Error('Codec has no defined memory');
}
const memoryLimits = wasmMemoryLimits(wasm);
let randomState = seed.seed >>> 0;
function random() { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; }
const corpus = [];
for (const [sourceIndex, source] of seed.sources.entries()) {
  const bytes = readFileSync(resolve(root, 'tests/fixtures/w16', source.file));
  const pinned = manifest.files.find(file => file.path === source.file);
  assert(pinned && hash(bytes) === pinned.sha256, 'Fuzz inputs must match the W00 real fixtures');
  let start = 0, length = bytes.length, count;
  if (source.kind === 'laz-chunk') {
    const headerSize = bytes.readUInt16LE(94);
    const hierarchyOffset = Number(bytes.readBigUInt64LE(headerSize + 54 + 40));
    const entry = hierarchyOffset + source.hierarchyEntry * 32;
    start = Number(bytes.readBigUInt64LE(entry + 16));
    length = bytes.readInt32LE(entry + 24); count = bytes.readInt32LE(entry + 28);
    assert(count > 0 && start >= 0 && length > 0 && start + length <= bytes.length);
  }
  const original = bytes.subarray(start, start + length);
  const expectedControl = sourceIndex === 0 ? manifest.overviewCopc.root
    : sourceIndex === 2 ? manifest.copcRoot : sourceIndex === 3 ? manifest.autzen : undefined;
  const recordLength = bytes.readUInt16LE(105), pointFormat = bytes[104] & 63;
  const layers = source.kind === 'laz-chunk' ? 9 + (pointFormat >= 7 ? 1 : 0) + (pointFormat === 8 ? 1 : 0) + recordLength - (pointFormat === 6 ? 30 : pointFormat === 7 ? 36 : 38) : 0;
  const streamStart = source.kind === 'laz-chunk' ? recordLength + 4 + 4 * layers : bytes.readUInt32LE(96);
  const add = (data, mutation, number) => corpus.push({ id: `${sourceIndex}-${number}`, source, sourceSha256: pinned.sha256,
    sourceRange: { start, length }, headerBytes: [...bytes.subarray(0, 375)], count,
    bytes: Buffer.from(data), sha256: hash(data), mutation,
    ...(mutation === 'valid real control' && expectedControl ? { expectedControl } : {}) });
  add(original, 'valid real control', 'control');
  for (let i = 0; i < seed.mutationsPerSource; i++) {
    let data = Buffer.from(original), mode = i % 6;
    if (mode === 0) data = data.subarray(0, random() % data.length);
    if (mode === 1 || mode === 2) {
      const offset = streamStart + random() % Math.max(1, data.length - streamStart);
      const size = Math.min(1 + random() % 32, data.length - offset);
      for (let j = 0; j < size; j++) {
        if (mode === 1) data[offset + j] ^= 1 << (random() % 8);
        else data[offset + j] = random() & 1 ? 255 : 0;
      }
    }
    if (mode === 3) {
      if (source.kind === 'laz-chunk') data.writeUInt32LE(random(), recordLength);
      else if (bytes[25] === 4) data.writeBigUInt64LE(BigInt(random()), 247);
      else data.writeUInt32LE(random(), 107);
    }
    if (mode === 4) {
      if (source.kind === 'laz-chunk') {
        const a = recordLength + 4 + 4 * (random() % layers), b = recordLength + 4 + 4 * (random() % layers);
        if (a !== b) { const sum = data.readUInt32LE(a) + data.readUInt32LE(b), first = random() % (sum + 1); data.writeUInt32LE(first, a); data.writeUInt32LE(sum - first, b); }
      } else { const offset = bytes.readUInt16LE(94) + random() % Math.max(1, streamStart - bytes.readUInt16LE(94)); data[offset] ^= 255; }
    }
    if (mode === 5) data = Buffer.concat([data, Buffer.from(Array.from({length: 1 + random() % 32}, () => random() & 255))]);
    add(data, seed.mutations[mode], i);
  }
}
const corpusSha256 = hash(Buffer.from(JSON.stringify(corpus.map(({bytes, headerBytes, ...entry}) => entry))));
const server = createServer((req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>W16 codec fuzz</title>'); return; }
    const path = resolve(root, '.' + name), rel = relative(root, path);
    assert(!rel.startsWith('..') && !isAbsolute(rel));
    res.writeHead(200, {'content-type': ({'.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm', '.json':'application/json'})[extname(path)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'"});
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async seed => {
    const api = await import('/dist/index.js');
    const state = window.__fuzz = { api, workers: [], created: 0, terminated: 0, peakWasmBytes: 0 };
    state.pool = new api.Forge3DWorkerPool({ size: 1, jobTimeoutMs: seed.deadlineMs,
      mainThreadHandler: api.createPointCloudWorkerHandler(), workerFactory: () => {
        const worker = new Worker('/scripts/w16-laz-fuzz-worker.mjs', {type:'module'}), channel = new MessageChannel();
        state.created++; state.workers.push(worker);
        worker.onmessage = ({data}) => { if (Number.isSafeInteger(data.fuzzMemoryBytes)) state.peakWasmBytes = Math.max(state.peakWasmBytes, data.fuzzMemoryBytes); };
        worker.postMessage({port:channel.port2}, [channel.port2]);
        return {port: channel.port1, terminate() {state.terminated++; worker.terminate();}};
      }});
  }, seed);
  const results = [];
  for (const entry of corpus) {
    const result = await page.evaluate(async ({entry, seed}) => {
      const state = window.__fuzz, {api, pool} = state;
      const header = api.parseLasHeader(new Uint8Array(entry.headerBytes));
      const request = {kind:entry.source.kind, bytes:new Uint8Array(entry.bytes), maxBytes:seed.maxDecodedBytes,
        ...(entry.count !== undefined ? {header,count:entry.count} : {})};
      const before = performance.now();
      try {
        const output = await pool.run(request, { timeoutMs:seed.deadlineMs, requireHardStop:true });
        const data = output.points, count = data.positions.length / 3;
        if (!Number.isInteger(count) || count < 0 || ![...data.positions].every(Number.isFinite) ||
          data.intensities?.length !== count || data.classifications?.length !== count ||
          (data.colors && data.colors.length !== count * 3)) throw Error('Invalid point output');
        if (entry.source.kind === 'laz-chunk' && count !== entry.count) throw Error('Chunk output count differs from pinned hierarchy');
        const outputBytes = Object.values(data).reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
        if (outputBytes > seed.maxDecodedBytes) throw Error('Output exceeded byte limit');
        let controlHashes;
        if (entry.expectedControl) {
          const digest = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', array.buffer)), byte => byte.toString(16).padStart(2,'0')).join('');
          controlHashes = { positionsSha256:await digest(data.positions), colorsSha256:await digest(data.colors) };
          if (count !== entry.expectedControl.count || controlHashes.positionsSha256 !== entry.expectedControl.positionsSha256 || controlHashes.colorsSha256 !== entry.expectedControl.colorsSha256)
            throw Error('Real control differs from independent fixture oracle');
        }
        return { outcome:'valid', count, outputBytes, ...(controlHashes ? {controlHashes}:{}), elapsedMs:performance.now()-before, peakWasmBytes:state.peakWasmBytes };
      } catch (error) {
        return {outcome: error instanceof api.Forge3DError ? 'typed-error' : 'untyped-error', code:error.code,
          message:String(error.message), elapsedMs:performance.now()-before, peakWasmBytes:state.peakWasmBytes};
      }
    }, {entry: {...entry, bytes:[...entry.bytes]}, seed});
    results.push({id:entry.id, source:entry.source, inputBytes:entry.bytes.length, inputSha256:entry.sha256, mutation:entry.mutation, ...result});
    if (results.length % 32 === 0) console.log(`W16 fuzz: ${results.length}/${corpus.length}`);
  }
  // Recovery must decode real data after all mutations, including terminated jobs.
  const recovery = await page.evaluate(async entry => {
    const state = window.__fuzz, header = state.api.parseLasHeader(new Uint8Array(entry.headerBytes));
    const output = await state.pool.run({kind:entry.source.kind, bytes:new Uint8Array(entry.bytes), header, count:entry.count, maxBytes:8388608}, {timeoutMs:1000, requireHardStop:true});
    await new Promise(resolve => setTimeout(resolve,0));
    const report = { count:output.points.positions.length / 3, created:state.created, terminated:state.terminated, diagnostics:state.pool.getDiagnostics() };
    state.pool.dispose(); return report;
  }, {...corpus[0], bytes:[...corpus[0].bytes]});
  const report = {schemaVersion:1, recordedAt:new Date().toISOString(), gitHead:process.env.FORGE3D_REVIEW_SHA ?? null,
    browser:browser.version(), platform:process.platform, seedSha256:hash(seedBytes), fixtureManifestSha256:hash(manifestBytes),
    codecWasmSha256:hash(wasm), scriptSha256:hash(readFileSync(fileURLToPath(import.meta.url))),
    workerSha256:hash(readFileSync(resolve(root,'scripts/w16-laz-fuzz-worker.mjs'))), corpusSha256, seed:seed.seed, cases:results.length, bounds:{deadlineMs:seed.deadlineMs,
      completionBoundMs:seed.completionBoundMs, maxDecodedBytes:seed.maxDecodedBytes, wasm:memoryLimits,
      note:'WASM high water observed at instantiate/grow; JS input/output limits are separate. Browser/process RSS is not attributed per job. Deadline termination bounds CPU residency; declared WASM maximum is not a smaller per-job heap cap.'},
    valid:results.filter(r=>r.outcome==='valid').length, typedErrors:results.filter(r=>r.outcome==='typed-error').length,
    maxElapsedMs:Math.max(...results.map(r=>r.elapsedMs)), peakObservedWasmBytes:Math.max(...results.map(r=>r.peakWasmBytes)), recovery, results};
  const out = resolve(root, process.env.FORGE3D_W16_FUZZ_REPORT ?? 'docs/w16-security/fuzz-report.json');
  mkdirSync(dirname(out), {recursive:true}); writeFileSync(out, JSON.stringify(report,null,2)+'\n');
  assert.equal(report.valid + report.typedErrors, report.cases, 'Every mutation must settle valid or with a Forge3DError');
  assert(report.maxElapsedMs <= seed.completionBoundMs, 'Case completion bound exceeded');
  assert(report.peakObservedWasmBytes <= memoryLimits.maximumBytes, 'Declared codec memory bound exceeded');
  for (const r of results.filter(r=>r.mutation==='valid real control')) assert.equal(r.outcome,'valid','Real controls must decode');
  assert.equal(recovery.count, corpus[0].count); assert.equal(recovery.diagnostics.active,0); assert.equal(recovery.diagnostics.queued,0);
  console.log(JSON.stringify({cases:report.cases,valid:report.valid,typedErrors:report.typedErrors,maxElapsedMs:report.maxElapsedMs,peakObservedWasmBytes:report.peakObservedWasmBytes,recovery},null,2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
