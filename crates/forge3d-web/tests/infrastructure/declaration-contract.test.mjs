import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,utimesSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
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

for(const [name,newline,autocrlf] of [["LF","\n","false"],["CRLF","\r\n","true"]]) {
 test(`publishing unchanged ${name} declarations preserves a clean checkout`,()=>{
  const root=mkdtempSync(join(tmpdir(),"declaration-clean-checkout-"));
  const git=(...args)=>{
   const result=spawnSync("git",args,{cwd:root,encoding:"utf8"});
   assert.equal(result.status,0,result.stderr);return result.stdout;
  };
  try {
   for(const dir of ["types","dist"])mkdirSync(join(root,dir));
   const declaration=join(root,"types/leaf.d.ts"),emitted="export type Value = string;\n";
   writeFileSync(join(root,"types/index.d.ts"),"export type {Value} from './leaf.js';\n");
   writeFileSync(declaration,emitted.replace(/\n/g,newline));
   writeFileSync(join(root,"dist/leaf.d.ts"),emitted);
   writeFileSync(join(root,".gitignore"),"dist/\n");
   utimesSync(declaration,946684800,946684800);
   git("init");git("config","core.autocrlf",autocrlf);git("add",".");
   git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture");
   assert.equal(git("status","--porcelain=v1","--untracked-files=all"),"");
   const before=readFileSync(declaration),mtime=statSync(declaration).mtimeMs;
   publishDeclarationGraph(root);
   assert.deepEqual(readFileSync(declaration),before);
   assert.equal(statSync(declaration).mtimeMs,mtime);
   assert.equal(git("status","--porcelain=v1","--untracked-files=all"),"");
   const changed="export type Value = number;\n";
   writeFileSync(join(root,"dist/leaf.d.ts"),changed);publishDeclarationGraph(root);
   assert.equal(readFileSync(declaration,"utf8"),changed);
   assert.match(git("diff","HEAD","--","types/leaf.d.ts"),/\+export type Value = number;/);
  } finally {rmSync(root,{recursive:true,force:true});}
 });
}
