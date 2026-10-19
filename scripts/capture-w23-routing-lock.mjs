import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCoverage, root } from './w23-coverage.mjs';
if(!process.argv.includes('--capture'))throw Error('Use --capture only after reviewing native routing; this command records intent, not independent evidence.');
const data=createCoverage();
const lock={schemaVersion:1,meaning:'Reviewed routing intent lock. This is generated from the catalog and does not independently prove native semantics or execution.',provenance:{generator:'scripts/capture-w23-routing-lock.mjs --capture',reviewRecord:'docs/parity/w23-routing-review.json',nativeAudit:'scripts/audit-w23-native.py',regressions:'crates/forge3d-web/tests/parity/w23-review-regressions.test.mjs',authority:'Original W23 acceptance at d5cf3b57; pinned composite native sources, numerical Python AST controls and independent browser API observations.'},exports:Object.fromEntries(data.pythonExports.map(r=>[r.native,{apis:r.apis,kind:r.kind,note:r.note}])),rows:Object.fromEntries(data.rows.map(r=>[r.id,{tests:r.tests,apis:r.apis,guide:r.guide,example:r.example}])),examples:Object.fromEntries(data.examples.map(e=>[e.nativePath,{source:e.source,workflows:e.workflows,capabilities:e.capabilities}]))};
writeFileSync(join(root,'docs/parity/w23-source-contracts.json'),JSON.stringify(lock,null,2)+'\n');
