import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCommandInvocation } from './command-executable.mjs';
import { verifyDocs } from '../../../scripts/verify-w23.mjs';
import { attachInstalledSuite } from './installed-artifact.mjs';
import { installedRun } from './installed-run.mjs';
import { installedFixtureHandler } from './fixture-http.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd = root) {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stdout + result.stderr);
  return result.stdout;
}
const output = join(root, 'test-results/w23-installed');
const report = await installedRun({ suite: 'w23', destination: join(output, 'consumer.json') }, async evidence => {
  const temp = mkdtempSync(join(tmpdir(), 'forge3d-w23-consumer-')), consumer = join(temp, 'consumer');
  const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: 'w23' });
  evidence.artifact(artifact);
  for (const task of ['verify:w23', 'test:api']) {
    console.log(`W23 installed: ${task}`); run('npm', ['run', task]);
  }
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
  evidence.observe({ browserLane: 'chromium-preflight', assetsVerified: inputs.length, migrationTextHeadBlobsVerified,
    documents: documentation.documents, sourceImplementationAvailable: false, strictCsp: true, rangeSupport: true });
  const requests = [], server = createServer(installedFixtureHandler({
    route(pathname) {
      requests.push(pathname);
      if (!['/dist/', '/assets/', '/docs/', '/examples/migration/'].some(p => pathname.startsWith(p)) && pathname !== '/examples/example-license.js') return null;
      return { root: installed };
    },
    headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
      'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'" },
  }));
  try {
    evidence.phase('browser');
    await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const configPath = join(temp, 'w23.config.mts');
    writeFileSync(configPath, `import config from ${JSON.stringify(pathToFileURL(join(root, 'playwright.config.ts')).href)};export default {...config,testDir:${JSON.stringify(join(root,'tests/playwright'))},testMatch:'w23_migration.spec.ts',webServer:undefined,outputDir:${JSON.stringify(join(output,'output'))},use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(output,'playwright.json'))}}]]};`);
    const exitCode = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', configPath, '--project=chromium-preflight', '--grep', 'W23 dist', '--workers=1', '--max-failures=1'], { cwd: root, stdio: 'inherit' });
      child.on('error', reject); child.on('exit', resolveExit);
    });
    evidence.observe({ exitCode, requests: [...new Set(requests)].sort() });
    assert(!requests.some(p => p.startsWith('/src-ts/') || p.startsWith('/tests/')), 'Installed gallery requested repository sources/fixtures');
    assert.equal(exitCode, 0, 'Installed W23 workflows failed');
  } finally { await new Promise(done => server.close(done)); }
});
console.log(JSON.stringify(report, null, 2));
