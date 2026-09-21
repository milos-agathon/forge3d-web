import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertJsonSchema } from "../crates/forge3d-web/scripts/json-schema-validator.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptRoot, "..");
const manifestPath = "docs/parity/forge3d-composite-baseline.json";
const schemaPath = "docs/parity/schema.json";
const requiredCapabilities = [
  ...Array.from({ length: 12 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 13 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
  "T14a",
  "T14b",
  ...Array.from({ length: 4 }, (_, index) => `T${index + 15}`),
  ...Array.from({ length: 15 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `V${String(index + 1).padStart(2, "0")}`),
  "V06a",
  "V06b",
  "V07",
  ...Array.from({ length: 4 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`),
  "G05a",
  "G05b",
  ...Array.from({ length: 6 }, (_, index) => `G${String(index + 6).padStart(2, "0")}`),
  "M01",
  "M02a",
  "M02b",
  ...Array.from({ length: 7 }, (_, index) => `M${String(index + 3).padStart(2, "0")}`),
];
const requiredConstraints = Array.from({ length: 7 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`);
const requiredFixtures = [
  "dem-synthetic-v1",
  "terrain-material-v1",
  "clipmap-seam-v1",
  "volume-temporal-v1",
  "crs-epsg-v1",
  "mesh-io-v1",
  "copc-ept-tiles-v1",
  "trace-sdf-v1",
  "offline-denoise-v1",
];
const requiredProfiles = ["reference-discrete", "reference-integrated"];
const lockedAssets = {
  harfbuzzjs: { package: "harfbuzzjs", version: "1.6.0", tokens: ["harfbuzzjs"] },
  "proj-wasm": { package: "proj-wasm", version: "0.1.0-alpha9", tokens: ["proj-wasm"] },
  geotiff: { package: "geotiff", version: "3.0.5", tokens: ["geotiff"] },
  "laz-perf": { package: "laz-perf", version: "0.0.7", tokens: ["laz-perf"] },
  "ktx-parse": { package: "ktx-parse", version: "1.1.0", tokens: ["ktx-parse"] },
  "basis-universal": { package: "basis_universal", version: "2.0.3", tokens: ["basis_universal", "basis_transcoder.wasm", "basis_transcoder.js"] },
  exr: { package: "exr", version: "1.74.2", tokens: ["exr =", "exr::"] },
  mediabunny: { package: "mediabunny", version: "1.58.0", tokens: ["mediabunny"] },
  fflate: { package: "fflate", version: "0.8.3", tokens: ["fflate"] },
  "pdf-lib": { package: "pdf-lib", version: "1.17.1", tokens: ["pdf-lib"] },
  "pdf-lib-fontkit": { package: "@pdf-lib/fontkit", version: "1.1.1", tokens: ["@pdf-lib/fontkit"] },
  "noble-ed25519": { package: "@noble/ed25519", version: "3.2.0", tokens: ["@noble/ed25519"] },
};
const ignoredDirectories = new Set([".git", "node_modules", "target", "dist", "pkg", "test-results", "docs", "tests"]);
const scannedExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".rs", ".json", ".toml"]);

export class ParityVerificationError extends Error {
  constructor(report) {
    const details = [...report.schemaErrors, ...report.untracked, ...report.duplicates, ...report.unresolved, ...report.lockViolations];
    super(`Parity manifest verification failed:\n${details.map((item) => `- ${item}`).join("\n")}`);
    this.name = "ParityVerificationError";
    this.report = report;
  }
}

export function loadParityFiles(repositoryRoot = defaultRepositoryRoot) {
  const manifest = readJson(join(repositoryRoot, manifestPath));
  const schema = readJson(join(repositoryRoot, schemaPath));
  const sourceByKind = new Map(manifest.inventorySources.map((source) => [source.kind, source]));
  const inventorySource = requireSource(sourceByKind, "composite-inventory");
  const fixtureSource = requireSource(sourceByKind, "fixture-contracts");
  const hardwareSource = requireSource(sourceByKind, "hardware-profiles");
  const dependencySource = manifest.dependencyLock;
  const inventory = readJson(join(repositoryRoot, inventorySource.path));
  const fixtureContracts = readJson(join(repositoryRoot, fixtureSource.path));
  const hardwareProfiles = readJson(join(repositoryRoot, hardwareSource.path));
  const dependencyLock = readJson(join(repositoryRoot, dependencySource.path));
  const digestErrors = [];
  verifyRawDigest(repositoryRoot, inventorySource, digestErrors);
  verifyRawDigest(repositoryRoot, fixtureSource, digestErrors);
  verifyRawDigest(repositoryRoot, hardwareSource, digestErrors);
  verifyRawDigest(repositoryRoot, dependencySource, digestErrors);
  const planText = normalizeNewlines(readFileSync(join(repositoryRoot, manifest.sourcePlan.path), "utf8"));
  const planDigest = sha256(Buffer.from(planText, "utf8"));
  if (planDigest !== manifest.sourcePlan.sha256) {
    digestErrors.push(`${manifest.sourcePlan.path} digest ${planDigest} does not match manifest ${manifest.sourcePlan.sha256}`);
  }
  return { repositoryRoot, manifest, schema, inventory, fixtureContracts, hardwareProfiles, dependencyLock, digestErrors };
}

export function verifyParityManifest({ repositoryRoot = defaultRepositoryRoot, consumerRecords } = {}) {
  const data = loadParityFiles(repositoryRoot);
  return verifyParityData({ ...data, consumerRecords: consumerRecords ?? collectLockControlledConsumers(repositoryRoot) });
}

export function verifyParityData({ manifest, schema, inventory, fixtureContracts, hardwareProfiles, dependencyLock, digestErrors = [], consumerRecords = [] }) {
  const report = {
    ok: false,
    counts: {
      capabilities: manifest?.capabilities?.length ?? 0,
      constraints: manifest?.constraints?.length ?? 0,
      inventoryRecords: inventory?.records?.length ?? 0,
      mappings: manifest?.mappings?.length ?? 0,
      fixtures: fixtureContracts?.fixtures?.length ?? 0,
      hardwareProfiles: hardwareProfiles?.profiles?.length ?? 0,
      dependencyAssets: dependencyLock?.assets?.length ?? 0,
      lockControlledConsumers: consumerRecords.length,
    },
    schemaErrors: [],
    untracked: [],
    duplicates: [],
    unresolved: [...digestErrors],
    lockViolations: [],
  };
  validateSchemas({ manifest, schema, inventory, fixtureContracts, hardwareProfiles, dependencyLock }, report);
  if (report.schemaErrors.length === 0) {
    validateManifestSemantics({ manifest, inventory, fixtureContracts, hardwareProfiles, dependencyLock, consumerRecords }, report);
  }
  report.ok = report.schemaErrors.length === 0 && report.untracked.length === 0 && report.duplicates.length === 0 && report.unresolved.length === 0 && report.lockViolations.length === 0;
  if (!report.ok) throw new ParityVerificationError(report);
  return report;
}

function validateSchemas(data, report) {
  const checks = [
    ["manifest", data.manifest, data.schema],
    ["inventory", data.inventory, schemaReference(data.schema, "inventory")],
    ["fixture contracts", data.fixtureContracts, schemaReference(data.schema, "fixtureContracts")],
    ["hardware profiles", data.hardwareProfiles, schemaReference(data.schema, "hardwareProfiles")],
    ["dependency lock", data.dependencyLock, schemaReference(data.schema, "dependencyLock")],
  ];
  for (const [label, value, schema] of checks) {
    try {
      assertJsonSchema(value, schema);
    } catch (error) {
      report.schemaErrors.push(`${label}: ${error.message}`);
    }
  }
}

function schemaReference(schema, definition) {
  return { $ref: `#/$defs/${definition}`, $defs: schema.$defs };
}

function validateManifestSemantics(data, report) {
  const { manifest, inventory, fixtureContracts, hardwareProfiles, dependencyLock, consumerRecords } = data;
  const capabilityIds = validateExactIdSet("capability", manifest.capabilities, requiredCapabilities, report);
  const constraintIds = validateExactIdSet("constraint", manifest.constraints, requiredConstraints, report);
  const targetIds = uniqueIndex("web target", manifest.webTargets, report);
  uniqueIndex("tombstone", manifest.tombstones, report);
  const artifactIds = uniqueIndex("inventory artifact", inventory.records, report);
  const mappingIds = uniqueIndex("mapping artifact", manifest.mappings, report, "artifactId");
  uniqueIndex("baseline layer", manifest.baselineLayers, report);
  uniqueIndex("inventory source", manifest.inventorySources, report, "kind");

  for (const source of manifest.inventorySources) {
    const expected = source.kind === "composite-inventory" ? inventory.records.length : source.kind === "fixture-contracts" ? fixtureContracts.fixtures.length : hardwareProfiles.profiles.length;
    if (source.recordCount !== expected) report.unresolved.push(`${source.kind} recordCount ${source.recordCount} does not match ${expected}`);
  }
  if (manifest.mappings.length !== inventory.records.length) report.unresolved.push(`mapping count ${manifest.mappings.length} does not match inventory count ${inventory.records.length}`);
  for (const artifactId of artifactIds.keys()) {
    if (!mappingIds.has(artifactId)) report.untracked.push(`inventory artifact has no mapping: ${artifactId}`);
  }
  for (const artifactId of mappingIds.keys()) {
    if (!artifactIds.has(artifactId)) report.unresolved.push(`mapping refers to unknown artifact: ${artifactId}`);
  }
  for (const mapping of manifest.mappings) {
    if (!capabilityIds.has(mapping.capabilityId)) report.unresolved.push(`mapping ${mapping.artifactId} refers to non-capability ${mapping.capabilityId}`);
    const target = targetIds.get(mapping.targetId);
    if (!target) report.unresolved.push(`mapping ${mapping.artifactId} refers to unknown target ${mapping.targetId}`);
    else if (target.capabilityId !== mapping.capabilityId) report.unresolved.push(`mapping ${mapping.artifactId} target ${mapping.targetId} belongs to ${target.capabilityId}, not ${mapping.capabilityId}`);
    for (const link of mapping.xcLinks) if (!constraintIds.has(link)) report.unresolved.push(`mapping ${mapping.artifactId} has unknown XC link ${link}`);
  }
  for (const row of [...manifest.capabilities, ...manifest.constraints]) {
    const target = targetIds.get(row.targetId);
    if (!target) report.unresolved.push(`${row.id} has no web target ${row.targetId}`);
    else if (target.capabilityId !== row.id) report.unresolved.push(`${row.id} target belongs to ${target.capabilityId}`);
    if (!nonBlank(target?.owner) || !nonEmptyStrings(target?.evidence) || !nonEmptyStrings(target?.tests)) report.unresolved.push(`${row.id} has a blank target owner/evidence/test field`);
  }
  for (const target of manifest.webTargets) {
    if (!capabilityIds.has(target.capabilityId) && !constraintIds.has(target.capabilityId)) report.unresolved.push(`target ${target.id} refers to unknown row ${target.capabilityId}`);
  }
  for (const tombstone of manifest.tombstones) {
    if (!capabilityIds.has(tombstone.capabilityId)) report.unresolved.push(`tombstone ${tombstone.id} refers to unknown capability ${tombstone.capabilityId}`);
    const target = targetIds.get(tombstone.targetId);
    if (!target || target.kind !== "tombstone") report.unresolved.push(`tombstone ${tombstone.id} lacks a tombstone target`);
  }
  for (const capabilityId of capabilityIds.keys()) {
    if (!manifest.mappings.some((mapping) => mapping.capabilityId === capabilityId)) report.untracked.push(`capability has no baseline artifact mapping: ${capabilityId}`);
  }
  for (const constraintId of constraintIds.keys()) {
    const linked = manifest.mappings.some((mapping) => mapping.xcLinks.includes(constraintId)) || manifest.capabilities.some((row) => row.xcLinks.includes(constraintId));
    if (!linked) report.untracked.push(`cross-cutting constraint has no typed link: ${constraintId}`);
  }

  const derivedCounts = countBy(inventory.records, "kind");
  for (const [kind, count] of Object.entries(inventory.counts)) {
    if (derivedCounts[kind] !== count) report.unresolved.push(`inventory count ${kind}=${count} does not match records=${derivedCounts[kind] ?? 0}`);
  }
  const countContracts = {
    packageRootExports: ["package-root-export", 220],
    registeredClasses: ["pyo3-class", 28],
    registeredFunctions: ["pyo3-function", 44],
    sceneMethods: ["scene-method", manifest.counts.sceneMethods],
    pythonApiFiles: ["python-api-file", 72],
    nativeTestFiles: ["native-test-file", 211],
    nativeTestDefinitions: ["native-test-definition", 1792],
    nativeExamples: ["native-example", 54],
    nativeDocumentationAssets: ["native-doc-asset", 88],
    browserDeclarations: ["browser-declaration", 26],
    browserUnitFiles: ["browser-unit-file", 12],
    browserUnitCases: ["browser-unit-case", 80],
    browserPlaywrightSpecs: ["browser-playwright-file", 14],
    browserPlaywrightLiteralCases: ["browser-playwright-case", 38],
    browserApiArtifacts: ["browser-api-artifact", 6],
    browserHtmlFixtures: ["browser-html-fixture", 7],
  };
  for (const [field, [kind, expected]] of Object.entries(countContracts)) {
    if (manifest.counts[field] !== expected || derivedCounts[kind] !== expected) report.unresolved.push(`${field}/${kind} must equal ${expected}`);
  }
  const namedTests = inventory.records.filter((record) => record.kind === "native-test-file" && /^tests\/test_.*\.py$/u.test(record.source.path)).length;
  if (namedTests !== 191 || manifest.counts.namedNativeTestFiles !== 191) report.unresolved.push(`named native test file count must be 191, got ${namedTests}`);
  const documentationPages = new Set(inventory.records.filter((record) => record.kind === "native-doc-asset" && /\.(?:md|rst)$/iu.test(record.source.path)).map((record) => record.source.path)).size;
  if (documentationPages !== 53 || manifest.counts.nativeDocumentationPages !== 53) report.unresolved.push(`native documentation page count must be 53, got ${documentationPages}`);
  if (derivedCounts["browser-playwright-case"] + derivedCounts["browser-playwright-generated-case"] !== 39 || manifest.counts.browserPlaywrightGeneratedCases !== 39) report.unresolved.push("generated Playwright case count must be 39");

  validateFixtureContracts(fixtureContracts, capabilityIds, hardwareProfiles, report);
  validateHardwareProfiles(hardwareProfiles, report);
  validateDependencyLock(manifest, dependencyLock, fixtureContracts, consumerRecords, report);
}

function validateFixtureContracts(fixtureContracts, capabilityIds, hardwareProfiles, report) {
  const fixtures = validateExactIdSet("fixture", fixtureContracts.fixtures, requiredFixtures, report);
  const profiles = new Set(hardwareProfiles.profiles.map((profile) => profile.id));
  for (const fixture of fixtures.values()) {
    for (const capabilityId of fixture.capabilityIds) if (!capabilityIds.has(capabilityId)) report.unresolved.push(`fixture ${fixture.id} refers to unknown capability ${capabilityId}`);
    for (const owner of fixture.ownerTasks) if (!/^W(?:0[0-9]|1[0-9]|2[0-4])$/u.test(owner)) report.unresolved.push(`fixture ${fixture.id} has invalid owner ${owner}`);
    const expectedGeneratorDigest = sha256(Buffer.from(canonicalJson({ kind: fixture.generator.kind, version: fixture.generator.version, seed: fixture.generator.seed, parameters: fixture.generator.parameters }), "utf8"));
    if (expectedGeneratorDigest !== fixture.generator.sha256) report.unresolved.push(`fixture ${fixture.id} generator digest does not match its canonical specification`);
    const budgetProfiles = new Set(fixture.budgets.map((budget) => budget.profileId));
    for (const profile of profiles) if (!budgetProfiles.has(profile)) report.unresolved.push(`fixture ${fixture.id} has no budget for ${profile}`);
    for (const budget of fixture.budgets) if (!profiles.has(budget.profileId)) report.unresolved.push(`fixture ${fixture.id} has budget for unknown profile ${budget.profileId}`);
    if (Object.keys(fixture.tolerances).length === 0) report.unresolved.push(`fixture ${fixture.id} has blank tolerances`);
  }
}

function validateHardwareProfiles(hardwareProfiles, report) {
  const profiles = validateExactIdSet("hardware profile", hardwareProfiles.profiles, requiredProfiles, report);
  const discrete = profiles.get("reference-discrete");
  const integrated = profiles.get("reference-integrated");
  const eightGiB = 8 * 1024 ** 3;
  const fourGiB = 4 * 1024 ** 3;
  if (discrete?.adapterBudgetBytes < eightGiB) report.unresolved.push("reference-discrete adapter budget must be at least 8 GiB");
  if (!discrete?.requiredFeatures.includes("timestamp-query")) report.unresolved.push("reference-discrete must require timestamp-query");
  if (integrated?.effectiveBudgetBytes < fourGiB) report.unresolved.push("reference-integrated effective budget must be at least 4 GiB");
  for (const profile of profiles.values()) {
    for (const field of [profile.adapter, profile.driver, profile.os]) {
      if (!field || Object.values(field).some((value) => !nonBlank(value))) report.unresolved.push(`${profile.id} adapter/driver/OS identity is blank`);
    }
  }
}

function validateDependencyLock(manifest, dependencyLock, fixtureContracts, consumerRecords, report) {
  const assets = validateExactIdSet("dependency asset", dependencyLock.assets, Object.keys(lockedAssets), report);
  const manifestRequired = new Set(manifest.dependencyLock.requiredAssetIds);
  for (const required of Object.keys(lockedAssets)) if (!manifestRequired.has(required)) report.lockViolations.push(`manifest dependency lock omits ${required}`);
  for (const [id, expected] of Object.entries(lockedAssets)) {
    const asset = assets.get(id);
    if (!asset) continue;
    if (asset.package !== expected.package || asset.version !== expected.version) report.lockViolations.push(`${id} must remain ${expected.package}@${expected.version}`);
    if (asset.source.sha256.length !== 64 || asset.build.artifacts.some((artifact) => artifact.sha256.length !== 64)) report.lockViolations.push(`${id} has an invalid source/build digest`);
    if (!asset.delivery.cspRule.includes("'self'") || !nonBlank(asset.delivery.sriRule)) report.lockViolations.push(`${id} lacks a self-hosted CSP/SRI rule`);
    if (asset.delivery.runtimeRemoteFetch) report.lockViolations.push(`${id} must not use runtime remote dependency fetches`);
    if (!nonEmptyStrings(asset.fixtureProvenance) || !nonEmptyStrings(asset.consumingTasks)) report.lockViolations.push(`${id} has blank fixture provenance or consuming tasks`);
    for (const fixtureId of asset.manifestFixtureIds ?? []) if (!fixtureContracts.fixtures.some((fixture) => fixture.id === fixtureId)) report.lockViolations.push(`${id} refers to unknown fixture ${fixtureId}`);
  }
  for (const risky of ["proj-wasm", "laz-perf"]) {
    const asset = assets.get(risky);
    if (asset && (!/experimental/i.test(asset.review.security) || !/maintenance-risk/i.test(asset.review.maintenance))) report.lockViolations.push(`${risky} must retain experimental security and maintenance-risk review gates`);
  }
  const exr = assets.get("exr");
  if (exr && !exr.build.flags.includes("default-rayon-disabled")) report.lockViolations.push("exr must disable default rayon for WASM");
  const basis = assets.get("basis-universal");
  if (basis && !basis.build.artifacts.some((artifact) => artifact.name === "basis_transcoder.wasm")) report.lockViolations.push("Basis Universal lock must include basis_transcoder.wasm");
  for (const consumer of consumerRecords) {
    const asset = assets.get(consumer.assetId);
    if (!asset) {
      report.lockViolations.push(`lock-controlled consumer ${consumer.path} uses ${consumer.token} without ${consumer.assetId} lock entry`);
      continue;
    }
    if (consumer.declaredVersion !== undefined && consumer.declaredVersion !== asset.version) report.lockViolations.push(`${consumer.path} declares ${asset.package}@${consumer.declaredVersion}, expected exact ${asset.version}`);
  }
}

export function collectLockControlledConsumers(repositoryRoot = defaultRepositoryRoot) {
  const files = [];
  walk(repositoryRoot, files, repositoryRoot);
  const records = [];
  for (const path of files) {
    const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/");
    if (repositoryPath === "scripts/generate-parity-inventory.mjs" || repositoryPath === "scripts/verify-parity-manifest.mjs") continue;
    const text = readFileSync(path, "utf8");
    if (path.endsWith("package.json")) {
      const packageJson = JSON.parse(text);
      const dependencySets = [packageJson.dependencies, packageJson.devDependencies, packageJson.peerDependencies, packageJson.optionalDependencies];
      for (const dependencies of dependencySets) {
        for (const [packageName, declaredVersion] of Object.entries(dependencies ?? {})) {
          const match = Object.entries(lockedAssets).find(([, expected]) => expected.package === packageName);
          if (match) records.push({ assetId: match[0], path: repositoryPath, token: packageName, declaredVersion });
        }
      }
      continue;
    }
    for (const [assetId, expected] of Object.entries(lockedAssets)) {
      for (const token of expected.tokens) {
        if (text.includes(token)) records.push({ assetId, path: repositoryPath, token });
      }
    }
  }
  return deduplicateConsumers(records);
}

function walk(directory, files, root) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path, files, root);
    } else if (scannedExtensions.has(extname(entry)) || entry === "Cargo.toml" || entry === "package.json") {
      files.push(path);
    }
  }
}

function deduplicateConsumers(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.assetId}\0${record.path}\0${record.token}\0${record.declaredVersion ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateExactIdSet(label, values, expectedIds, report) {
  const index = uniqueIndex(label, values, report);
  const expected = new Set(expectedIds);
  for (const id of expected) if (!index.has(id)) report.untracked.push(`required ${label} is missing: ${id}`);
  for (const id of index.keys()) if (!expected.has(id)) report.unresolved.push(`unexpected ${label}: ${id}`);
  return index;
}

function uniqueIndex(label, values, report, key = "id") {
  const index = new Map();
  for (const value of values ?? []) {
    const id = value?.[key];
    if (index.has(id)) report.duplicates.push(`duplicate ${label}: ${id}`);
    else index.set(id, value);
  }
  return index;
}

function countBy(values, key) {
  const result = {};
  for (const value of values) result[value[key]] = (result[value[key]] ?? 0) + 1;
  return result;
}

function requireSource(sources, kind) {
  const source = sources.get(kind);
  if (!source) throw new Error(`manifest is missing ${kind} inventory source`);
  return source;
}

function verifyRawDigest(repositoryRoot, source, errors) {
  const bytes = readFileSync(join(repositoryRoot, source.path));
  const actual = sha256(bytes);
  if (actual !== source.sha256) errors.push(`${source.path} digest ${actual} does not match manifest ${source.sha256}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function nonBlank(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonBlank);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = verifyParityManifest();
    console.log(JSON.stringify({
      ok: true,
      ...report.counts,
      untracked: report.untracked.length,
      duplicates: report.duplicates.length,
      unresolved: report.unresolved.length,
      schemaErrors: report.schemaErrors.length,
      lockViolations: report.lockViolations.length,
    }, null, 2));
  } catch (error) {
    if (error instanceof ParityVerificationError) {
      console.error(error.message);
      console.error(JSON.stringify({
        ok: false,
        ...error.report.counts,
        untracked: error.report.untracked.length,
        duplicates: error.report.duplicates.length,
        unresolved: error.report.unresolved.length,
        schemaErrors: error.report.schemaErrors.length,
        lockViolations: error.report.lockViolations.length,
      }, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
