import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { readdirSync } from 'node:fs';
function parse(file: string) { return ts.createSourceFile(file, readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS); }
function descendants(node: ts.Node): ts.Node[] { const all: ts.Node[] = []; const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); }; visit(node); return all; }
const calls = (node: ts.Node, name: string) => descendants(node).filter(n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) as ts.CallExpression[];
it('W20 exhaustively maps 105 native tests to assertion-bearing executable cases', () => {
  const fixture = readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url));
  const oracle = JSON.parse(fixture.toString()), coverage = JSON.parse(readFileSync(new URL('../../docs/w20-native-test-coverage.json', import.meta.url), 'utf8'));
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(coverage.fixtureSha256);
  expect(createHash('sha256').update(readFileSync(new URL('../fixtures/w20/layout-oracle.json', import.meta.url))).digest('hex')).toBe(coverage.layoutFixtureSha256);
  const id = (r: any) => `${r.source}::${r.class}::${r.test}`, originals = oracle.tests.map(id);
  for (const file of readdirSync(new URL('../fixtures/w20/native/src/export/', import.meta.url))) {
    const body = readFileSync(new URL('../fixtures/w20/native/src/export/' + file, import.meta.url), 'utf8');
    for (const match of body.matchAll(/#\[test\]\s*fn (\w+)\(/g)) originals.push(`src/export/${file}::tests::${match[1]}`);
  }
  for (const file of ['test_colormaps_core.py', 'test_colormaps_cvd.py']) {
    const body = readFileSync(new URL('../fixtures/w20/native/tests/' + file, import.meta.url), 'utf8');
    for (const match of body.matchAll(/^def (test_\w+)\(/gm)) originals.push(`tests/${file}::tests::${match[1]}`);
  }
  expect(originals).toHaveLength(105); expect(new Set(coverage.tests.map(id)).size).toBe(105);
  expect(coverage.tests.map(id).sort()).toEqual(originals.sort());
  for (const c of coverage.tests) {
    const tree = parse(c.evidence.file);
    if (c.source === 'test_map_plate_layout.py') {
      const clause = descendants(tree).find(n => ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === `${c.class}::${c.test}`) as ts.CaseClause;
      expect(clause, id(c)).toBeDefined();
      const siblings = (clause.parent as ts.CaseBlock).clauses, index = siblings.indexOf(clause);
      const body = siblings.slice(index).find(n => n.statements.length)!.statements;
      expect(body.flatMap(n => calls(n, 'assert')).length, id(c)).toBeGreaterThan(0);
      expect(c.evidence.file).toBe('tests/browser/w20-native-plate-cases.js');
    } else {
      const first = c.source.startsWith('src/') || c.source.startsWith('tests/') ? c.source : c.class;
      const call = calls(tree, 'native').find(n => ts.isStringLiteral(n.arguments[0]!) && n.arguments[0].text === first && ts.isStringLiteral(n.arguments[1]!) && n.arguments[1].text === c.test);
      expect(call, id(c)).toBeDefined();
      const callback = call!.arguments[2]!; expect(ts.isArrowFunction(callback)).toBe(true);
      expect(calls(callback, 'expect').length, id(c)).toBeGreaterThan(0);
    }
    expect(c.adaptation.length).toBeGreaterThan(30);
  }
});
it('W20 public guides are valid UTF-8 on every checkout platform', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of ['README.md', 'docs/browser-api.md', 'docs/support-matrix.md', 'docs/cartography.md', 'docs/w20-evidence.md']) {
    expect(() => decoder.decode(readFileSync(new URL('../../' + file, import.meta.url)))).not.toThrow();
  }
});
