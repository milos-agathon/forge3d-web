import { readFileSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import ts from "typescript";

function inside(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[A-Za-z]:/.test(rel))
    throw Error(`Fixture path escapes root: ${path}`);
  return path;
}
function references(text, html) {
  const found = [];
  function script(code, offset) {
    const file = ts.createSourceFile("fixture.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      let literal;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
      if (ts.isNewExpression(node) && ["Worker", "SharedWorker", "URL"].includes(node.expression.getText(file))) literal = node.arguments?.[0];
      if (literal && ts.isStringLiteral(literal)) found.push({ value: literal.text, start: offset + literal.getStart(file) + 1, end: offset + literal.end - 1, resource: ts.isNewExpression(node) });
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  if (html) {
    for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(match[1]);
      if (src) {
        const start = match.index + match[0].indexOf(src[2]);
        found.push({ value: src[2], start, end: start + src[2].length });
      } else if (!/type\s*=\s*["']importmap["']/i.test(match[1])) script(match[2], match.index + match[0].indexOf(">") + 1);
    }
  } else script(text, 0);
  return found;
}

// Resolve a complete literal module/worker/URL graph before publishing any fixture.
// Dynamic asset inventories and deliberate broken routes remain explicit inputs.
export function materializeFixtureGraph({ sourceRoot, outputRoot, entries, mode = "installed", intentionalMissing = [], externalUrls = [], externalImports = [] }) {
  if (!["source", "installed"].includes(mode)) throw Error("Unknown fixture resolution mode");
  sourceRoot = resolve(sourceRoot); outputRoot = resolve(outputRoot);
  const plan = new Map(), visited = new Set(), controls = new Set(intentionalMissing);
  const installedPrefix = "/node_modules/@forge3d/web/";
  function visit(source, destination, packaged = false) {
    const target = inside(outputRoot, resolve(outputRoot, `.${destination}`));
    if (visited.has(destination)) return;
    visited.add(destination);
    let bytes;
    let directory = false;
    try { directory = statSync(source).isDirectory(); } catch { /* Read supplies diagnostic. */ }
    if (directory) {
      for (const name of readdirSync(source)) visit(resolve(source, name), destination.replace(/\/$/, "") + "/" + name, packaged);
      return;
    }
    try { bytes = readFileSync(source); } catch (error) { throw Error(`Incomplete fixture graph: ${destination} (${error.code})`); }
    const extension = extname(source);
    if (![".js", ".mjs", ".ts", ".html"].includes(extension)) { if (!packaged) plan.set(target, bytes); return; }
    let text = bytes.toString("utf8");
    const edits = [];
    for (const ref of references(text, extension === ".html")) {
      const value = ref.resource && !ref.value.startsWith(".") && !ref.value.startsWith("/") && !/^[a-z]+:/i.test(ref.value) ? "./" + ref.value : ref.value;
      if (externalImports.includes(value)) continue;
      if (/^(?:https?:|data:|blob:|node:)/.test(value)) {
        if (!externalUrls.some(prefix => value.startsWith(prefix))) throw Error(`Undeclared external fixture dependency: ${value}`);
        continue;
      }
      let route, dependency, isInstalled = packaged;
      const implementation = /(?:^|\/)src-ts\/([^?#]+)\.ts(?:[?#].*)?$/.exec(value);
      const emitted = /^(?:\.\.\/)?(?:dist|pkg)\/([^?#]+)(?:[?#].*)?$/.exec(value);
      if (mode === "installed" && (implementation || emitted || value === "@forge3d/web")) {
        if (packaged && implementation) throw Error(`Installed graph resolves source implementation: ${value}`);
        route = installedPrefix + "dist/" + (implementation ? implementation[1] + ".js" : emitted ? emitted[1] : "index.js");
        dependency = resolve(outputRoot, `.${route}`); isInstalled = true;
      } else {
        if (!value.startsWith(".") && !value.startsWith("/")) throw Error(`Unresolved fixture import: ${value}`);
        route = new URL(value, `https://fixture.invalid${destination}`).pathname;
        isInstalled = route.startsWith(installedPrefix);
        dependency = isInstalled ? resolve(outputRoot, `.${route}`) : value.startsWith("/")
          ? inside(sourceRoot, resolve(sourceRoot, `.${route}`)) : inside(sourceRoot, resolve(dirname(source), value.split(/[?#]/)[0]));
      }
      if (controls.has(route)) continue;
      visit(dependency, route, isInstalled);
      if (route !== new URL(value === "@forge3d/web" ? "./index.js" : value, `https://fixture.invalid${destination}`).pathname || value === "@forge3d/web")
        edits.push({ ...ref, replacement: route });
    }
    if (!packaged) {
      for (const edit of edits.sort((a,b)=>b.start-a.start)) text = text.slice(0,edit.start) + edit.replacement + text.slice(edit.end);
      plan.set(target, text);
    }
  }
  for (const entry of entries) {
    const source = typeof entry === "string" ? entry : entry.source;
    const destination = typeof entry === "string" ? "/" + entry : "/" + entry.destination.replace(/^\//, "");
    visit(inside(sourceRoot, resolve(sourceRoot, source)), destination);
  }
  for (const [file, contents] of plan) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents); }
  return { files: [...visited].sort(), intentionalMissing: [...controls] };
}
