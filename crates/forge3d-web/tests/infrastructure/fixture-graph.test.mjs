import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { materializeFixtureGraph } from "../../scripts/materialize-browser-fixture.mjs";

test("ordinary and worker fixtures close over installed modules, never source implementation", () => {
  const temp=mkdtempSync(join(tmpdir(),"fixture-graph-")), source=join(temp,"source"), output=join(temp,"output");
  const put=(root,file,bytes)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,bytes);};
  try {
    put(source,"examples/main.html",`<script type="module">import '../src-ts/index.ts';new Worker(new URL('./worker.js',import.meta.url),{type:'module'});</script>`);
    put(source,"examples/worker.js",`import '../src-ts/worker.ts';`);
    put(source,"src-ts/index.ts",`throw Error('must never use source');`);
    put(output,"node_modules/@forge3d/web/dist/index.js",`export * from './leaf.js';`);
    put(output,"node_modules/@forge3d/web/dist/worker.js",`import './leaf.js';`);
    const args={sourceRoot:source,outputRoot:output,entries:[{source:"examples/main.html",destination:"main.html"}]};
    assert.throws(()=>materializeFixtureGraph(args),/Incomplete fixture graph.*leaf.js/);
    assert.equal(existsSync(join(output,"main.html")),false,"failure must precede publication");
    put(output,"node_modules/@forge3d/web/dist/leaf.js",`export const installed=true;`);
    const graph=materializeFixtureGraph(args);
    assert(graph.files.includes("/worker.js"));
    assert.match(readFileSync(join(output,"worker.js"),"utf8"),/node_modules\/@forge3d\/web\/dist\/worker.js/);
    assert.doesNotMatch(readFileSync(join(output,"main.html"),"utf8"),/src-ts/);
    put(output,"node_modules/@forge3d/web/dist/leaf.js",`import '../src-ts/escape.ts';`);
    assert.throws(()=>materializeFixtureGraph(args),/resolves source implementation/);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
test("source resolution and explicit missing/cross-origin controls remain distinct",()=>{
  const temp=mkdtempSync(join(tmpdir(),"fixture-control-")),source=join(temp,"source"),output=join(temp,"output");
  mkdirSync(source);writeFileSync(join(source,"entry.js"),`import './missing.js';import 'https://other.invalid/module.js';`);
  try {
    const args={sourceRoot:source,outputRoot:output,entries:["entry.js"],mode:"source"};
    assert.throws(()=>materializeFixtureGraph(args),/Incomplete fixture graph/);
    assert.throws(()=>materializeFixtureGraph({...args,intentionalMissing:["/missing.js"]}),/Undeclared external/);
    materializeFixtureGraph({...args,intentionalMissing:["/missing.js"],externalUrls:["https://other.invalid/"]});
    assert.equal(existsSync(join(output,"missing.js")),false);
    assert.equal(readFileSync(join(output,"entry.js"),"utf8"),readFileSync(join(source,"entry.js"),"utf8"));
  } finally {rmSync(temp,{recursive:true,force:true});}
});
