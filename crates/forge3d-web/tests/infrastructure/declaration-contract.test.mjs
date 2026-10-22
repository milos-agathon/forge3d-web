import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {publishDeclarationGraph,verifyDeclarationContract} from "../../scripts/declaration-contract.mjs";
test("reviewed facade, transitive publishing and real consumers form one declaration contract",()=>{
 const root=mkdtempSync(join(tmpdir(),"declaration-contract-"));
 for(const path of ["types","dist","tests/api"])mkdirSync(join(root,path),{recursive:true});
 const facade="export {answer} from './leaf.js';export type * from './type-only.js';\n";
 writeFileSync(join(root,"types/index.d.ts"),facade);writeFileSync(join(root,"tests/api/index.d.ts.snapshot"),facade);
 writeFileSync(join(root,"dist/leaf.d.ts"),"import type {Answer} from './detail.js';export declare function answer():Answer;");
 writeFileSync(join(root,"dist/type-only.d.ts"),"export declare function typeOnlyFunction():void;");
 writeFileSync(join(root,"dist/detail.d.ts"),"export type Answer=number;");
 writeFileSync(join(root,"tests/api/consumer.ts"),"import {answer} from '../../types/index.js';const result:number=answer();");
 writeFileSync(join(root,"tsconfig.api.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"ESNext",moduleResolution:"Bundler",strict:true,types:[]},include:["tests/api/*.ts"]}));
 try {
  const graph=publishDeclarationGraph(root);assert(graph.includes("detail"));assert.equal(readFileSync(join(root,"types/index.d.ts"),"utf8"),facade);
  assert.deepEqual(verifyDeclarationContract({root,emittedExports:["answer"]}).valueExports,["answer"]);
  assert.throws(()=>verifyDeclarationContract({root,emittedExports:["changed"]}),/exports differ/);
  writeFileSync(join(root,"types/detail.d.ts"),"export type Answer=string;");
  assert.throws(()=>verifyDeclarationContract({root,emittedExports:["answer"]}),/not assignable/);
  rmSync(join(root,"types/detail.d.ts"));assert.throws(()=>verifyDeclarationContract({root,emittedExports:["answer"]}),/Cannot find module/);
  writeFileSync(join(root,"types/index.d.ts"),"export const changed:number;");assert.throws(()=>verifyDeclarationContract({root}),/snapshot/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
