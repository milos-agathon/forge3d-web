// Bounded browser ports of the original regional examples' analysis helpers.
// Expected values come from Python AST execution, never from these functions.
export function applicationKind(name) {
  if(/colorado_rem|platte_rem|pnoa_river/.test(name))return 'rem';
  if(/belgium_bivariate/.test(name))return 'bivariate';
  if(/barcelona_travel|helsinki_transit/.test(name))return 'travel';
  if(/rotterdam_solar/.test(name))return 'solar';
  if(/khumbu_icefall/.test(name))return 'satellite';
  if(/osm_city/.test(name))return 'city';
  if(/california_|bryce_canyon/.test(name))return 'weather';
  if(/population_spikes/.test(name))return 'population';
  if(/river_basins/.test(name))return 'basins';
  if(/landcover|lighthouse_map|luxembourg_rail/.test(name))return 'landcover';
  return null;
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
function close(actual,expected,label,tolerance=1e-5) {
  if(actual.length!==expected.length||actual.some((v,i)=>!Number.isFinite(v)||Math.abs(v-expected[i])>tolerance))throw Error(`Native ${label} oracle mismatch`);
}
export function analyzeApplication(kind,oracle) {
  const base=oracle.rem,output={kind,terrain:base.dem.slice(),width:4,height:4,scalar:base.dem.slice(),framePlan:null};
  if(kind==='rem'){
    const water=idwWaterSurface(base.coordinates,base.river,base.riverHeights),relative=base.dem.map((v,i)=>Math.fround(v-water[i]));
    close(water,base.waterSurface,'IDW water surface');close(relative,base.relativeElevation,'relative elevation');output.scalar=relative;output.evidence={waterSurface:water,relativeElevation:relative};
  }else if(kind==='bivariate'){
    const b=oracle.bivariate,tb=quantileBreaks(b.temperature),pb=quantileBreaks(b.precipitation),tc=classify(b.temperature,tb),pc=classify(b.precipitation,pb);
    close(tb,b.temperatureBreaks,'temperature quantiles');close(pb,b.precipitationBreaks,'rainfall quantiles');close(tc,b.temperatureClasses,'temperature classification');close(pc,b.precipitationClasses,'rainfall classification');
    output.colors=tc.map((t,i)=>b.palette[pc[i]-1][t-1]);output.evidence={temperatureBreaks:tb,precipitationBreaks:pb,temperatureClasses:tc,precipitationClasses:pc};
  }else if(kind==='travel'||kind==='city'){
    const t=oracle.travel,seconds=dijkstraSeconds(t.graph,t.start),speeds=t.speeds.map(parseMaxspeed);
    close(Object.values(seconds),Object.values(t.seconds),'Dijkstra travel times');if(JSON.stringify(speeds)!==JSON.stringify(t.parsedSpeeds))throw Error('Native speed parser mismatch');
    output.scalar=output.scalar.map((_,i)=>Object.values(seconds)[i%Object.keys(seconds).length]);output.evidence={seconds,speeds};
  }else if(kind==='solar'){
    const s=oracle.solar,normals=s.roofs.map(roofNormal),factors=s.roofs.map(r=>orientationFactor(r,s.orientationPenalty,s.slopePenalty));
    close(normals.flat(),s.normals.flat(),'roof normals',1e-6);close(factors,s.factors,'roof solar orientation');output.scalar=output.scalar.map((_,i)=>factors[i%factors.length]);output.evidence={normals,factors};
  }else if(kind==='satellite'){
    const s=oracle.satellite,plan=satelliteFramePlan(s.sceneIds,s.fps,s.duration,s.crossfadeFrames);
    for(let i=0;i<plan.length;i++){close([plan[i].alpha,plan[i].opacity],[s.plan[i].alpha,s.plan[i].opacity],'satellite transition');for(const field of ['index','scene','labelScene','peer'])if(plan[i][field]!==s.plan[i][field])throw Error('Native satellite frame plan mismatch');}
    output.framePlan=plan;output.evidence={frames:plan.length,transitions:plan.filter(p=>p.peer).length};
  }else output.evidence={samples:base.dem.length};
  return output;
}
