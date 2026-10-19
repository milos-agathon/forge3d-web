// A consolidated, offline browser equivalent of the final native example workflows.
// Each function performs work and checks its output before returning a review record.
import { requirePixelChange, normalizeDemRgba, changedPixels } from './checks.js';
import { applicationKind, analyzeApplication } from './application-analysis.js';
import { attachOrbitInput } from './interactive-view.js';
/** @param {typeof import('../../types/index.js')} api
 * @param {HTMLCanvasElement} canvas
 * @param {AbortSignal} signal
 * @param {(blob: Blob, name: string) => void} [onOutput]
 * @param {{name?:string,interactive?:boolean}} [example]
 * @param {(owner:{dispose:()=>void,inspect:()=>unknown})=>void} [retain] */
export function createWorkflows(api, canvas, signal, onOutput, example={}, retain) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  /** @type {import('../../types/index.js').CameraInput} */
  let camera = { position: [24, 32, 42], target: [0, 2, 0], up: [0, 1, 0], fovYDegrees: 42, near: .1, far: 500 };
  let heights = Float32Array.from({ length: 256 }, (_, i) => 5 * Math.exp(-((i % 16 - 7) ** 2 + (Math.floor(i / 16) - 7) ** 2) / 30));
  let terrainWidth = 16, terrainHeight = 16, terrainMaterial;
  /** @type {Partial<import('../../types/index.js').TerrainHeightmapInput>} */let terrainSettings={};
  /** @type {[number,number]} */ let domain = [0, 5];
  /** @type {{layers:import('../../types/index.js').MapSceneLayerInput[],frame:import('../../types/index.js').Frame|null,deltas:Record<string,number>,pngSource:any,animation:import('../../types/index.js').CameraAnimation|null,ibl:import('../../types/index.js').IblSnapshot|null,environment:import('../../types/index.js').EnvironmentInput|null,postFx:import('../../types/index.js').PostFxChainInput|null,shadows:import('../../types/index.js').ShadowConfigInput|null}} */
  const state = { layers: [], frame: null, deltas: {}, pngSource: null, animation: null,ibl:null,environment:null,postFx:null,shadows:null };
  let application,overlayImage,meshPrototype,simulationTime=0,pointBounds,pointOrbit;
  /** @returns {import('../../types/index.js').TerrainHeightmapInput} */
  const input = () => ({ width: terrainWidth, height: terrainHeight, heights: heights.slice(), spacing: [24 / (terrainWidth - 1), 24 / (terrainHeight - 1)], bounds: [-12, -12, 12, 12], domain, crs: 'LOCAL', ...terrainSettings, ...(terrainMaterial ? {material:terrainMaterial} : {}) });
  const image = () => ({ width: 4, height: 4, data: Uint8Array.from({ length: 64 }, (_, i) => i % 4 === 3 ? 255 : i % 4 === 0 ? 210 : 90) });
  const transform = (x, y, z, s = 1) => new Float32Array([s, 0, 0, x, 0, s, 0, y, 0, 0, s, z, 0, 0, 0, 1]);
  /** @param {import('../../types/index.js').MapSceneLayerInput[]} [layers]
   * @returns {import('../../types/index.js').SceneRecipeInput} */
  const recipe = (layers = []) => ({ crs: 'LOCAL', terrain: { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: input() } }, camera,
    lighting: { name: 'daylight' }, output: { width: 192, height: 128 }, reproducibility: { seed: 23 }, runtimeOptions: { clearColor: [.02, .03, .05, 1] }, layers,
    ...(state.ibl?{ibl:state.ibl}:{}),...(state.environment?{environment:state.environment}:{}),...(state.postFx?{postFx:state.postFx}:{}),...(state.shadows?{shadows:state.shadows}:{}),timeSeconds:simulationTime });
  /** @returns {import('../../types/index.js').VectorLayerInput} */
  const vectorData = () => {
    if(application?.kind==='travel'||application?.kind==='city'){
      const times=Object.values(application.evidence.seconds),max=Math.max(...times),cmap=api.colormaps.get('forge3d:viridis');
      /** @type {import('../../types/index.js').VectorFeature[]} */const features=[];
      for(const [i,time]of times.slice(1).entries()){const c=cmap.sample(time/max);features.push({id:23+i,kind:'line',positions:[[-8+i*4,6,-6],[-4+i*4,6,6]],properties:{travelSeconds:time},style:{lineWidth:4,color:[c[0],c[1],c[2],c[3]]}});}
      features.push({id:100,kind:'point',position:[-8+Math.min(simulationTime/2,1)*16,7,0],style:{pointSize:12,color:[1,.5,.05,1]}});
      return {name:'routes',features};
    }
    return { name: 'rivers', features: [{ id: 23, kind: 'line', positions: [[-9, 6, -2], [0, 6, 2], [9, 6, -2]], style: { lineWidth: 4, color: [.1, .4, 1, 1] } }] };
  };
  /** @returns {import('../../types/index.js').VectorOverlayInput} */
  const vectorLayer = () => ({ kind: 'vector', layerId: 'rivers', source: { id: 'rivers', format: 'vector', crs: 'LOCAL', data: vectorData() } });
  /** @returns {import('../../types/index.js').MapSceneLabelLayerInput} */
  const labelLayer = () => ({ kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'summit', text: 'Summit', geometry: { type: 'Point', coordinates: [32, 24, 0] } }] }, style: { fontSize: 14, color: [1, 1, 1, 1], haloWidth: 0 } });
  /** @param {import('../../types/index.js').MapSceneLayerInput[]} [layers] @param {boolean} [publish] */
  async function render(layers = [], publish = true) {
    for (const layer of layers) { state.layers = state.layers.filter(l => l.layerId !== layer.layerId); state.layers.push(layer); }
    const scene = new api.MapScene(recipe(state.layers));
    try {
      const result = await scene.render({ signal });
      check(result.metrics.coveragePixels > 500, 'Rendered frame has no covered surface');
      check(layers.every(l => result.executedLayerIds.includes(l.layerId)), 'A requested layer did not execute');
      for (const layer of layers) {
        const control = new api.MapScene(recipe(state.layers.filter(l => l.layerId !== layer.layerId)));
        try { const base = await control.render({signal}); state.deltas[layer.layerId] = requirePixelChange(base.frame.data, result.frame.data, layer.layerId); }
        finally { control.dispose(); }
      }
      state.frame = result.frame;
      canvas.width = result.frame.width; canvas.height = result.frame.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.frame.data), result.frame.width, result.frame.height), 0, 0);
      if(publish)onOutput?.(await result.frame.toPng(), 'scene.png');
      return { frame: result.frame, coveragePixels: result.metrics.coveragePixels, layers: result.executedLayerIds, changedPixels: {...state.deltas} };
    } finally { scene.dispose(); check(scene.getMemoryReport().cpuBytes === 0 && scene.getMemoryReport().gpuBytes === 0, 'MapScene disposal retained memory'); }
  }
  /** @template T @param {(runtime: import('../../types/index.js').Forge3DRuntime) => Promise<T>} work */
  async function withRuntime(work) {
    const element = document.createElement('canvas'); element.width = 192; element.height = 128;
    const runtime = await api.Forge3DRuntime.create(element, { width: 192, height: 128, devicePixelRatio: 1 });
    try {
      runtime.setTerrain(input()); runtime.setCamera(camera); runtime.render();
      if(state.ibl)runtime.setIbl(state.ibl);
      if(state.environment)runtime.setEnvironment(state.environment);
      if(state.postFx)runtime.setPostFx(state.postFx);
      const result = await work(runtime), pixels = await runtime.readRgba();
      state.frame = new api.Frame(192,128,pixels);
      canvas.width = 192; canvas.height = 128;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 192, 128), 0, 0);
      return result;
    }
    finally { runtime.dispose(); element.remove(); }
  }
  const animation = () => new api.CameraAnimation([
    { time: 0, phiDeg: 20, thetaDeg: 45, radius: 40, fovDeg: 42, target: [0, 2, 0] },
    { time: 1, phiDeg: 65, thetaDeg: 50, radius: 36, fovDeg: 42, target: [0, 2, 0] },
  ]);
  async function* pipelineFrames() {
    const original=camera, path=state.animation??animation(),baseEnvironment=state.environment?structuredClone(state.environment):null;
    const frames=application?.framePlan??Array.from({length:3},()=>null);
    try {for(let index=0;index<frames.length;index++){
      const time=index/2,s=path.evaluate(index/Math.max(1,frames.length-1)*path.getKeyframes().at(-1).time);camera={...original,position:api.cameraStateEye(s),target:s.target??original.target,fovYDegrees:s.fovDeg};
      simulationTime=time;
      if(baseEnvironment)state.environment={...baseEnvironment,volumes:baseEnvironment.volumes?.map(v=>({...v,bounds:[v.bounds[0]+time*.5,v.bounds[1],v.bounds[2]+time*.2,v.bounds[3]+time*.5,v.bounds[4],v.bounds[5]+time*.2]})),water:baseEnvironment.water?.map(w=>({...w,height:(w.height??0)+(/flood/.test(example.name??'')?time*.6:0)}))};
      if(application?.kind==='travel'||application?.kind==='city')for(const layer of state.layers)if(layer.kind==='vector'&&layer.layerId==='rivers')layer.source.data=vectorData();
      const plan=frames[index];if(plan){
        const base=Number(plan.scene.slice(-1)),peer=plan.peer?Number(plan.peer.slice(-1)):base,tint=base*(1-plan.alpha)+peer*plan.alpha;
        for(const layer of state.layers)if(layer.kind==='raster')layer.source.data={width:4,height:4,data:Uint8Array.from({length:64},(_,i)=>i%4===3?255:Math.round(40+tint*55+(i%4)*25))};
      }
      const result=await render();yield {index,time,timestampUs:api.frameTimestampUs(index,2),durationUs:500000,camera,frame:result.frame};
    }}finally{camera=original;simulationTime=0;state.environment=baseEnvironment;}
  }
  const workflows = {
    async application() {
      const kind=applicationKind(example.name??'');check(kind,'No regional analysis contract for '+example.name);
      const oracle=await (await fetch(new URL('./applications.json',import.meta.url),{signal})).json();application=analyzeApplication(kind,oracle);
      terrainWidth=application.width;terrainHeight=application.height;const min=Math.min(...application.terrain),max=Math.max(...application.terrain);
      heights=Float32Array.from(application.terrain,v=>5*(v-min)/Math.max(max-min,1e-6));
      const low=Math.min(...application.scalar),high=Math.max(...application.scalar),cmap=api.colormaps.get('forge3d:viridis');
      const rgba=new Uint8Array(64);application.scalar.forEach((v,i)=>{const hex=application.colors?.[i],rgb=hex?[1,3,5].map(j=>parseInt(hex.slice(j,j+2),16)):cmap.sample((v-low)/Math.max(high-low,1e-6)).slice(0,3).map(c=>Math.round(c*255));rgba.set([...rgb,255],i*4);});
      overlayImage={width:4,height:4,data:rgba};
      return {kind,sourceExample:example.name,samples:heights.length,feeds:['terrain','raster',...(kind==='solar'||kind==='city'?['buildings']:[]),...(kind==='population'?['scatter']:[]),...(kind==='satellite'?['animation','video']:[])],...application.evidence};
    },
    async esm() { check(typeof api.Forge3DRuntime.create === 'function', 'ESM export resolution failed'); return { exports: Object.keys(api).length }; },
    async terrain() {
      const dataset = api.TerrainDataset.fromArray(input());
      const statistics = dataset.statistics, slopes = dataset.slopeAspect();
      check(statistics.max > statistics.min && slopes.slopeRadians.length === heights.length, 'Terrain statistics/analysis failed');
      check(dataset.toTerrainInput().heights.length === heights.length, 'Terrain conversion lost samples');
      return { min: statistics.min, max: statistics.max, slopeCells: slopes.slopeRadians.length };
    },
    async png() {
      const source = state.frame ? {width:state.frame.width,height:state.frame.height,data:state.frame.data} : state.pngSource ?? image(), blob = await api.arrayToPng({ ...source, channels: 4 }), output = await api.pngToArray(blob);
      check(output.data.every((v, i) => v === source.data[i]), 'PNG round trip changed RGBA bytes');
      onOutput?.(blob, 'roundtrip.png');
      return { bytes: blob.size, width:source.width, height:source.height, exact: true, fromRenderedFrame:!!state.frame };
    },
    async singleTile() {
      const registry = new api.DatasetRegistry();
      try {
        const dem = await registry.miniDem({signal}), data = normalizeDemRgba(dem.data);
        const blob = await api.arrayToPng({width:dem.width,height:dem.height,data,channels:4});
        const oracle = await api.pngToArray(await (await fetch(new URL('./terrain-single-tile.png',import.meta.url),{signal})).blob());
        check(oracle.data.length === data.length && oracle.data.every((v,i)=>v===data[i]), 'Original single-tile normalization differs from NumPy oracle');
        state.pngSource = {width:dem.width,height:dem.height,data}; onOutput?.(blob,'terrain-single-tile.png');
        return {samples:dem.data.length,width:dem.width,height:dem.height,oracleExact:true,bytes:blob.size};
      } finally {registry.dispose();}
    },
    async presets() {
      const names = api.rendererPresetNames();
      for (const name of names) api.RendererConfig.preset(name).copy().validate();
      const originals=await (await fetch(new URL('./presets.json',import.meta.url),{signal})).json(), applied={};
      for(const [name,preset] of Object.entries(originals)) {
        const p=preset.pbr??preset.cli_params;
        const config=new api.RendererConfig({sampleCount:p.msaa??1,lighting:{exposure:p.exposure},shading:{normalMaps:(p.normal_strength??1)>0},shadows:{enabled:true,technique:p.shadow_technique??p.shadows,mapSize:p.shadow_map_res??2048,cascades:p.cascades??1}});
        terrainMaterial={...api.getTerrainMaterialDefaults(),triplanar:{normalStrength:p.normal_strength??1}};
        terrainSettings={heightAo:{enabled:preset.height_ao?.enabled??false},sunVisibility:{enabled:preset.sun_visibility?.enabled??false},overlays:{enabled:preset.overlay?.enabled??true,layers:[]},exaggeration:p.z_scale??1};
        if(p.cam_phi!==undefined){
          /** @type {import('../../types/index.js').CameraState} */
          const orbit={phiDeg:p.cam_phi,thetaDeg:p.cam_theta,radius:40,fovDeg:p.cam_fov,target:[0,2,0]};
          camera={...camera,position:api.cameraStateEye(orbit),fovYDegrees:p.cam_fov};
        }
        const target=new OffscreenCanvas(192,128),scene=new api.Forge3DScene();let session;
        try {
          session=await api.Forge3DSession.create(target,{runtime:{width:192,height:128,devicePixelRatio:1},renderer:config});
          scene.addTerrain(input());
          if(p.sun_azimuth!==undefined){const a=p.sun_azimuth*Math.PI/180,e=p.sun_elevation*Math.PI/180;scene.addLight({type:'directional',direction:[-Math.sin(a)*Math.cos(e),-Math.sin(e),Math.cos(a)*Math.cos(e)],intensity:p.sun_intensity,color:[1,1,1]});}
          const ibl=await api.ImageBasedLighting.fromLinear({width:2,height:1,data:new Float32Array([.4,.5,.6,1,.6,.5,.4,1])},{quality:'low',intensity:p.ibl_intensity??1,prefilter:'native'});
          const prepared=await ibl.prepare(session);state.ibl=prepared.snapshot();scene.setImageBasedLighting(prepared);
          session.setScene(scene);session.setCamera(camera);session.render();
          const pixels=await session.readRgba(),clear=new Uint8Array(pixels.length);for(let i=3;i<clear.length;i+=4)clear[i]=255;
          const coverage=requirePixelChange(clear,pixels,'Applied preset');
          check(session.getConfig().toJSON().lighting.exposure===p.exposure,'Native preset exposure was not applied');
          const terrainNode=scene.snapshot().nodes.find(n=>n.node.kind==='terrain').node;if(terrainNode.kind!=='terrain')throw Error('Preset lost its terrain');const committed=terrainNode.terrain;
          check(committed.heightAo.enabled===(preset.height_ao?.enabled??false)&&committed.sunVisibility.enabled===(preset.sun_visibility?.enabled??false),'Native preset analysis flags were not applied');
          applied[name]={exposure:p.exposure,iblIntensity:p.ibl_intensity??1,msaa:p.msaa??1,normalStrength:p.normal_strength??1,camera:camera,coveragePixels:coverage,heightAo:committed.heightAo.enabled,sunVisibility:committed.sunVisibility.enabled,overlays:committed.overlays.enabled,disabledFamilies:Object.keys(preset).filter(k=>preset[k]?.enabled===false)};
          state.frame=new api.Frame(192,128,pixels);onOutput?.(await state.frame.toPng(),name.split('/').at(-1)+'.png');
        }finally{session?.dispose();scene.dispose();}
      }
      return { names, applied };
    },
    async render() { const r = await render(); return { coveragePixels: r.coveragePixels }; },
    async raster() {
      const r = await render([{ kind: 'raster', layerId: 'landcover', source: { id: 'landcover', format: 'rgba', crs: 'LOCAL', data: overlayImage??image() }, options: { opacity: .6, blendMode: 'multiply' } }]);
      return { layers: r.layers, coveragePixels: r.coveragePixels,changedPixels:r.changedPixels.landcover,analysis:application?.kind??null };
    },
    async vectors() { const r = await render(state.layers.some(l=>l.kind==='vector')?[]:[vectorLayer()]); return { layers: r.layers, coveragePixels: r.coveragePixels,changedPixels:r.changedPixels }; },
    async labels() {
      const layer = await api.LabelLayer.create();
      try {
        const added = layer.addLabel('Summit', [32, 24, 0]);
        const line = layer.addLineLabel('ROAD', [[10, 80, 0], [160, 80, 0]]);
        const curved = layer.addCurvedLabel('Curved', [[0, 0, 0], [10, 10, 0], [20, 0, 0]]);
        const terrain = layer.addLineLabel('Terrain', [[0, 0, 0], [100, 0, 0]], {}, 'terrain');
        const callout = layer.addCallout('Peak', [80, 30, 0]);
        layer.setTypography({ tracking: .05, kerning: true, lineHeight: 1.2 });
        layer.setDeclutterAlgorithm('annealing', { seed: 123 });
        check(added.ok && line.ok && callout.ok && !curved.ok && curved.diagnostics.length > 0, 'Label API truth contract changed');
        layer.setLabelsEnabled(false); check(!layer.enabled, 'Label visibility change failed'); layer.setLabelsEnabled(true);
        const placement = layer.render({ viewport: { width: 192, height: 128 } });
        check(placement.glyphCount > 0, 'Labels emitted no glyph geometry');
        const r = await render([...(state.layers.some(l=>l.kind==='vector')?[]:[vectorLayer()]),...(state.layers.some(l=>l.kind==='labels')?[]:[labelLayer()])]);
        return { layers: r.layers, coveragePixels: r.coveragePixels, curved: curved.diagnostics.map(d => d.code), terrain: terrain.diagnostics.map(d => d.code), glyphs: placement.glyphCount };
      } finally { layer.dispose(); check(layer.memoryReport().cpuBytes === 0, 'Label disposal retained memory'); }
    },
    async mapscene() {
      const r = await render([...(state.layers.some(l=>l.kind==='vector')?[]:[vectorLayer()]),...(state.layers.some(l=>l.kind==='labels')?[]:[labelLayer()])]); return { layers: r.layers, coveragePixels: r.coveragePixels,changedPixels:r.changedPixels };
    },
    async buildings() {
      if(application?.kind==='solar'||application?.kind==='city'){
        const features=Array.from({length:4},(_,i)=>{const x=(i%2)*8-6,z=Math.floor(i/2)*8-6;return {type:'Feature',id:'roof-'+i,properties:{height:6+i,'roof:shape':'flat','building:colour':application?.kind==='solar'?(application.evidence.factors[i]>.9?'#f3b34b':'#4474b4'):'#ccaa88'},geometry:{type:'Polygon',coordinates:[[[x,z],[x+3,z],[x+3,z+3],[x,z+3],[x,z]]]}};});
        const layer=api.parseGeoJsonBuildings({type:'FeatureCollection',features},{crs:'LOCAL'});
        try{const r=await render([{kind:'buildings',layerId:'buildings',source:{id:'buildings',format:'buildings',crs:'LOCAL',data:layer.buildings()}}]);return {buildings:layer.buildingCount,layers:r.layers,changedPixels:r.changedPixels.buildings,analysis:application.kind};}finally{layer.dispose();}
      }
      const mesh = api.generatePrimitive('box');
      const r = await render([{ kind: 'buildings', layerId: 'buildings', source: { id: 'buildings', format: 'buildings', crs: 'LOCAL', data: [{ id: 'warehouse', mesh }] }, transforms: transform(1, 6, 0, 3) }]);
      return { layers: r.layers, coveragePixels: r.coveragePixels,changedPixels:r.changedPixels.buildings };
    },
    async mesh() {
      const mesh = api.generatePrimitive('box'), encoded = await api.exportMesh(mesh, 'obj');
      meshPrototype=mesh;
      check(encoded.size > 100 && api.meshBounds(mesh).max[0] > api.meshBounds(mesh).min[0], 'Mesh export failed');
      onOutput?.(encoded, 'mesh.obj');
      if(application?.kind==='population')return {vertices:mesh.positions.length/3,objBytes:encoded.size,prototypeForScatter:true};
      const r = await render([{kind:'mesh',layerId:'mesh',source:{id:'mesh',format:'mesh',crs:'LOCAL',data:mesh},transforms:transform(0,7,0,4)}]);
      return { vertices: mesh.positions.length / 3, objBytes: encoded.size, changedPixels:r.changedPixels.mesh };
    },
    async triangle() {
      const mesh = {positions:new Float32Array([-8,6,0,8,6,0,0,16,0]),indices:new Uint32Array([0,1,2]),normals:new Float32Array([0,0,1,0,0,1,0,0,1])};
      const r = await render([{kind:'mesh',layerId:'triangle',source:{id:'triangle',format:'mesh',crs:'LOCAL',data:mesh}}]);
      onOutput?.(await r.frame.toPng(),'triangle.png');
      return {triangles:1,changedPixels:r.changedPixels.triangle,pngFromRenderedTriangle:true};
    },
    async scatter() {
      const mesh = meshPrototype??api.generatePrimitive('box');
      const transforms=application?.kind==='population'?application.scalar.map((v,i)=>{
        const x=i%4*4-6,z=Math.floor(i/4)*4-6,bounds=api.meshBounds(mesh),height=Math.max(.5,v*.8),sy=height/(bounds.max[1]-bounds.min[1]);
        const ground=new api.TerrainRigSource({heights,width:terrainWidth,height:terrainHeight,terrainWidth:24}).heightAt(x+12,z+12);
        return [.5,0,0,x,0,sy,0,ground-bounds.min[1]*sy,0,0,.5,z,0,0,0,1];
      }):[...transform(-4, 6, 0, 2),...transform(4,6,0,3)];
      const packed=new Float32Array(transforms.flat());
      const r = await render([{ kind: 'scatter', layerId: 'population', batches: [{ name: 'population', levels: [{ mesh }], transforms:packed, color: [.2, .8, .4, 1] }] }]);
      return { instances: packed.length/16, layers: r.layers,changedPixels:r.changedPixels.population,analysis:application?.kind??null };
    },
    async crs() {
      const crs = await api.CrsTransformer.create();
      try {
        const projected = await crs.transformCoords([[9, 40]], 'EPSG:4326', 'EPSG:32632');
        const back = await crs.transformCoords(new Float64Array(projected.flat()), 'EPSG:32632', 'EPSG:4326');
        check(Math.abs(projected[0][0] - 500000) < .01 && Math.abs(back[1] - 40) < 1e-7, 'CRS control failed');
        return { projected, roundTrip: back };
      } finally { crs.dispose(); }
    },
    async datasets() {
      const registry = new api.DatasetRegistry();
      try { const dem = await registry.miniDem({ signal }); const boundaries = await registry.sampleBoundaries({ signal });
        check(dem.data.length > 0 && boundaries.type === 'FeatureCollection', 'Bundled datasets failed');
        terrainWidth = dem.width; terrainHeight = dem.height;
        let min = Infinity, max = -Infinity; for(const v of dem.data){min=Math.min(min,v);max=Math.max(max,v);}
        heights = Float32Array.from(dem.data,v=>5*(v-min)/Math.max(max-min,1e-6)); domain=[0,5];
        return { samples: dem.data.length, features: boundaries.features.length, feedsTerrain:true };
      } finally { registry.dispose(); }
    },
    async style() {
      const original = await (await fetch(new URL('./sample-style.json', import.meta.url), { signal })).json();
      const style = new api.StyleSpec(original), report = api.validateStyleSupport(style.toJSON());
      check(style.toJSON().layers.length > 0, 'Restored native style is empty');
      check(report.diagnostics.some(d=>d.code==='unsupported_style_layer_type'&&d.layer_id==='background') && report.diagnostics.some(d=>d.code==='experimental_feature'),'Native style diagnostics were lost');
      /** @type {import('../../types/index.js').VectorFeature[]} */
      const features=[...vectorData().features.map(f=>({...f,properties:{railway:'rail','$type':'LineString'}})),{id:24,kind:'point',position:[5,7,0],properties:{name:'Station','$type':'Point'}}];
      const compiled = api.compileStyle(style, {rail:features}, { crs: 'LOCAL' });
      const labels=api.styleLabelRecords(original.layers.find(l=>l.type==='symbol'),features);
      check(labels.length===1&&labels[0].text==='Station','Native symbol conversion lost station labels');
      const rendered = await render([...compiled.layers,{kind:'labels',layerId:'station-labels',source:{id:'station-labels',format:'labels',crs:'LOCAL',data:labels},style:api.styleToLabelStyle(original.layers.find(l=>l.type==='symbol'))}]);
      check(compiled.layers.some(l=>l.layerId==='rail-lines')&&compiled.layers.some(l=>l.layerId==='stations'),'Restored style layers did not compile');
      return { layers: original.layers.length, support: report.toJSON(), executedLayers: rendered.layers, changedPixels:rendered.changedPixels, symbolLabels:labels.length, adaptation:'Geometry type is supplied as the native legacy $type filter property; symbols use explicit label conversion.' };
    },
    async diagnostics() {
      const entries = api.getMapSceneSupportMatrix();
      check(entries.length > 0, 'No support matrix');
      const scene = new api.MapScene(recipe([{ kind: 'point-cloud', layerId: 'unsupported-cloud', source: { id: 'cloud', format: 'pointcloud', crs: 'LOCAL', data: { positions: new Float32Array([0, 0, 0]) } } }]));
      try { const report = scene.validate(); check(report.toJSON().diagnostics.some(d => d.severity === 'error'), 'Unsupported MapScene point cloud reported success'); return { supportEntries: entries.length, report: report.toJSON() }; }
      finally { scene.dispose(); }
    },
    async bundle() {
      const scene = new api.MapScene(recipe(state.layers.length?state.layers:[vectorLayer()])); let loaded;
      try { await scene.prepare({ signal }); const blob = await scene.saveBundle({ signal }); loaded = await api.MapScene.loadBundle(blob, { signal }); onOutput?.(blob, 'scene.forge3d');
        const r = await loaded.render({ signal }); check((state.layers.length?state.layers:[vectorLayer()]).every(l=>r.executedLayerIds.includes(l.layerId)), 'Bundle lost a pipeline layer');
        return { bytes: blob.size, restoredLayers: r.executedLayerIds };
      } finally { loaded?.dispose(); scene.dispose(); }
    },
    async colormaps() {
      const cmap = api.colormaps.get('forge3d:viridis');
      const colors = [0, .5, 1].map(t => cmap.sample(t));
      check(JSON.stringify(colors[0]) !== JSON.stringify(colors[2]), 'Colormap collapsed');
      return { colors };
    },
    async furniture() {
      const r = state.frame ? {frame:state.frame} : await render(), plate = new api.MapPlate({ width: 320, height: 240, margin: [24, 64, 24, 16] }), vectors = new api.VectorScene();
      try {
        plate.setMapRegion(r.frame, new api.BBox(0, 0, 24000, 24000, 'LOCAL'));
        plate.addLegend(await new api.Legend(api.colormaps.get('forge3d:viridis'), [0, 5], { barHeight: 72, fontSize: 10 }).render());
        plate.addScaleBar(await new api.ScaleBar(125, { widthPx: 100, fontSize: 10 }).render());
        plate.addNorthArrow(await new api.NorthArrow({ size: 32 }).render());
        vectors.addPolygon([[0, 0], [100, 0], [100, 60], [0, 60]], { fillColor: [.2, .6, .4, 1] }).addLabel('Map', [50, 30], { fontSize: 12 });
        const options = { width: 200, height: 120, bounds: new api.Bounds(0, 0, 100, 60) };
        const png = await plate.exportPng(), svg = await api.exportSvg(vectors, options), pdf = await api.exportPdf(vectors, options);
        onOutput?.(png, 'plate.png'); onOutput?.(svg, 'vectors.svg'); onOutput?.(pdf, 'vectors.pdf');
        check(png.size > 100 && api.validateSvg(await svg.text()) && pdf.size > 100, 'Cartographic export empty or invalid'); return { pngBytes: png.size, svgBytes: svg.size, pdfBytes: pdf.size };
      } finally { plate.dispose(); vectors.dispose(); }
    },
    async animation() {
        const timestamps = []; for await (const rendered of pipelineFrames()) { timestamps.push(rendered.timestampUs); onOutput?.(await rendered.frame.toPng(), `frame-${rendered.index}.png`); }
        check(timestamps.every((t,i)=>t===api.frameTimestampUs(i,2)), 'Frame sequence is not deterministic'); return { timestamps,sourceFrames:application?.framePlan?.length??3 };
    },
    async video() {
        try { const result = await api.encodeVideo(pipelineFrames(), { fps: 2, container: 'mp4', signal });
          check(result.blob.size > 100, 'Video mux produced an empty file'); onOutput?.(result.blob, 'animation.mp4'); return { bytes: result.blob.size, mime: result.blob.type,frameCount:result.frameCount,timestamps:result.timestampsUs,codec:result.codec };
        } catch (error) { if (error.code !== 'UNSUPPORTED_FEATURE' || error.details?.reason !== 'codec-unavailable') throw error; return { status:'unavailable', unavailable: { code: error.code, reason: error.details.reason } }; }
    },
    async rigs() {
      const source = new api.TerrainRigSource({ heights, width: terrainWidth, height: terrainHeight, terrainWidth: 24 });
      const rigs = {
        orbit:new api.TerrainOrbitRig({ targetXZ: [12, 12], radius: 8, duration: 1, phiStartDeg: 0, phiEndDeg: 90, thetaStartDeg: 45, clearance: { minimumHeight: 2 } }),
        rail:new api.TerrainRailRig({pathXZ:[[4,8],[20,16]],duration:1,cameraHeightOffset:8,lookAheadDistance:3,fovDeg:45,clearance:{minimumHeight:2}}),
        follow:new api.TerrainTargetFollowRig({targetPathXZ:[[6,6],[18,18]],duration:1,radius:5,thetaDeg:45,headingOffsetDeg:180,clearance:{minimumHeight:2}}),
      };
      const results = {};
      for(const [name,rig] of Object.entries(rigs)) {
        const path = rig.bake(source,{samplesPerSecond:4}); let minimumClearance=Infinity;
        for(let t=0;t<=1;t+=.125){const eye=api.cameraStateEye(path.evaluate(t));minimumClearance=Math.min(minimumClearance,eye[1]-source.heightAt(eye[0],eye[2]));}
        check(path.getKeyframes().length>1 && minimumClearance>=2-api.TERRAIN_CLEARANCE_TOLERANCE,'Rig clearance failed: '+name);
        results[name]={keyframes:path.getKeyframes().length,minimumClearance};
        if(name==='orbit')state.animation=new api.CameraAnimation(path.toJSON().keyframes.map(k=>({...k,target:[k.target[0]-12,k.target[1],k.target[2]-12]})));
      }
      return results;
    },
    async materials() {
      const before=(await render()).frame.data;
      terrainMaterial={ ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .3, altitudeBlend: .2 } } };
      const after=await render(),changed=requirePixelChange(before,after.frame.data,'Materials');
      state.shadows={enabled:true,filter:'pcf'};await render();
      return {bytes:after.frame.data.length,changedPixels:changed,shadowConfig:state.shadows};
    },
    async ibl() {
      const header=new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'),bytes=new Uint8Array(header.length+32);bytes.set(header);
      for(let i=0;i<8;i++)bytes.set([160-i*10,100+i*8,70,129],header.length+i*4);
      const hdr=await api.ImageBasedLighting.fromRGBE(bytes,{quality:'low',intensity:1,prefilter:'native'});
      return withRuntime(async runtime=>{const before=await runtime.readRgba(),prepared=await hdr.prepare(runtime);state.ibl=prepared.snapshot();runtime.setIbl(state.ibl);runtime.render();const after=await runtime.readRgba();return {source:'Radiance RGBE',prepared:prepared.prepared,changedPixels:requirePixelChange(before,after,'HDR IBL')};});
    },
    async effects() {
      return withRuntime(async runtime=>{
        const baseline=await runtime.readRgba(),layers=new api.VectorLayers();
        try {
          /** @type {import('../../types/index.js').VectorFeature[]} */
          const features=[{id:1,kind:'point',position:[0,8,0],style:{shape:'square',pointSize:48,color:[1,0,0,.45]}},{id:2,kind:'point',position:[0,8,.1],style:{shape:'square',pointSize:48,color:[0,0,1,.6]}}];
          const handle=layers.add({name:'alpha',features});layers.setOit('wboit');runtime.setVectorLayers(layers);runtime.render();const forward=await runtime.readRgba();
          handle.update({features:[...features].reverse()});runtime.setVectorLayers(layers);runtime.render();const reverse=await runtime.readRgba();
          check(changedPixels(forward,reverse,1)===0,'Weighted OIT depends on draw order');
          check(runtime.getVectorReport().effectiveOit==='wboit','Weighted OIT did not execute');
          state.postFx={effects:[{kind:'taa',historyWeight:.8}]};runtime.setPostFx(state.postFx);
          for(let frame=0;frame<4;frame++){runtime.setCamera({...camera,position:[camera.position[0]+frame*.02,camera.position[1],camera.position[2]]});runtime.render();await runtime.readRgba();}
          const report=runtime.getPostFxReport();check(report.enabled&&report.passOrder.some(p=>p.includes('taa'))&&report.historyValid&&report.historyFrames>=3,'TAA did not accumulate temporal history');
          return {oit:'wboit',orderIndependent:true,changedPixels:requirePixelChange(baseline,forward,'Transparent vectors'),taaFrames:4,postFx:report};
        }finally{layers.dispose();}
      });
    },
    async environment() {
      const sun = api.sunPosition(52, 4, '2026-06-21T12:00:00Z');
      const haze = await api.generateDensityVolume({ preset:application?.kind==='weather'?'plume':'localized_haze', bounds: [-12, 0, -12, 12, 10, 12], dimensions: [8, 8, 8], densityScale: 2, wind:[2,0,.5], seed: 23 });
      const environment = new api.Forge3DEnvironment({ sunClock: { latitude: 52, longitude: 4, unixSeconds: Date.parse('2026-06-21T12:00:00Z') / 1000, timeScale: /daycycle|transit|solar/.test(example.name??'')?6*3600:1 }, sky: { model: 'hosek-wilkie', turbidity: 2 }, fog: { mode: 'height', density: .01 }, clouds: { mode: 'hybrid', preset: 'gentle', height: 40, thickness: 20,wind:[2,.5],animationSpeed:1, seed: 23 }, volumes: [haze] });
      const before=(await render()).frame.data;state.environment=environment.snapshot();const after=await render();return {sun,bytes:after.frame.data.length,changedPixels:requirePixelChange(before,after.frame.data,'Environment')};
    },
    async water() {
      state.environment??=new api.Forge3DEnvironment({}).snapshot();
      const before=(await render()).frame.data;state.environment={...state.environment,water:[{bounds:[-12,-12,12,12],height:2,mode:'animated'}]};const after=await render();return {bytes:after.frame.data.length,changedPixels:requirePixelChange(before,after.frame.data,'Water')};
    },
    async viewer() {
      if(pointBounds){
        const center=pointBounds.min.map((v,i)=>(v+pointBounds.max[i])/2),extent=Math.max(...pointBounds.min.map((v,i)=>pointBounds.max[i]-v),1);
        pointOrbit=new api.OrbitController({target:[center[0],center[1],center[2]],distance:extent*1.8,yawDegrees:20,pitchDegrees:30,near:extent*.0001,far:extent*10,fovYDegrees:45});
        const result=await workflows.pointcloud(),png=await state.frame.toPng();onOutput?.(png,'pointcloud-viewer.png');
        if(example.interactive&&retain)retain(attachOrbitInput(canvas,pointOrbit,()=>workflows.pointcloud(),signal));
        return {pngBytes:png.size,viewerContent:'pointcloud',points:result.points,coveredPixels:result.coveredPixels};
      }
      if(state.layers.length){
        const target=camera.target,dx=camera.position[0]-target[0],dy=camera.position[1]-target[1],dz=camera.position[2]-target[2];
        const orbit=new api.OrbitController({target,distance:Math.hypot(dx,dy,dz),yawDegrees:Math.atan2(dx,dz)*180/Math.PI,pitchDegrees:Math.atan2(dy,Math.hypot(dx,dz))*180/Math.PI,near:camera.near,far:camera.far,fovYDegrees:camera.fovYDegrees});
        const before=(await render()).frame;orbit.orbitBy(12,3);camera=orbit.getCamera();const after=await render();
        const delta=requirePixelChange(before.data,after.frame.data,'Interactive composed view');
        if(example.interactive&&retain)retain(attachOrbitInput(canvas,orbit,async next=>{camera=next;await render([],false);},signal));
        return {pngBytes:(await after.frame.toPng()).size,viewerContent:'mapscene',layers:after.layers,orbitChangedPixels:delta};
      }
      const element = document.createElement('canvas'); element.width = 192; element.height = 128; element.setAttribute('aria-label', 'Migrated interactive viewer'); document.body.append(element);
      let viewer,retained=false;
      try { viewer = await api.Forge3DViewer.create(element, { runtime: { width: 192, height: 128, devicePixelRatio: 1 } }); await viewer.setTerrain(input());viewer.setCamera(camera); const png = await viewer.screenshot(); check(png.size > 100, 'Viewer snapshot empty'); onOutput?.(png, 'viewer.png');
        if(example.interactive&&retain){const live=viewer;element.dataset.workflowViewer='true';retain({dispose:()=>{live.dispose();element.remove();},inspect:()=>({view:live.getView(),disposed:live.disposed,pending:false})});retained=true;}
        return { pngBytes: png.size,viewerContent:'terrain' };
      } finally { if(!retained){viewer?.dispose(); element.remove();} }
    },
    async picking() {
      return withRuntime(async runtime => {
        const layers = new api.VectorLayers(); let picker;
        try { layers.add(vectorData()); runtime.setVectorLayers(layers); runtime.render(); picker = new api.VectorPicker(runtime, layers);
          const hits = await picker.lasso([[0, 0], [192, 0], [192, 128], [0, 128]]); check(hits.some(h => h.id === 23), 'Rich picking did not find rendered river');
          layers.setSelection('selected', hits.map(h => h.id), { outline: true }); runtime.setVectorLayers(layers); runtime.render(); return { selected: hits.map(h => h.id) };
        } finally { picker?.dispose(); layers.dispose(); }
      });
    },
    async pointcloud() {
      const dataset = await api.openLaz(new URL('./autzen.laz', import.meta.url), { signal });
      let renderer, layer;
      try { const root = dataset.rootNode(), points = await dataset.readPoints(root.key, signal), buffer = new api.PointBuffer(points);
        try {
          check(buffer.pointCount > 0 && buffer.createGpuBuffer().length === buffer.pointCount * 6, 'LAZ decode/point-buffer upload failed');
          const bounds = dataset.bounds, center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2), extent = Math.max(...bounds.min.map((v, i) => bounds.max[i] - v), 1), scale = 1.8 / extent;
          pointBounds=bounds;
          /** @type {import('../../types/index.js').PointView} */
          const view = { position: [center[0], center[1], center[2] + extent], viewportHeight: 128, fovY: Math.PI / 4,
            viewProjection: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, -.5 / extent, 0, -center[0] * scale, -center[1] * scale, .5 + center[2] * .5 / extent, 1] };
          if(pointOrbit){const camera=pointOrbit.getCamera();view.position=camera.position;view.viewProjection=[...new api.Camera(camera).viewProjectionMatrix(192/128)];}
          layer = new api.PointCloudLayer(dataset, { pointBudget: 120000, style: { pointSize: 2, colorMode: 'elevation' } });
          await layer.update(view, signal); renderer = await api.PointCloudRenderer.create(new OffscreenCanvas(192, 128),{clearColor:[0,0,0,1]}); renderer.setLayers([layer]); await renderer.render(view, signal);
          const pixels = await renderer.readRgba(signal); let covered = 0;
          for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 20) covered++;
          check(covered > 100, 'Point cloud GPU draw has no coverage');
          canvas.width = 192; canvas.height = 128;
          state.frame=new api.Frame(192,128,pixels);
          canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 192, 128), 0, 0);
          return { points: buffer.pointCount, bytes: buffer.gpuBytes, coveredPixels: covered };
        }
        finally { buffer.dispose(); }
      } finally { renderer?.dispose(); layer?.dispose(); dataset.dispose(); if (renderer) check(renderer.getStats(false).gpuBytes === 0, 'Point renderer disposal retained memory'); }
    },
    async cog() {
      const scheduler = new api.RangeScheduler(), cog = await api.CogDataset.open(new URL('./rainier-cog.tif', import.meta.url), { scheduler,cacheSizeMb:4 });
      try {
        check(cog.overviewCount>1,'COG has no overview pyramid');const overview=cog.selectOverview(2),tile=await cog.readTile(overview,0,0,{signal});
        await cog.readTile(overview,0,0,{signal}); check(cog.stats().cacheHits>0,'COG decoded cache was not exercised');
        const start=performance.now();let grids=0;for(let y=0;y<2;y++)for(let x=0;x<2;x++){await cog.readTile(0,x,y,{signal});grids++;}
        const raw=tile.filter(v=>v!==cog.nodata);let min=Infinity,max=-Infinity;for(const v of raw){min=Math.min(min,v);max=Math.max(max,v);}
        heights=Float32Array.from(tile,v=>v===cog.nodata?0:5*(v-min)/Math.max(max-min,1e-6));terrainWidth=terrainHeight=256;
        const streamed=await withRuntime(async runtime=>{
          let streamer;
          try{streamer=await api.TerrainStreamer.create(runtime,new api.CogHeightSource(cog),{terrain:{bounds:[-12,-12,12,12],spacing:[24/1023,24/1023],domain:[min,max],exaggeration:.004,renderMode:'perspective'},clipmap:{ringCount:4,ringResolution:16,centerResolution:16,baseCellSize:[1,1]},maxResidentBytes:8*1024*1024,autoUpdate:false});
            await streamer.whenConverged({signal,timeoutFrames:120});runtime.setCamera(camera);runtime.render();const pixels=await runtime.readRgba();let covered=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>40)covered++;
            check(covered>100,'Streamed COG terrain has no coverage');return {coveragePixels:covered,...streamer.stats()};
          }finally{streamer?.dispose();}
        });
        const stats=cog.stats();check(stats.memoryUsedBytes<=stats.memoryBudgetBytes,'COG cache exceeded its budget');
        return {values:tile.length,overview,grids,benchmarkMs:performance.now()-start,stats,streamed};
      }
      finally { cog.dispose(); scheduler.dispose(); }
    },
  };
  return workflows;
}
