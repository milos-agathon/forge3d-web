import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(
    resolve(root, "../../docs/parity/label-case-contract.json"),
    "utf8",
  ),
);
if (
  manifest.schemaVersion !== 1 ||
  new Set(manifest.cases.map((c) => c.id)).size !== manifest.cases.length ||
  manifest.cases.some((c) => !["render", "diagnostic"].includes(c.outcome))
)
  throw Error("Invalid canonical label case manifest");
const source = `// Generated from docs/parity/label-case-contract.json. Do not edit by hand.
import type {LabelRejectionReason} from './label-types.js';
export const LABEL_CASES=${JSON.stringify(manifest.cases, null, 2)} as const;
export function labelCase(id:string):{id:string;outcome:string;code?:string;feature?:string;reason?:LabelRejectionReason}{const c=LABEL_CASES.find(c=>c.id===id);if(!c)throw Error('Unclassified label case: '+id);return c;}
`;
writeFileSync(resolve(root, "src-ts/label-cases.ts"), source);
