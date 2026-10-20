import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCommandInvocation } from './command-executable.mjs';
import { verifyDocs } from '../../../scripts/verify-w23.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd = root) {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}
assert.equal(run('git', ['status', '--porcelain']).trim(), '', 'W23 installed gate requires a clean committed worktree');
for (const task of ['build:wasm', 'build:ts', 'prepare-dist', 'verify:w23', 'test:api']) {
  console.log(`W23 installed: ${task}`); run('npm', ['run', task]);
}
assert.equal(run('git', ['status', '--porcelain']).trim(), '', 'Generated declarations/evidence must be committed');
const temp = mkdtempSync(join(tmpdir(), 'forge3d-w23-consumer-')), consumer = join(temp, 'consumer'), pack = join(temp, 'pack');
mkdirSync(consumer); mkdirSync(pack);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const metadata = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', pack]))[0], tarball = join(pack, metadata.filename);
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
const installed = join(consumer, 'node_modules/@forge3d/web');
for (const path of ['examples/migration/index.html', 'examples/migration/workflows.js', 'examples/migration/catalog.json',
  'examples/migration/autzen.laz', 'examples/migration/predictor.tif', 'docs/migration.md', 'docs/features.md', 'docs/workflow-support.md',
  'docs/python-api-map.md', 'docs/native-documentation.md', 'docs/migration-coverage.json', 'docs/migration-assets.json', 'dist/forge3d_web_bg.wasm']) assert(existsSync(join(installed, path)), `Missing shipped migration resource ${path}`);
assert(!existsSync(join(installed, 'src-ts')), 'Consumer must not receive source implementations');
assert(!existsSync(join(installed, 'tests/fixtures/w22')), 'Gallery must not rely on repository fixtures');
const documentation = verifyDocs({ packageRoot: installed });
assert.deepEqual(documentation.errors, [], 'Installed documentation links/code blocks failed');
const inputs = JSON.parse(readFileSync(join(installed, 'docs/migration-assets.json'))).assets;
let migrationTextHeadBlobsVerified = 0;
for (const asset of inputs) {
  const path = join(installed, asset.path.slice('crates/forge3d-web/'.length));
  const raw = readFileSync(path), bytes = asset.hashMode === 'utf8-lf' ? Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n')) : raw;
  assert.equal(hash(bytes), asset.sha256, `Installed asset changed: ${asset.path}`);
  if (asset.path.startsWith('crates/forge3d-web/examples/migration/') && asset.hashMode === 'utf8-lf') {
    const head = spawnSync('git', ['show', `HEAD:${asset.path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(head.status, 0, `Missing migration HEAD blob: ${asset.path}`);
    assert.deepEqual(readFileSync(resolve(root, '../..', asset.path)), head.stdout, `Checkout migration bytes differ from HEAD: ${asset.path}`);
    assert.deepEqual(raw, head.stdout, `Shipped migration bytes differ from HEAD: ${asset.path}`);
    migrationTextHeadBlobsVerified++;
  }
}
const requests = [], server = createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    requests.push(pathname);
    if (!['/dist/', '/assets/', '/docs/', '/examples/migration/'].some(p => pathname.startsWith(p)) && pathname !== '/examples/example-license.js') { res.writeHead(404); res.end(); return; }
    const path = resolve(installed, '.' + pathname), rel = relative(installed, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Path escapes installed package');
    let bytes = readFileSync(path);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.md': 'text/plain' }[extname(path)] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
      'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'" };
    const match = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (req.headers.range && !match) { res.writeHead(416); res.end(); return; }
    if (match) {
      const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end || start >= bytes.length) { res.writeHead(416); res.end(); return; }
      headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`; bytes = bytes.subarray(start, end + 1);
      res.writeHead(206, { ...headers, 'content-length': bytes.length });
    } else res.writeHead(200, { ...headers, 'content-length': bytes.length });
    res.end(bytes);
  } catch { res.writeHead(404); res.end('Missing installed resource'); }
});
try {
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(temp, 'w23.config.mts'), output = join(root, 'test-results/w23-installed'); mkdirSync(output, { recursive: true });
  writeFileSync(configPath, `import config from ${JSON.stringify(pathToFileURL(join(root, 'playwright.config.ts')).href)};export default {...config,testDir:${JSON.stringify(join(root,'tests/playwright'))},testMatch:'w23_migration.spec.ts',webServer:undefined,outputDir:${JSON.stringify(join(output,'output'))},use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(output,'playwright.json'))}}]]};`);
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', configPath, '--project=chromium-preflight', '--grep', 'W23 dist', '--workers=1', '--max-failures=1'], { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', resolveExit);
  });
  assert(!requests.some(p => p.startsWith('/src-ts/') || p.startsWith('/tests/')), 'Installed gallery requested repository sources/fixtures');
  const report = { schemaVersion: 1, revision: run('git', ['rev-parse', 'HEAD']).trim(), verifiedAt: new Date().toISOString(),
    exitCode, packageSha256: hash(readFileSync(tarball)), wasmSha256: hash(readFileSync(join(installed, 'dist/forge3d_web_bg.wasm'))),
    installed, tarball, browserLane: 'chromium-preflight', assetsVerified: inputs.length, migrationTextHeadBlobsVerified, documents: documentation.documents,
    requests: [...new Set(requests)].sort(), sourceImplementationAvailable: false, strictCsp: true, rangeSupport: true };
  writeFileSync(join(output, 'consumer.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); assert.equal(exitCode, 0, 'Installed W23 workflows failed');
} finally { await new Promise(done => server.close(done)); }
