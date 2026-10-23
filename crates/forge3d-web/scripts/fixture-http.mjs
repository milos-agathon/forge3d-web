import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { createHash } from "node:crypto";

export function fixturePath(root, file) {
  root = resolve(root);
  const path = resolve(root, file), rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw Error("fixture route escaped its root");
  return path;
}
export function fixtureRequestPath(url) {
  const raw = decodeURIComponent(url.split(/[?#]/)[0]);
  if (raw.includes("\\") || raw.includes("\0") || raw.split("/").some(part=>part===".." || part===".")) throw Error("invalid fixture path");
  return new URL(url, "http://fixture.invalid").pathname;
}
function parseRange(value, length) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || length === 0) return null;
  const first = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(Number(match[2]), length-1) : length-1;
  if ((!match[1] && Number(match[2]) === 0) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first>last || first>=length) return null;
  return {start:first,end:last};
}
export function fixtureFileResponse({fixtureRoot, route, request, headers = {}, transform}) {
  const path=fixturePath(fixtureRoot,route.file);
  let body=readFileSync(path);
  if(transform) body=transform(body,path);
  headers={...headers};
  if(route.ranges) headers["Accept-Ranges"]="bytes";
  const range=route.ranges ? parseRange(request.range,body.length) : null;
  if(request.range && !range) return {status:416,headers:{...headers,"Content-Range":`bytes */${body.length}`},body:Buffer.alloc(0)};
  if(range) {
    const slice=body.subarray(range.start,range.end+1);
    return {status:206,headers:{...headers,"Content-Range":`bytes ${range.start}-${range.end}/${body.length}`,"Content-Length":String(slice.length)},body:request.method==="HEAD"?Buffer.alloc(0):slice};
  }
  return {status:200,headers:{...headers,"Content-Length":String(body.length)},body:request.method==="HEAD"?Buffer.alloc(0):body};
}
export function inlineScriptCsp(bytes) {
  const hashes=[...bytes.toString("utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>"'sha256-"+createHash("sha256").update(m[1].replace(/\r\n?/g,"\n")).digest("base64")+"'");
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}; worker-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'`;
}
export function fixtureContentType(path) {
  return ({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json",".geojson":"application/geo+json",".wasm":"application/wasm",".ttf":"font/ttf",".png":"image/png",".svg":"image/svg+xml",".woff":"font/woff",".woff2":"font/woff2",".md":"text/plain"})[extname(path)]??"application/octet-stream";
}
// Route and trust decisions belong to the caller. This adapter supplies only the
// installed lane's requested response policy, never hardware host permissions.
export function resolveInstalledFixtureResponse({request,route,headers={},hashInlineScripts=false,transform}) {
  if(!["GET","HEAD"].includes(request.method)) return {status:405,headers:{Allow:"GET, HEAD"},body:Buffer.alloc(0)};
  try {
    const pathname=decodeURIComponent(fixtureRequestPath(request.url));
    const selected=route(pathname);
    if(!selected) throw Error("route unavailable");
    const file=selected.file ?? "."+pathname;
    const path=fixturePath(selected.root,file);
    const responseHeaders={...headers,"Content-Type":fixtureContentType(path)};
    const bytes=readFileSync(path);
    const body=transform?transform(bytes,path,request):bytes;
    if(hashInlineScripts && extname(path)===".html") responseHeaders["Content-Security-Policy"]=inlineScriptCsp(body);
    return fixtureFileResponse({fixtureRoot:selected.root,route:{file,ranges:true},request,headers:responseHeaders,
      transform(){return body;}});
  } catch { return {status:404,headers:{},body:Buffer.alloc(0)}; }
}
export function installedFixtureHandler(options) {
  return (req,res)=>{
    const request={method:req.method,url:req.url,range:req.headers.range,headers:req.headers};
    const result=resolveInstalledFixtureResponse({...options,request});
    res.writeHead(result.status,result.headers);res.end(result.body);
  };
}
