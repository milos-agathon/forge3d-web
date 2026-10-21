import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, inventory, createCoverage, sha256 } from './w23-coverage.mjs';

const prior = 'efba9305', previousReview = '5b3d1025', data = createCoverage();
const coverageAt = ref => JSON.parse(execFileSync('git', ['show', ref + ':docs/parity/w23-coverage.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
const native = new Map(inventory().records.map(r => [r.id, r]));
const previous = new Map(coverageAt(prior).records.map(r => [r.artifactId, r]));
const reviewed = new Map(coverageAt(previousReview).records.map(r => [r.artifactId, r]));
const rows = new Map(data.rows.map(r => [r.id, r]));
const expectedChangelog = [
  ['TAA resolve pass', 'P14'],
  ['Full support for both GL [-1,1] and WGPU [0,1] depth ranges', 'C01'],
  ['Categories: VertexBuffers', 'R07'],
  ['Acceptance criteria: Renderer respects ≤512 MiB', 'R07'],
  ['`auto_downscale_froxel_grid()`', 'R07'],
  ['Acceptance: CI green', 'R12'],
  ['Half-resolution volumetric fog', 'P09'],
  ['Height-based fog pipeline', 'P09'],
  ['Half-resolution rendering option', 'P09'],
  ['Reused T3 terrain pipeline', 'T02'],
  ['`build_view_matrices()` now uses WGPU depth range', 'C01'],
  ['GL→WGPU depth conversion', 'C01'],
  ['**P2 — Atmospheric Depth**', 'P09'],
  ['View-ray marching with jittered sampling', 'P09'],
  ['**R8**: Expanded texture size accounting', 'R07'],
  ['Python PBR: default parity math', 'P04'],
  ['Texture setters accept RGB/RGBA', 'P05'],
  ['N6: TBN generation', 'P05'],
  ['Added `MapScene`, `SceneRecipe`', 'M02a'],
  ['`Tileset` and `CopcDataset` classes', 'G02'],
  ['Native `tileset.json` parser', 'G04'],
  ['B3DM (Batched 3D Model) payload decoder', 'G04'],
  ['Hierarchical culling and traversal iterator', 'G04'],
  ['Fixed the point/spot light shader', 'P01'],
  ['Acceptance one-liner:', 'R04'],
  ['Acceptance: Users can reproduce figures', 'R04'],
  ['T4.2: Fixed `numpy_to_png`', 'E07'],
];
for (const [subject, row] of expectedChangelog) {
  const matches = data.records.filter(r => {
    const n = native.get(r.artifactId);
    return n.kind === 'changelog-addition' && n.name.startsWith(subject);
  });
  assert.equal(matches.length, 1, 'Missing or ambiguous native changelog subject: ' + subject);
  assert.equal(matches[0].row, row, subject);
}
const rotterdam = 'tests/test_rotterdam_solar_potential_shadow_study.py';
const expectedRotterdam = [
  'test_osm_context_uses_way_only_queries_for_parks_and_water',
  'test_osm_water_lines_are_drawn_even_when_water_polygons_exist',
];
for (const name of expectedRotterdam) {
  const matches = data.records.filter(r => {
    const n = native.get(r.artifactId);
    return n.kind === 'native-test-definition' && n.source.path === rotterdam && n.name === name;
  });
  assert.equal(matches.length, 1, 'Missing native definition: ' + name);
  assert.equal(matches[0].row, 'P07', rotterdam + '::' + name);
}
for (const record of data.records) {
  const n = native.get(record.artifactId), path = n.source.path, name = n.name;
  if (n.kind === 'native-test-definition') {
    for (const [pattern, row] of [
      [/^tests\/test_license\./, 'M08'], [/^tests\/test_3dtiles/, 'G04'], [/^tests\/test_diagnostics_contract\./, 'M01'],
      [/^tests\/test_taa|^tests\/test_motion_vectors/, 'P14'], [/^tests\/test_volumetrics|^tests\/test_fog/, 'P09'],
      [/^tests\/test_rotterdam_solar_potential_shadow_study\./, 'P07'],
    ]) if (pattern.test(path)) assert.equal(record.row, row, path + '::' + name);
    if (name === 'test_camera_keyframe_constructible') assert.equal(record.row, 'C03');
    if (/test_sdf_.*constructible/.test(name)) assert.equal(record.row, 'G10');
    if (/point_cloud_layer/.test(name)) assert.equal(record.row, 'G03');
  }
  if (n.kind === 'native-doc-feature' && name === 'Point Clouds') assert.equal(record.row, 'G03', path);
  if (n.kind.startsWith('changelog-') && record.row === 'G02') assert(/\b(copc|laz|ept)\b|copcdataset|point.?cloud.*(?:load|decode|hierarch)/i.test((n.details?.context ?? n.name).replaceAll('_', ' ')), n.name);
}

// Read the pinned native blobs, rather than trusting the classifier's generated
// context. Every changed route retains its exact source lines for re-review.
const sourceFiles = new Map();
function inspectSource(n) {
  const key = n.source.ref + ':' + n.source.path;
  if (!sourceFiles.has(key)) {
    const raw = execFileSync('git', ['show', key], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(sha256(raw), n.source.sha256, 'Native source hash: ' + key);
    sourceFiles.set(key, raw.toString('utf8').replace(/\r\n?/g, '\n').split('\n'));
  }
  const lines = sourceFiles.get(key), line = n.source.line ?? 1;
  const firstLine = Math.max(1, line - 4), lastLine = Math.min(lines.length, line + (n.source.line ? 8 : 23));
  return { firstLine, lastLine, lines: lines.slice(firstLine - 1, lastLine) };
}
const changed = (record, before) => record.row !== before?.row || record.tombstone !== before?.tombstone;
const describe = (r, before) => {
  const n = native.get(r.artifactId);
  return { artifactId: r.artifactId, nativeSource: n.source, kind: n.kind, name: n.name, context: n.details?.context ?? null,
    sourceInspection: inspectSource(n), previous: before, disposition: r, evidenceTests: rows.get(r.row).tests };
};
const changes = data.records.filter(r => changed(r, previous.get(r.artifactId))).map(r => describe(r, previous.get(r.artifactId)));
const furtherCorrections = data.records.filter(r => changed(r, reviewed.get(r.artifactId))).map(r => describe(r, reviewed.get(r.artifactId)));
const review = {
  schemaVersion: 1, against: prior, previousReview,
  method: 'Re-reviewed every routing change against efba9305 using the pinned native file excerpt and its source hierarchy. Changelog subjects precede supporting clauses; containing bullets and release titles are fallback context. Native file/symbol expectations are checked separately from the generated routing lock.',
  rules: [
    'LAZ/COPC/EPT, CRS/PROJ and IBL/LUT are tokens, not substrings of accepts/reprojection/constructible/resolution.',
    'The own subject precedes incidental words in supporting clauses and unrelated release-title workstreams.',
    'Generic quality/category/CLI lines inherit their containing native bullet before the release title.',
    'Source file ownership precedes generic texture/water/scatter words, including Rotterdam OSM context helpers in the shadow study.',
    'Point-cloud names/headings are distinct from atmospheric clouds; MapScene recipe introductions and 3D Tiles parsers retain their own subjects.',
    'Dataset and PNG exports use E06 and E07 respectively; PNG array conversion changelog entries use E07.',
  ],
  explicitChangelogExpectations: expectedChangelog.length, explicitRotterdamExpectations: expectedRotterdam.length,
  inspectedNativeFiles: sourceFiles.size, furtherCorrections, changes,
};
const destination = join(root, 'docs/parity/w23-routing-review.json');
if (process.argv.includes('--capture')) writeFileSync(destination, JSON.stringify(review, null, 2) + '\n');
else if (JSON.stringify(JSON.parse(readFileSync(destination, 'utf8'))) !== JSON.stringify(review)) throw Error('Stale source routing review; rerun the source audit capture after inspecting corrections');
console.log(JSON.stringify({ sourceDispositionsAudited: data.records.length, corrections: changes.length,
  furtherCorrections: furtherCorrections.length, inspectedNativeFiles: sourceFiles.size,
  explicitChangelogExpectations: expectedChangelog.length, explicitRotterdamExpectations: expectedRotterdam.length }));
