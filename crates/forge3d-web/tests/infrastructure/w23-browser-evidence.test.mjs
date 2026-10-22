import assert from 'node:assert/strict';
import test from 'node:test';
import { collectW23BrowserLanes } from '../../../../scripts/w23-browser-evidence.mjs';

const titles = [
  'all 54 migrated example workflows execute',
  'guide examples and contribution controls reject missing execution',
  'interactive viewers render input and release retained owners',
  'integrity and independent observers reject substituted workflows',
];
const evidence = [
  ['w23-workflows.json', 'w23-independent-stage-observations.json'],
  ['w23-negative-controls.json'], [], ['w23-literal-stage-negative-controls.json'],
];
function report(lanes = ['source', 'dist']) {
  return {
    errors: [], stats: {expected: lanes.length * 4, unexpected: 0, skipped: 0, flaky: 0},
    suites: [{suites: [{specs: lanes.flatMap(lane => titles.map((title, index) => ({
      title: `W23 ${lane}: ${title}`, file: 'w23_migration.spec.ts', ok: true,
      tests: [{projectId: 'chromium-preflight', projectName: 'chromium-preflight', expectedStatus: 'passed', status: 'expected', results: [{
        status: 'passed', retry: 0, duration: index + 1, errors: [],
        attachments: [
          {name: 'webgpu-availability.json', contentType: 'application/json', body: Buffer.from('{}').toString('base64')},
          ...evidence[index].map(name => ({name, contentType: 'application/json', body: Buffer.from(JSON.stringify({lane, name})).toString('base64')})),
        ],
      }]}],
    })))}]}],
  };
}
const specs = value => value.suites[0].suites[0].specs;
const result = spec => spec.tests[0].results[0];

test('complete source/dist reports aggregate four passed cases and preserve evidence per lane', () => {
  const lanes = collectW23BrowserLanes(report(), ['source', 'dist']);
  assert.equal(lanes.length, 2);
  for (const [index, lane] of lanes.entries()) {
    assert.equal(lane.title, `W23 ${['source', 'dist'][index]}: ${titles[0]}`);
    assert.equal(lane.status, 'passed');
    assert.equal(lane.duration, 10);
    assert.equal(lane.attachments.length, 8);
    assert.equal(new Set(lane.attachments.map(a => a.name)).size, 8);
    for (const name of evidence.flat()) {
      const attachment = lane.attachments.find(a => a.name === name);
      assert.equal(JSON.parse(Buffer.from(attachment.body, 'base64')).lane, ['source', 'dist'][index]);
    }
  }
});

test('installed dist report requires its complete four-case lane', () => {
  assert.equal(collectW23BrowserLanes(report(['dist']), ['dist']).length, 1);
  assert.throws(() => collectW23BrowserLanes(report(['dist']), ['source']), /Missing W23 case/);
});

test('missing, extra, duplicate and mixed-lane cases fail closed', () => {
  const mutations = [
    value => specs(value).pop(),
    value => specs(value).push(structuredClone(specs(value)[0])),
    value => { specs(value)[1].title = specs(value)[0].title; },
    value => { specs(value)[1].title = `W23 dist: ${titles[1]}`; },
    value => { specs(value)[1].title = 'unexpected W23 case'; },
  ];
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => collectW23BrowserLanes(value, ['source', 'dist']));
  }
});

test('failed, skipped, retried and errored cases cannot contribute successful evidence', () => {
  const mutations = [
    value => { result(specs(value)[2]).status = 'failed'; },
    value => { result(specs(value)[2]).status = 'skipped'; },
    value => { result(specs(value)[2]).retry = 1; },
    value => { specs(value)[2].tests[0].results.push(structuredClone(result(specs(value)[2]))); },
    value => { specs(value)[2].tests[0].status = 'flaky'; },
    value => { specs(value)[2].tests[0].expectedStatus = 'failed'; },
    value => { result(specs(value)[2]).errors.push({message: 'hidden failure'}); },
    value => { result(specs(value)[2]).error = {message: 'hidden failure'}; },
    value => { value.errors.push({message: 'global failure'}); },
    value => { value.stats.skipped = 1; },
    value => { value.stats.flaky = 1; },
    value => { value.stats.unexpected = 1; },
  ];
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => collectW23BrowserLanes(value, ['source', 'dist']));
  }
});

test('missing, duplicate, misowned or invalidly typed evidence attachments fail closed', () => {
  const mutations = [
    value => { result(specs(value)[0]).attachments.pop(); },
    value => { result(specs(value)[0]).attachments.push(structuredClone(result(specs(value)[0]).attachments[1])); },
    value => { result(specs(value)[2]).attachments.push(result(specs(value)[0]).attachments.pop()); },
    value => { result(specs(value)[0]).attachments[1].contentType = 'text/plain'; },
    value => { delete result(specs(value)[0]).attachments[1].body; },
  ];
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => collectW23BrowserLanes(value, ['source', 'dist']));
  }
});

test('another project or spec cannot substitute matching W23 test titles', () => {
  const value = report();
  specs(value)[0].tests[0].projectName = 'webkit-preflight';
  assert.throws(() => collectW23BrowserLanes(value, ['source', 'dist']), /Wrong W23 project/);
  specs(value)[0].tests[0].projectName = 'chromium-preflight';
  specs(value)[0].file = 'unrelated.spec.ts';
  assert.throws(() => collectW23BrowserLanes(value, ['source', 'dist']), /Wrong W23 spec/);
});
