import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createServer } from "vite";
import { realmFixturePlugin } from "../browser/realm-fixture-server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("both real realm facade copies serve their complete emitted module graphs", async () => {
  const server = await createServer({
    configFile: false,
    root,
    plugins: [realmFixturePlugin(root)],
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const copy of ["a", "b"]) {
      const prefix = `${origin}/tests/realm-fixture/${copy}/`;
      const pending = [`${prefix}index.js`];
      const visited = new Set();
      while (pending.length) {
        const url = pending.pop();
        if (visited.has(url)) continue;
        visited.add(url);
        const response = await fetch(url);
        assert.equal(response.status, 200, `missing emitted module: ${url}`);
        assert.match(response.headers.get("content-type"), /javascript/u, url);
        const source = ts.createSourceFile(url, await response.text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const visit = (node) => {
          const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? node.arguments[0] : undefined;
          if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
            const dependency = new URL(specifier.text, url).href;
            assert.ok(dependency.startsWith(prefix) || dependency === `${origin}/tests/realm-fixture/pkg/forge3d_web.js`, `copy escaped its graph: ${dependency}`);
            pending.push(dependency);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      assert.ok(visited.size > 1, "must exercise a split facade, not a single-file fixture");
      assert.equal((await fetch(`${prefix}missing-chunk.js`)).status, 404);
    }
  } finally {
    await server.close();
  }
});
