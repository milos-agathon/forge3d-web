// Bounded browser ports of the original regional examples' analysis helpers.
// Expected values come from Python AST execution, never from these functions.
import { executeRegionalKernel } from './regional-kernels.js';
export function applicationKind(name) {
  return ({'colorado_rem_forge3d.py':'rem','platte_rem_forge3d.py':'platte-rem','pnoa_river_showcase.py':'waterways','pnoa_river_showcase_video.py':'pnoa-video','belgium_bivariate_climate_map.py':'bivariate','barcelona_travel_time_3d.py':'travel','helsinki_transit_daycycle.py':'transit','rotterdam_solar_potential_shadow_study.py':'solar','khumbu_icefall_sentinel_timelapse.py':'satellite','osm_city_demo.py':'city','osm_city_daycycle.py':'daycycle','osm_city_flood_daycycle.py':'flood','california_fire_smoke_effect.py':'smoke','california_wildfire_smoke_video.py':'wildfire','bryce_canyon_storm_timelapse.py':'storm','poland_population_spikes_height_shade.py':'population','turkiye_river_basins_3d.py':'turkiye-basins','poland_river_basins_forge3d.py':'poland-basins','romania_terrain_landcover_viewer.py':'landcover','swiss_terrain_landcover_viewer.py':'landcover','germany_terrain_landcover_viewer.py':'landcover','bosnia_terrain_landcover_viewer.py':'landcover','uk_ireland_lighthouse_map.py':'lighthouses','luxembourg_rail_overlay.py':'rail'})[name]??null;
}
export function quantileBreaks(values, quantiles = [.25,.5,.75]) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)throw Error('No finite climate samples');
  return [sorted[0],...quantiles.map(q=>{const p=q*(sorted.length-1),i=Math.floor(p);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(p-i);}),sorted.at(-1)];
}
export function classify(values,breaks) {const edges=breaks.slice(1,-1).map(Math.fround);return values.map(v=>Number.isFinite(v)?1+edges.filter(e=>Math.fround(v)>=e).length:0);}
export function idwWaterSurface(coordinates,river,values,power=2) {
  const f=Math.fround;
  return coordinates.map(([x,y])=>{
    const distances=river.map(([rx,ry])=>f(Math.hypot(x-rx,y-ry))),hit=distances.findIndex(d=>d<=1e-6);
    if(hit>=0)return values[hit];
    const weights=distances.map(d=>f(1/f(Math.max(d,1e-6)**f(Math.max(power,.01))))),sum=weights.reduce((a,b)=>f(a+b),0);
    return weights.reduce((total,w,i)=>f(total+f(f(w/sum)*values[i])),0);
  });
}
export function parseMaxspeed(value) {
  if(value==null)return null;
  if(typeof value==='number')return Number.isFinite(value)&&value>0?value:null;
  if(Array.isArray(value)&&value.length)return parseMaxspeed(value[0]);
  const text=String(value).trim().toLowerCase();
  for(const token of text.replaceAll(',','.').replace(/[;|]/g,' ').split(/\s+/)){const speed=Number(token);if(Number.isFinite(speed)&&speed>0)return text.includes('mph')?speed*1.60934:speed;}
  return null;
}
export function dijkstraSeconds(graph,start,allowed=new Set(Object.keys(graph).map(Number))) {
  const distances={[start]:0},queue=[[0,start]];
  while(queue.length){queue.sort((a,b)=>a[0]-b[0]);const [distance,node]=queue.shift();if(distance>distances[node])continue;
    for(const [neighbor,weight]of graph[node]??[]){if(!allowed.has(neighbor))continue;const next=distance+weight;if(next<(distances[neighbor]??Infinity)){distances[neighbor]=next;queue.push([next,neighbor]);}}
  }return distances;
}
export function roofNormal({slope_deg:slope,aspect_deg:aspect}) {
  const s=slope*Math.PI/180,a=((aspect+180)%360)*Math.PI/180,f=Math.fround;
  const v=[f(Math.sin(a)*Math.sin(s)),f(Math.cos(s)),f(-Math.cos(a)*Math.sin(s))],norm=Math.hypot(...v);return v.map(x=>f(x/norm));
}
export function orientationFactor(roof,orientationPenalty,slopePenalty) {
  const aspect=roof.slope_deg<=5?.94:1-orientationPenalty*(1-(.5+.5*Math.cos((roof.aspect_deg-180)*Math.PI/180)));
  return Math.max(.3,Math.min(1.04,aspect*(1-slopePenalty*Math.min(Math.abs(roof.slope_deg-35)/35,1.6))));
}
export function satelliteFramePlan(sceneIds,fps,duration,crossfadeFrames) {
  const count=Math.max(1,Math.round(fps*duration)),plan=[];if(!sceneIds.length)return plan;
  if(sceneIds.length===1)return Array.from({length:count},(_,index)=>({index,scene:sceneIds[0],labelScene:sceneIds[0],peer:null,alpha:0,opacity:1}));
  const segments=sceneIds.length-1,base=Math.floor(count/segments),remainder=count%segments;
  for(let segment=0;segment<segments;segment++){const length=base+(segment<remainder?1:0),fade=Math.min(Math.max(0,crossfadeFrames),Math.max(0,length-1)),current=sceneIds[segment],peer=sceneIds[segment+1];
    for(let offset=0;offset<length;offset++){const index=plan.length,inFade=fade>0&&offset>=length-fade-1&&offset<length-1,alpha=inFade?(offset-(length-fade-1)+1)/(fade+1):0,scene=offset===length-1?peer:current;
      plan.push({index,scene,labelScene:inFade?(alpha>=.5?peer:current):scene,peer:inFade?peer:null,alpha,opacity:inFade?1-.7*Math.sin(Math.PI*alpha):1});
    }
  }return plan.slice(0,count);
}
function assertControl(actual,expected,tolerance,path){
  if(typeof expected==='number'){
    if(!Number.isFinite(actual)||Math.abs(actual-expected)>tolerance)throw Error(`Native ${path} mismatch: ${actual} != ${expected}`);
  }else if(expected===null||typeof expected!=='object'){
    if(actual!==expected)throw Error(`Native ${path} mismatch`);
  }else{
    if(!actual||Array.isArray(expected)!==Array.isArray(actual)||Object.keys(actual).length!==Object.keys(expected).length)throw Error(`Native ${path} shape mismatch`);
    for(const key of Object.keys(expected))assertControl(actual[key],expected[key],tolerance,path+'.'+key);
  }
}
export function analyzeExample(name,fixtures,execute=executeRegionalKernel){
  const control=fixtures.examples?.[name];
  if(!control||control.source.path!=='examples/'+name||control.kind!==applicationKind(name)||!control.operations.length)throw Error('Missing original regional contract '+name);
  const computed={},evidence={};
  const legacy={quantileBreaks,classify,idwWaterSurface,parseMaxspeed,dijkstraSeconds,roofNormal,orientationFactor,satelliteFramePlan};
  for(const operation of control.operations){
    const result=execute(operation.kernel,structuredClone(operation.input),legacy);
    assertControl(result,operation.expected,operation.tolerance,operation.native.path+'::'+operation.kernel);
    computed[operation.kernel]=result;Object.assign(evidence,result);
  }
  const {width,height}=control.terrain,base=control.terrain.data.slice();
  let terrain=control.render.terrain?evidence[control.render.terrain].slice():base;
  const value=control.render.scalar?evidence[control.render.scalar]:null;
  const scalar=Array.isArray(value?.[0])?value[0].slice():Array.isArray(value)?value.slice():terrain.slice();
  const output={kind:control.kind,sourceExample:name,source:control.source,inputSource:control.terrain.source,width,height,terrain,scalar,evidence,computed,operations:control.operations.map(o=>({kernel:o.kernel,native:o.native})),framePlan:evidence.plan??null,sceneImages:evidence.images??null,densityFrames:evidence.densityFrames??null};
  if(control.kind==='lighthouses')output.points=control.operations[0].input.points;
  const rgba=evidence.rgba;
  if(rgba){output.overlay={width:Math.round(Math.sqrt(rgba.length/4)),height:Math.round(Math.sqrt(rgba.length/4)),data:rgba.slice()};}
  if(control.kind==='bivariate'){const palette=control.render.palette,size=Math.sqrt(evidence.temperatureClasses.length);output.colors=Array.from({length:width*height},(_,i)=>{const at=Math.floor(Math.floor(i/width)*size/height)*size+Math.floor((i%width)*size/width);return palette[evidence.precipitationClasses[at]-1][evidence.temperatureClasses[at]-1];});}
  if(control.kind==='landcover'&&!rgba){const op=control.operations.find(o=>o.kernel==='bosnia-landcover'),palette=op.input.palette;output.overlay={width,height,data:evidence.classes.flatMap((v,i)=>{const index=op.input.classIds.indexOf(v),shade=.9+.1*evidence.shade[i];return index<0?[0,0,0,0]:[...palette[index].map(c=>Math.round(c*shade)),255];})};}
  if(control.kind==='waterways')output.overlay={width,height,data:evidence.core.flatMap(v=>[Math.round(85+140*v),Math.round(125+100*v),Math.round(120+125*v),255])};
  if(control.kind==='poland-basins'){const op=control.operations[0],ids=[...op.input.ids].sort((a,b)=>a-b);output.colors=Array.from({length:width*height},(_,i)=>evidence.palette[ids[(Math.floor(i/width/4)+Math.floor(i%width/4))%ids.length]]);}
  return output;
}
