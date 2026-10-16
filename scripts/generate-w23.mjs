import { generateCoverage, auditHistoricalSources } from './w23-coverage.mjs';
import { generateAssetManifest } from './w23-assets.mjs';
const audit = auditHistoricalSources();
const data = generateCoverage();
const assets = generateAssetManifest();
console.log(JSON.stringify({ ...audit, rows: data.rows.length, examples: data.examples.length, artifacts: data.records.length, assets: assets.assets.length }));
