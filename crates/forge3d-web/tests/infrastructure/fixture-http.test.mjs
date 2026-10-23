import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {resolveInstalledFixtureResponse,inlineScriptCsp} from "../../scripts/fixture-http.mjs";
import {resolveFixtureResponse} from "../../scripts/serve-browser-fixture.mjs";

test("installed and hardware adapters share GET, HEAD, ranges and traversal mechanics",()=>{
 const root=mkdtempSync(join(tmpdir(),"fixture-http-"));
 const basePath="/runs/1/2/"+"a".repeat(32)+"/",host="test.webgpu-ci.forge3d.dev";
 writeFileSync(join(root,"terrain.bin"),Buffer.from([0,1,2,3,4]));
 try {
  const installed=request=>resolveInstalledFixtureResponse({request,route:()=>({root})});
  const hardware=request=>resolveFixtureResponse({role:"application",fixtureRoot:root,applicationHost:host,assetHost:"assets-test.webgpu-ci.forge3d.dev",basePath,request:{...request,host,url:basePath+request.url.slice(1)}});
  for(const adapter of [installed,hardware]) {
   const request={method:"GET",url:"/terrain.bin"};
   assert.deepEqual(adapter(request).body,Buffer.from([0,1,2,3,4]));
   const head=adapter({...request,method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers["Content-Length"],"5");assert.equal(head.body.length,0);
   const range=adapter({...request,range:"bytes=1-3"});assert.equal(range.status,206);assert.deepEqual(range.body,Buffer.from([1,2,3]));
   assert.equal(adapter({...request,method:"HEAD",range:"bytes=1-3"}).body.length,0);
   for(const value of ["bytes=99-100","bytes=4-2","bytes=-0","bytes=0-1,3-4","bytes=99999999999999999999-"]) assert.equal(adapter({...request,range:value}).status,416,value);
   for(const url of ["/../terrain.bin","/%2e%2e/terrain.bin","/%5c..%5cterrain.bin"]) assert.equal(adapter({...request,url}).status,404,url);
   assert.equal(adapter({...request,method:"POST"}).status,405);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
test("installed CSP hashes HTML-normalized scripts before HEAD or range slicing",()=>{
 const root=mkdtempSync(join(tmpdir(),"fixture-csp-")),html="<script>one\r\ntwo\rthree</script>";
 writeFileSync(join(root,"index.html"),html);
 try {
  const expected="'sha256-"+createHash("sha256").update("one\ntwo\nthree").digest("base64")+"'";
  for(const request of [{method:"GET",url:"/index.html"},{method:"HEAD",url:"/index.html"},{method:"GET",url:"/index.html",range:"bytes=0-3"}]) {
   const result=resolveInstalledFixtureResponse({request,route:()=>({root}),hashInlineScripts:true});
   assert(result.headers["Content-Security-Policy"].includes(expected));
   assert.equal(result.headers["Content-Security-Policy"],inlineScriptCsp(Buffer.from(html)));
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("installed migration assets retain their browser content types",()=>{
 const root=mkdtempSync(join(tmpdir(),"fixture-migration-types-"));
 try {
  for(const [extension,expected] of [["svg","image/svg+xml"],["woff","font/woff"],["woff2","font/woff2"],["md","text/plain"]]) {
   const file=`asset.${extension}`;
   writeFileSync(join(root,file),"fixture");
   const result=resolveInstalledFixtureResponse({request:{method:"GET",url:`/${file}`},route:()=>({root})});
   assert.equal(result.status,200);
   assert.equal(result.headers["Content-Type"],expected);
   assert.equal(result.body.toString(),"fixture");
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
