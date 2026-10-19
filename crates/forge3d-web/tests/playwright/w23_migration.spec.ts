import { test, expect } from "../browser/webgpu-fixture";
import * as ed from '@noble/ed25519';
import { observeStages, assertStageEvidence } from '../browser/w23-stage-observer';
declare global { interface Window { __w23: any } }
for (const source of [true, false]) test(`W23 ${source ? 'source' : 'dist'}: all 54 migrated example workflows execute`, async ({ page }, info) => {
  test.setTimeout(600_000);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/examples/migration/index.html' + (source ? '?source' : ''));
  await page.waitForFunction(() => window.__w23?.ready);
  expect(await page.evaluate(()=>window.__w23.integrity.verified)).toBeGreaterThan(10);
  for(const name of ['sample_style.json','mapscene_vector_labels.py']){
    const unlicensed=await page.evaluate(name=>window.__w23.run(name),name);
    expect(unlicensed.examples[0].status).toBe('blocked-license');
    expect(unlicensed.examples[0].steps.at(-1).error.code).toBe('LICENSE_REQUIRED');
  }
  const secret = ed.utils.randomSecretKey(), publicKey = await ed.getPublicKeyAsync(secret), message = 'F3D-PRO-w23-example-test-20991231';
  const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const license = { publicKey: hex(publicKey), key: message + '-' + hex(await ed.signAsync(new TextEncoder().encode(message), secret)) };
  await page.evaluate(async value => { const { api } = window.__w23; api.configureLicenseIssuer(value.publicKey); await api.setLicenseKey(value.key); }, license);
  await observeStages(page);
  const report = await page.evaluate(() => window.__w23.run('all'));
  const observed=await page.evaluate(()=>window.__w23.observed);
  assertStageEvidence(report.examples,observed);
  for(const stage of ['ibl','effects','rigs'])expect(()=>assertStageEvidence(report.examples,observed.filter((e:any)=>!e.label.includes(': '+stage+'…')))).toThrow();
  await info.attach('w23-independent-stage-observations.json',{body:JSON.stringify(observed,null,2),contentType:'application/json'});
  expect(report.examples).toHaveLength(54);
  expect(new Set(report.examples.map((e: any) => e.name)).size).toBe(54);
  for (const example of report.examples) {
    expect(example.status).toBe('executed');
    expect(example.steps.map((s:any)=>s.workflow)).toEqual(example.workflows);
    expect(example.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const workflow of example.workflows) expect(report.workflows[workflow], example.name + ': ' + workflow).toBeDefined();
  }
  expect(Object.keys(report.workflows).length).toBeGreaterThanOrEqual(33);
  const docs=await page.evaluate(()=>window.__w23.verifyGuideExamples());
  expect(docs.snapshotBytes).toBeGreaterThan(100);
  expect(docs.roundTripBytes).toBeGreaterThan(20);
  expect(docs.snapshotCoverage).toBeGreaterThan(50);
  expect(report.workflows.singleTile.oracleExact).toBe(true);
  expect(report.workflows.triangle.changedPixels).toBeGreaterThan(8);
  expect(report.workflows.rigs.rail.minimumClearance).toBeGreaterThanOrEqual(1.99);
  expect(report.workflows.rigs.follow.minimumClearance).toBeGreaterThanOrEqual(1.99);
  expect(report.workflows.ibl.prepared).toBe(true);
  expect(report.workflows.effects.taaFrames).toBe(4);
  expect(report.workflows.effects.orderIndependent).toBe(true);
  expect(report.workflows.video.bytes).toBeGreaterThan(100);
  expect(report.workflows.video.frameCount).toBe(3);
  const byName=new Map<string,any>(report.examples.map((e:any)=>[e.name,e]));
  const step=(name:string,workflow:string)=>byName.get(name).steps.find((s:any)=>s.workflow===workflow).result;
  expect(step('terrain_single_tile.py','png').width).toBe(256);
  expect(step('quickstart.ipynb','png').fromRenderedFrame).toBe(true);
  expect(step('quickstart.ipynb','png').width).toBe(192);
  expect(step('triangle_png.py','triangle').pngFromRenderedTriangle).toBe(true);
  expect(step('colorado_rem_forge3d.py','raster').analysis).toBe('rem');
  expect(step('belgium_bivariate_climate_map.py','raster').analysis).toBe('bivariate');
  expect(step('barcelona_travel_time_3d.py','application').seconds['3']).toBe(90);
  expect(step('rotterdam_solar_potential_shadow_study.py','buildings').analysis).toBe('solar');
  expect(step('poland_population_spikes_height_shade.py','scatter').instances).toBe(16);
  expect(step('khumbu_icefall_sentinel_timelapse.py','animation').timestamps).toHaveLength(8);
  expect(step('khumbu_icefall_sentinel_timelapse.py','video').frameCount).toBe(8);
  expect(step('sample_style.json','style').executedLayers).toEqual(expect.arrayContaining(['rail-lines','stations','station-labels']));
  expect(report.workflows.png.exact).toBe(true);
  expect(report.workflows.render.coveragePixels).toBeGreaterThan(500);
  expect(report.workflows.animation.timestamps).toEqual([0, 500000, 1000000]);
  expect(report.workflows.pointcloud.points).toBe(110000);
  expect(report.workflows.cog.values).toBe(65536);
  expect(report.workflows.cog.grids).toBe(4);
  expect(report.workflows.cog.streamed.uploadedTiles).toBeGreaterThan(0);
  for(const name of ['materials','environment','water'])expect(report.workflows[name].changedPixels).toBeGreaterThan(8);
  for(const example of report.examples){const material=example.steps.find((s:any)=>s.workflow==='materials');if(material)expect(material.result.shadowControlPixels).toBeGreaterThan(8);const application=example.steps.find((s:any)=>s.workflow==='application');if(application){expect(application.result.source.path).toBe('examples/'+example.name);expect(application.result.operations.length).toBeGreaterThan(0);}}
  expect(report.artifacts.some((a: any) => a.name.endsWith('.png'))).toBe(true);
  expect(report.artifacts.some((a: any) => a.name.endsWith('.pdf'))).toBe(true);
  expect(report.artifacts.some((a: any) => a.name.endsWith('.svg'))).toBe(true);
  expect(report.artifacts.some((a: any) => a.name.endsWith('.forge3d'))).toBe(true);
  const download = await page.evaluate(async () => {
    const link = document.querySelector<HTMLAnchorElement>('#downloads a[download$=".png"]')!;
    const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
    return [...bytes.slice(0, 8)];
  });
  expect(download).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const replay = await page.evaluate(async () => {
    const previous = document.querySelector<HTMLAnchorElement>('#downloads a')!.href;
    await window.__w23.run('png_numpy_roundtrip.py');
    let released = false; try { await fetch(previous); } catch { released = true; }
    return { released, downloads: document.querySelectorAll('#downloads a').length };
  });
  expect(replay).toEqual({ released: true, downloads: 1 });
  const controls=await page.evaluate(async()=>{
    const {api,createWorkflows}=window.__w23,outcomes=[];
    for(const feature of ['materials','environment','water','vectors','shadows']){
      class NoContributionScene extends api.MapScene {
        requested:string[];
        constructor(recipe:any){
          const copy=structuredClone(recipe),requested=(copy.layers??[]).map((l:any)=>l.layerId);
          if(feature==='materials'&&copy.terrain?.source.data)delete copy.terrain.source.data.material;
          if(feature==='environment')delete copy.environment;
          if(feature==='water'&&copy.environment)delete copy.environment.water;
          if(feature==='vectors')copy.layers=copy.layers.filter((l:any)=>l.kind!=='vector');
          if(feature==='shadows')delete copy.shadows;
          super(copy);this.requested=requested;
        }
        async render(options:any){const result=await super.render(options);return {...result,executedLayerIds:[...new Set([...result.executedLayerIds,...this.requested])]};}
      }
      const workflows=createWorkflows({...api,MapScene:NoContributionScene},document.createElement('canvas'),new AbortController().signal);
      try{await workflows[feature==='shadows'?'materials':feature]();outcomes.push({feature,rejected:false,message:''});}catch(error:any){outcomes.push({feature,rejected:/RGB pixels/.test(error.message),message:error.message});}
    }
    const emptyPoints={...api,PointCloudRenderer:{create:async(...args:any[])=>{
      const renderer=await api.PointCloudRenderer.create(...args);
      return new Proxy(renderer,{get(target,key){if(key==='setLayers')return()=>{};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    }}};
    try{await createWorkflows(emptyPoints,document.createElement('canvas'),new AbortController().signal).pointcloud();outcomes.push({feature:'pointcloud',rejected:false,message:''});}
    catch(error:any){outcomes.push({feature:'pointcloud',rejected:/no coverage/.test(error.message),message:error.message});}
    for(const [feature,owner,method,workflow,pattern]of [
      ['taa',api.Forge3DRuntime.prototype,'setPostFx','effects',/TAA did not accumulate/],
      ['oit',api.VectorLayers.prototype,'setOit','effects',/Weighted OIT/],
    ]as any[]){const original=owner[method];owner[method]=()=>{};try{await createWorkflows(api,document.createElement('canvas'),new AbortController().signal)[workflow]();outcomes.push({feature,rejected:false});}catch(error:any){outcomes.push({feature,rejected:pattern.test(error.message),message:error.message});}finally{owner[method]=original;}}
    // Native precomputation also binds IBL. Clear that real side effect and
    // suppress the explicit bind, while retaining a genuinely prepared result.
    const runtime=api.Forge3DRuntime.prototype,setIbl=runtime.setIbl,precompute=runtime.precomputeIbl;
    try{runtime.setIbl=()=>{};runtime.precomputeIbl=async function(...args:any[]){const result=await precompute.apply(this,args);setIbl.call(this,null);return result;};await createWorkflows(api,document.createElement('canvas'),new AbortController().signal).ibl();outcomes.push({feature:'ibl',rejected:false});}
    catch(error:any){outcomes.push({feature:'ibl',rejected:/RGB pixels/.test(error.message),message:error.message});}finally{runtime.setIbl=setIbl;runtime.precomputeIbl=precompute;}
    const types=[api.TerrainOrbitRig,api.TerrainRailRig,api.TerrainTargetFollowRig],bakes=types.map(t=>t.prototype.bake);
    try{for(const type of types)type.prototype.bake=()=>new api.CameraAnimation([{time:0,phiDeg:0,thetaDeg:0,radius:2,fovDeg:42,target:[0,0,0]},{time:1,phiDeg:90,thetaDeg:0,radius:2,fovDeg:42,target:[0,0,0]}]);await createWorkflows(api,document.createElement('canvas'),new AbortController().signal).rigs();outcomes.push({feature:'rigs',rejected:false});}
    catch(error:any){outcomes.push({feature:'rigs',rejected:/Rig clearance/.test(error.message),message:error.message});}finally{types.forEach((t,i)=>t.prototype.bake=bakes[i]);}
    return outcomes;
  });
  await info.attach('w23-negative-controls.json',{body:JSON.stringify({controls,docs},null,2),contentType:'application/json'});
  for(const control of controls)expect(control.rejected,control.feature+': '+control.message).toBe(true);
  for(const [name,content]of [['buildings_viewer_interactive.py','mapscene'],['pointcloud_viewer_interactive.py','pointcloud']]){
    const sample=await page.evaluate(name=>window.__w23.run(name),name);
    expect(sample.workflows.viewer.viewerContent).toBe(content);
    expect(await page.evaluate(()=>window.__w23.retainedViewers())).toBe(1);
    const before=await page.evaluate(()=>window.__w23.inspectViewer().view.yawDegrees);
    await page.locator('[data-workflow-viewer]').press('ArrowRight');
    await page.waitForFunction(()=>{const view=window.__w23.inspectViewer();return view.renders>0&&!view.pending;});
    const after=await page.evaluate(()=>window.__w23.inspectViewer());
    expect(after.error).toBeNull();expect(after.view.yawDegrees).not.toBe(before);
  }
  await page.evaluate(()=>window.__w23.run('png_numpy_roundtrip.py'));
  expect(await page.evaluate(()=>window.__w23.retainedViewers())).toBe(0);
  expect(await page.evaluate(()=>window.__w23.inspectViewer())).toBeNull();
  expect(failures).toEqual([]);
  const tampered=await page.context().newPage(),integrityErrors:string[]=[];
  try{
    tampered.on('pageerror',error=>integrityErrors.push(error.message));
    await tampered.route('**/examples/migration/workflows.js*',route=>route.fulfill({contentType:'text/javascript',body:'export function createWorkflows(){return {ibl:async()=>({prepared:true}),effects:async()=>({orderIndependent:true,taaFrames:4}),rigs:async()=>({rail:{minimumClearance:2},follow:{minimumClearance:2}})}}'}));
    await tampered.goto('/examples/migration/index.html'+(source?'?source':''));
    await expect.poll(()=>integrityErrors.some(e=>e.includes('Migration input integrity mismatch:')&&e.includes('workflows.js'))).toBe(true);
    expect(await tampered.evaluate(()=>window.__w23?.ready??false)).toBe(false);
  }finally{await tampered.close();}
  await info.attach('w23-workflows.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});
