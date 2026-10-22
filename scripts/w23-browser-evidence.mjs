import assert from 'node:assert/strict';

const cases = [
  'all 54 migrated example workflows execute',
  'guide examples and contribution controls reject missing execution',
  'interactive viewers render input and release retained owners',
  'integrity and independent observers reject substituted workflows',
];
const evidenceOwners = new Map([
  ['w23-workflows.json', 0],
  ['w23-independent-stage-observations.json', 0],
  ['w23-negative-controls.json', 1],
  ['w23-literal-stage-negative-controls.json', 3],
]);

// Return the recorder's existing lane-shaped result after validating every
// independent case, including cases that do not publish W23 attachments.
export function collectW23BrowserLanes(report, laneNames) {
  assert(Array.isArray(laneNames) && laneNames.length > 0, 'Missing W23 lanes');
  assert.equal(new Set(laneNames).size, laneNames.length, 'Duplicate W23 lane');
  assert(laneNames.every(name => ['source', 'dist'].includes(name)), 'Unknown W23 lane');
  assert.deepEqual(report.errors, [], 'Playwright report has top-level errors');
  for (const [key, value] of Object.entries({expected: cases.length * laneNames.length, unexpected: 0, skipped: 0, flaky: 0})) {
    assert.equal(report.stats?.[key], value, `Playwright stats.${key}`);
  }
  assert(Array.isArray(report.suites), 'Missing Playwright suites');
  const specs = report.suites.flatMap(function visit(suite) {
    return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(visit)];
  });
  assert.equal(specs.length, cases.length * laneNames.length, 'Incomplete W23 test inventory');
  const byTitle = new Map();
  for (const spec of specs) {
    assert(!byTitle.has(spec.title), `Duplicate W23 case: ${spec.title}`);
    assert(/(?:^|\/)w23_migration\.spec\.ts$/.test(spec.file?.replaceAll('\\', '/')), 'Wrong W23 spec file');
    assert.equal(spec.ok, true, `Unsuccessful W23 case: ${spec.title}`);
    assert.equal(spec.tests?.length, 1, `W23 case must contain one project: ${spec.title}`);
    const test = spec.tests[0];
    assert.equal(test.projectId, 'chromium-preflight', 'Wrong W23 project');
    assert.equal(test.projectName, 'chromium-preflight', 'Wrong W23 project');
    assert.equal(test.expectedStatus, 'passed', `Unexpected W23 expected status: ${spec.title}`);
    assert.equal(test.status, 'expected', `Unexpected W23 test status: ${spec.title}`);
    assert.equal(test.results?.length, 1, `W23 case must not retry: ${spec.title}`);
    const result = test.results[0];
    assert.equal(result.status, 'passed', `Failed W23 case: ${spec.title}`);
    assert.equal(result.retry, 0, `Retried W23 case: ${spec.title}`);
    assert.deepEqual(result.errors, [], `W23 result contains errors: ${spec.title}`);
    assert.equal(result.error, undefined, `W23 result contains an error: ${spec.title}`);
    assert(Number.isFinite(result.duration) && result.duration >= 0, 'Invalid W23 duration');
    assert(Array.isArray(result.attachments), 'Missing W23 attachments');
    byTitle.set(spec.title, result);
  }
  const lanes = laneNames.map(name => {
    const titles = cases.map(title => `W23 ${name}: ${title}`);
    const results = titles.map(title => {
      assert(byTitle.has(title), `Missing W23 case: ${title}`);
      return byTitle.get(title);
    });
    const attachments = results.flatMap((result, index) => result.attachments.map(attachment => {
      assert.equal(typeof attachment.name, 'string', 'Malformed W23 attachment');
      if (evidenceOwners.has(attachment.name)) {
        assert.equal(evidenceOwners.get(attachment.name), index, `Wrong W23 evidence owner: ${attachment.name}`);
        assert.equal(attachment.contentType, 'application/json', `Wrong W23 evidence type: ${attachment.name}`);
        assert(typeof attachment.body === 'string' || typeof attachment.path === 'string', `Missing W23 evidence bytes: ${attachment.name}`);
        return attachment;
      }
      // Keep corpus attachment names stable. Other cases' automatic probe
      // attachments need distinct digest keys instead of silently overwriting.
      return index === 0 ? attachment : {...attachment, name: `${cases[index]}: ${attachment.name}`};
    }));
    for (const name of evidenceOwners.keys()) {
      assert.equal(attachments.filter(attachment => attachment.name === name).length, 1, `Missing or duplicate W23 evidence: ${name}`);
    }
    assert.equal(new Set(attachments.map(attachment => attachment.name)).size, attachments.length, 'Duplicate W23 attachment name');
    return {title: titles[0], status: 'passed', duration: results.reduce((sum, result) => sum + result.duration, 0), attachments};
  });
  assert.equal(byTitle.size, lanes.length * cases.length, 'Unexpected W23 cases');
  return lanes;
}
