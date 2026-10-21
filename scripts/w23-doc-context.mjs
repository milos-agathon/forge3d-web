// Explicit types for application-owned context used by documentation fragments.
// No `any` context: incorrect methods and arguments still fail compilation.
export function documentationContext(ts, parsed, path) {
  const bound = new Set();
  const binding = n => { if (!n) return; if (ts.isIdentifier(n)) bound.add(n.text); else if (ts.isObjectBindingPattern(n)||ts.isArrayBindingPattern(n)) for(const e of n.elements) if(e.name)binding(e.name); };
  const visit = n => { if(ts.isVariableDeclaration(n)||ts.isParameter(n)||ts.isImportSpecifier(n)||ts.isImportClause(n)||ts.isNamespaceImport(n)||ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))binding(n.name);ts.forEachChild(n,visit); };visit(parsed);
  const api = name => `import('@forge3d/web').${name}`;
  const contexts = {
    heights:'Float32Array',data:'Uint8Array',width:'number',height:'number',
    runtime:api('Forge3DRuntime'),session:api('Forge3DSession'),scene:api('Forge3DScene'),viewer:api('Forge3DViewer'),registry:api('CodecRegistry'),chain:api('PostFxChain'),
    hdrFrame:api('HdrFrame'),aovFrame:api('AovFrame'),terrain:api('TerrainHeightmapInput'),mesh:api('ScatterMesh'),
    signal:'AbortSignal',controller:'AbortController',abortController:'AbortController',canvas:'HTMLCanvasElement',file:'File',fileOrBlobOrArrayBufferOrUrl:'Blob',
    x:'number',y:'number',z:'number',pixelX:'number',pixelY:'number',viewProjection:'Float32Array',view:api('PointView'),
    runtimeOrViewer:api('Forge3DRuntime'),materialIndex:'number',hdrBytes:'Uint8Array',
    source:path.includes('terrain-scatter-probes')?`Parameters<typeof import('@forge3d/web').TerrainLightingProbes.bake>[0]`:api('HeightTileSource'),
    display:'(...values: unknown[]) => void',trustedIssuerPublicKeyHex:'string',keyFromYourApplication:'string',styleJson:'string',
    fallback:'[number,number,number,number]',result:api('MapSceneRenderResult'),insetFrame:api('Frame'),
    TerrainLightingProbes:`typeof import('@forge3d/web').TerrainLightingProbes`,TerrainStreamer:`typeof import('@forge3d/web').TerrainStreamer`,
  };
  return Object.entries(contexts).filter(([name])=>!bound.has(name)).map(([name,type])=>`declare const ${name}: ${type};`).join('\n')+'\n';
}
