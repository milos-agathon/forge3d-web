// Admit the bytes served to the browser, not merely the repository filenames.
export async function verifyMigrationInputs() {
  const manifest=await (await fetch(new URL('../../docs/migration-assets.json',import.meta.url))).json();
  const prefix='crates/forge3d-web/examples/migration/';
  // Vite rewrites module import URLs and injects its development client into
  // HTML. Check raw authoring modules there; installed servers check exactly
  // the served JS bytes. Independent API observations check execution in both.
  const authoring=Boolean(document.querySelector('script[src="/@vite/client"]'));
  // Encoded LAZ/COG inputs are hash-checked by the package gate. Fetching a
  // whole COG here would defeat the example's progressive range-read path.
  const inputs=manifest.assets.filter(a=>a.path.startsWith(prefix)&&/\.(js|json)$/.test(a.path));
  if(!inputs.some(a=>a.path===prefix+'workflows.js'))throw Error('Migration integrity manifest omits executable stages');
  for(const asset of inputs){
    const response=await fetch(new URL('./'+asset.path.slice(prefix.length)+(authoring&&asset.path.endsWith('.js')?'?raw':''),import.meta.url));
    if(!response.ok)throw Error('Missing migration input '+asset.path);
    let raw=await response.arrayBuffer();
    if(authoring&&asset.path.endsWith('.js')){
      const module=new TextDecoder().decode(raw),match=/^\s*export default ("(?:\\.|[^"\\])*")/.exec(module);
      if(match)raw=new TextEncoder().encode(JSON.parse(match[1])).buffer;
    }
    const bytes=asset.hashMode==='utf8-lf'?new TextEncoder().encode(new TextDecoder().decode(raw).replace(/\r\n?/g,'\n')):raw;
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(digest!==asset.sha256)throw Error('Migration input integrity mismatch: '+asset.path);
  }
  return {verified:inputs.length,mode:authoring?'raw-authoring-modules':'served-package-bytes'};
}
