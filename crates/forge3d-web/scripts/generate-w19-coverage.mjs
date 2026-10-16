import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url), raw = readFileSync(new URL('tests/fixtures/w19/native-contract.json', root)), fixture = JSON.parse(raw);
const rationales = {
  test_manifest_roundtrip: 'Browser manifest metadata and mandatory payload digests replace the native manifest class; terrain/bookmarks live in canonical scene state.',
  test_is_bundle_false_for_nonexistent: 'HTTP 404 replaces a nonexistent filesystem directory.',
  test_is_bundle_false_for_file: 'An ordinary File is rejected as a non-archive.',
  test_is_bundle_false_for_dir_without_manifest: 'An archive without manifest.json replaces a directory without a manifest.',
  test_load_bundle_rejects_invalid: 'Malformed bytes reject with IO_ERROR.',
  test_manifest_version_check: 'Future schema versions reject with bundle-version-mismatch.',
  test_load_v1_bundle_synthesizes_empty_review_registry: 'A checked native v1 mirror archive loads with an empty registry and preserved exposure.',
  test_bundle_manifest_version: 'The public version and loaded manifest remain v2.',
  test_bundle_image_hash_verification: 'Real PNG bytes survive archive save/load with matching SHA-256; browser pixel replay is separate supplemental evidence.',
  test_save_bundle_flag_exists: 'Public MapScene.saveBundle produces a Blob; the browser spec exercises the download button.',
  test_load_bundle_flag_exists: 'Public MapScene.loadBundle accepts a File; the browser spec exercises the file input.',
  test_was_cli_set_detects_explicit_flags: 'Browser export options replace CLI arguments: omitting allowMissingAssets uses the diagnostic-bearing default, while an explicit false selects strict failure and an explicit true preserves missing-asset diagnostics.',
  test_bundle_directory_structure: 'manifest.json, canonical state and checked asset entries replace native on-disk directories.',
  test_manifest_has_version_2: 'The encoded manifest declares v2.',
  test_bundle_extension_added_if_missing: 'Bundle download/picker names append .forge3d when no suffix was supplied, preserve existing suffixes, and produce a verified archive through the actual output sink.',
  test_save_bundle_writes_deterministic_review_bundle_with_label_plan: 'Canonical serialization is deterministic and preserves an actual W13 compiled LabelPlan; browser preparation checks real fonts and rendered plans.',
  test_save_bundle_preserves_blocking_diagnostics_without_render_success_claim: 'Reports and blocked review status persist without last_render.',
  test_save_bundle_preserves_missing_asset_diagnostics_without_renderability: 'A missing terrain URL produces a blocking missing_external_asset report.',
  test_p1_bundle_persists_asset_layers_label_sources_and_diagnostics: 'Canonical typed layer sources replace separate native layer-source mirrors; vector, label, building and tileset source payloads and their support diagnostics survive.',
  test_p1_bundle_missing_external_assets_remain_diagnostic_bearing: 'Re-saving preserves the missing URL and its diagnostic without duplicating it.',
  test_bundle_persists_required_p1_review_fields_and_label_payloads: 'Camera bookmarks, review status and all recipe fields survive canonical round trip; label payloads are checked in the adjacent guardrail case.',
  test_bundle_load_reconstructs_renderable_scene_when_assets_are_available: 'A complete inline terrain/vector recipe reconstructs and prepares; the browser spec asserts covered rendering and exact pixels.',
  test_bundle_load_reports_missing_external_assets_with_structured_diagnostics: 'MapScene retains path/severity/code and refuses preparation of missing assets.',
};
const equivalents = readFileSync(new URL('tests/unit/w19-native-equivalents.test.ts', root), 'utf8');
const declared = new Set([...equivalents.matchAll(/it\(key\('([^']+)', '([^']+)'\)/g)].map(m => `tests/${m[1]}.py :: ${m[2]}`));
const tests = fixture.sources.flatMap(s => s.tests.map(name => {
  const title = `${s.path} :: ${name}`, replay = fixture.testReplays.find(t => t.source === s.path && t.test === name);
  if (replay?.calls.length) return { source: s.path, test: name, disposition: 'native-api-replay', nativeOriginalExecuted: true,
    evidence: { file: 'tests/unit/w19-native-replay.test.ts', title, fixture: 'tests/fixtures/w19/native-contract.json', observedCalls: replay.calls.length, operations: [...new Set(replay.calls.map(c => c.operation))].sort() } };
  assert(declared.has(title), `No executable equivalent for ${title}`);
  assert(rationales[name], `No per-case equivalence rationale for ${name}`);
  return { source: s.path, test: name, disposition: 'browser-equivalent', nativeOriginalExecuted: !!replay,
    evidence: { file: 'tests/unit/w19-native-equivalents.test.ts', title }, substitution: rationales[name] };
}));
assert.equal(tests.length, 103); assert.equal(tests.filter(t => t.disposition === 'browser-equivalent').length, declared.size);
writeFileSync(new URL('docs/w19-native-test-coverage.json', root), JSON.stringify({ schemaVersion: 2, baseline: fixture.commit, nativeTestCount: tests.length,
  nativeOriginalTestsExecuted: fixture.testReplays.length, nativeApiReplayTests: tests.filter(t => t.disposition === 'native-api-replay').length, browserEquivalentTests: declared.size,
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  note: 'Source pinning is provenance only. Replays compare observed native API inputs/results per original test; they do not claim to execute Python test bodies in TypeScript. CLI, filesystem and MapScene facade substitutions have explicit outcome assertions. The only native execution shim bypasses the W21 license check.', tests }, null, 2) + '\n');
