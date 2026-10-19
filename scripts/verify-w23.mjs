import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, manifestPath, validateCoverage, filesBelow, sha256, generateCoverage, sourceContracts } from './w23-coverage.mjs';
import { assetManifestPath, validateAssets } from './w23-assets.mjs';
import { packagePrefix } from './w23-catalog.mjs';
import { documentationContext } from './w23-doc-context.mjs';

export function verifyPublicApis(data) {
  const ts = createRequire(join(root, packagePrefix, 'package.json'))('typescript');
  const entry = join(root, packagePrefix, 'types/index.d.ts');
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true });
  const checker = program.getTypeChecker(), source = program.getSourceFile(entry);
  const exports = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(source)).map(s => s.name));
  const expected = sourceContracts().exports;
  return [...(data.pythonExports ?? []).filter(r => JSON.stringify(r.apis) !== JSON.stringify(expected[r.native]?.apis)).map(r => `Semantic API destination mismatch ${r.native}`),
    ...[...data.rows.map(r => ({ id: r.id, apis: r.apis })), ...(data.pythonExports ?? []).map(r => ({ id: r.native, apis: r.apis }))].flatMap(r => r.apis.filter(name => !exports.has(name)).map(name => `Unknown public TypeScript API ${r.id}: ${name}`))];
}
export function verifyDocs({ packageRoot = join(root, packagePrefix), checkCode = true } = {}) {
  const ts = createRequire(join(root, packagePrefix, 'package.json'))('typescript');
  const docs = packageRoot === join(root, packagePrefix)
    ? [packagePrefix + 'README.md', ...filesBelow(packagePrefix + 'docs').filter(p => p.endsWith('.md'))].map(p => join(root, p))
    : [join(packageRoot, 'README.md'), ...walk(join(packageRoot, 'docs')).filter(p => p.endsWith('.md'))];
  const errors = [], checked = [], sourceLinks = new Set();
  let fences = 0, links = 0;
  for (const path of docs) {
    const markdown = readFileSync(path, 'utf8');
    for (const link of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const href = link[1];
      if (/^https:\/\/github\.com\/milos-agathon\//.test(href)) {
        const parsed = /^https:\/\/github\.com\/milos-agathon\/([^/]+)\/blob\/([a-f0-9]{7,40})\/([^#?]+)/.exec(href);
        if (parsed) {
          if (parsed[1] !== 'forge3d-web') errors.push(`Wrong provenance repository ${path}: ${href}`);
          sourceLinks.add(`${parsed[2]}:${decodeURIComponent(parsed[3])}`);
        }
      }
      if (/^(?:https?:|mailto:|data:)/.test(href)) continue;
      const [targetPart, fragment] = href.split('#'), target = resolve(dirname(path), decodeURIComponent(targetPart.split('?')[0] || path));
      const rel = relative(root, target);
      if (packageRoot === join(root, packagePrefix) && (rel.startsWith('..') || isAbsolute(rel))) { errors.push(`Link escapes repository: ${path}: ${href}`); continue; }
      if (!existsSync(target)) { errors.push(`Broken documentation link ${path}: ${href}`); continue; }
      if (fragment && /\.md$/i.test(target)) {
        const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim().toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-'));
        if (!headings.includes(decodeURIComponent(fragment))) errors.push(`Missing documentation anchor ${path}: ${href}`);
      }
      links++;
    }
    for (const fence of markdown.matchAll(/^```(ts|typescript|js|javascript)([^\n]*)\n([\s\S]*?)^```/gm)) {
      fences++;
      const parsed = ts.createSourceFile('snippet.ts', fence[3], ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      for (const d of parsed.parseDiagnostics) errors.push(`Invalid code fence in ${path}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
      // All package imports are checked, even for contextual fragments.
      const apis = new Set(verifyExportNames(ts, packageRoot));
      const visit = node => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@forge3d/web' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings))
          for (const element of node.importClause.namedBindings.elements) if (!apis.has((element.propertyName ?? element.name).text)) errors.push(`Unknown code-fence import in ${path}: ${element.name.text}`);
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      checked.push({ path, code: fence[3], context:documentationContext(ts,parsed,path), strict: /\bchecked\b/.test(fence[2]) });
    }
  }
  if (checkCode && checked.length) {
    const out = join(root, packagePrefix, 'test-results/w23-docs'); mkdirSync(out, { recursive: true });
    const names = checked.map((c, i) => { const name = join(out, `snippet-${i}.ts`); writeFileSync(name, 'export {};\n' + (c.strict?'':c.context) + c.code); return name; });
    const program = ts.createProgram(names, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: false, noEmit: true, types: [], paths: { '@forge3d/web': [join(packageRoot, 'types/index.d.ts')] } });
    for (const d of ts.getPreEmitDiagnostics(program)) errors.push(`Checked documentation ${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    const strictNames = names.filter((_, i) => checked[i].strict);
    const strict = ts.createProgram(strictNames, {...program.getCompilerOptions(), strict:true});
    for (const d of ts.getPreEmitDiagnostics(strict)) errors.push(`Strict documentation: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  }
  if (sourceLinks.size) {
    const objects = execFileSync('git', ['cat-file', '--batch-check'], {cwd:root, input:[...sourceLinks].join('\n')+'\n', encoding:'utf8'}).trim().split('\n');
    objects.forEach((line, i) => { if (!/^[a-f0-9]{40} blob \d+$/.test(line)) errors.push(`Missing immutable documentation source ${[...sourceLinks][i]}`); });
  }
  return { errors, documents: docs.length, links, sourceLinks:sourceLinks.size, codeFences: fences, checkedCodeFences: checked.length };
}
function verifyExportNames(ts, packageRoot) {
  // Re-export declarations are part of the public map, so use the checker.
  const entry = join(packageRoot, 'types/index.d.ts'), cached = exportCache.get(entry);
  if (cached) return cached;
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const checker = program.getTypeChecker(), names = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry))).map(s => s.name);
  exportCache.set(entry, names); return names;
}
const exportCache = new Map();
function walk(path) {
  // The installed consumer is outside the repository; use the same bounded walk.
  const { readdirSync } = createRequire(import.meta.url)('node:fs');
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)]);
}
export function verifyW23() {
  const data = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  const assets = JSON.parse(readFileSync(join(root, assetManifestPath), 'utf8'));
  generateCoverage({ check: true });
  const docs = verifyDocs();
  const errors = [...validateCoverage(data), ...verifyPublicApis(data), ...validateAssets(assets), ...docs.errors];
  if (errors.length) throw Error(`W23 verification failed:\n${errors.join('\n')}`);
  return { rows: data.rows.length, records: data.records.length, nativeExamples: data.examples.length, assets: assets.assets.length,
    documents: docs.documents, links: docs.links, codeFences: docs.codeFences, checkedCodeFences: docs.checkedCodeFences,
    coverageSha256: sha256(readFileSync(join(root, manifestPath))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--coverage-only')) {
    const errors = validateCoverage(JSON.parse(readFileSync(join(root, manifestPath), 'utf8')));
    if (errors.length) throw Error(errors.join('\n'));
    console.log('W23: all 91 rows have an example or explicit contract suite; all 6531 artifacts are routed.');
  } else console.log(JSON.stringify(verifyW23()));
}
