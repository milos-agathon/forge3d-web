// Run from the repository root after committing the implementation.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), packageRoot = join(root, 'crates/forge3d-web');
const output = join(packageRoot, 'test-results'), prefix = 'w23-review3-';
mkdirSync(output, { recursive: true });
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git(['status', '--porcelain']), '', 'Commit the implementation before verification');
const record = { revision: git(['rev-parse', 'HEAD']), environment: { CARGO_TARGET_DIR: 'C:\\devin-target\\forge3d-web' }, browserEnvironment: { FORGE3D_TEST_PORT: '57923' }, commands: [] };
const tasks = [
  ['verify', 'npm', ['run', 'verify:w23']], ['parity', 'npm', ['run', 'verify:parity']],
  ['api', 'npm', ['run', 'test:api']],
  ...[1, 2, 3].map(n => [`unit-${n}`, 'npm', ['run', 'test:unit']]),
  ['example-build', 'npm', ['run', 'build:example']], ['package', 'npm', ['run', 'test:package']],
  ['browser', 'npm', ['run', 'test:w23', '--', '--reporter=list,json', '--output=test-results/w23-review3-browser-output']],
  ['installed', 'npm', ['run', 'test:package-consumer:w23']],
  ['single-tile-oracle', 'python', ['scripts/generate-w23-goldens.py', '--check']],
  ['regional-oracle', 'python', ['scripts/generate-w23-application-fixtures.py', '--check']],
  ['native-audit', 'python', ['scripts/audit-w23-native.py'], root],
  ['semantic-audit', 'node', ['scripts/audit-w23-semantics.mjs'], root],
];
for (const [name, command, args, cwd = packageRoot] of tasks) {
  assert.equal(git(['status', '--porcelain']), '', `Tree became dirty before ${name}`);
  const log = join(output, prefix + name + '.log'), stream = createWriteStream(log);
  const entry = { name, command: [command, ...args].join(' '), cwd, startedAt: new Date().toISOString() };
  console.log(`W23 verification: ${entry.command}`);
  const executable = command === 'npm' ? process.execPath : command;
  const arguments_ = command === 'npm' ? [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : args;
  const env = { ...process.env, ...record.environment, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.FORGE3D_TEST_PORT;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  if (name === 'browser') Object.assign(env, record.browserEnvironment, { PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, prefix + 'browser.json') });
  const child = spawn(executable, arguments_, { cwd, env });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  entry.exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  await new Promise(done => stream.end(done));
  entry.finishedAt = new Date().toISOString(); entry.log = 'crates/forge3d-web/test-results/' + prefix + name + '.log';
  entry.sha256 = createHash('sha256').update(readFileSync(log)).digest('hex');
  record.commands.push(entry); writeFileSync(join(output, prefix + 'commands.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`${name}: exit ${entry.exitCode}; ${entry.sha256}`);
  assert.equal(entry.exitCode, 0, `Failed ${entry.command}; see ${entry.log}`);
}
assert.equal(git(['status', '--porcelain']), '', 'Verification must preserve the committed tree');
