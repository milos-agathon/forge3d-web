// Browser computations paired with unchanged native helper bodies. Expected
// values are never inputs to these functions; they are compared by the caller.
const f=Math.fround,clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const round=v=>{const n=Math.floor(v);return v-n===.5?(n%2?n+1:n):Math.round(v);};
const smooth=(a,b,v)=>{const t=clamp((v-a)/Math.max(b-a,1e-6));return t*t*(3-2*t);};
const quantile=(values,q)=>{const s=[...values].sort((a,b)=>a-b),p=(s.length-1)*q,i=Math.floor(p);return s[i]+(s[Math.min(i+1,s.length-1)]-s[i])*(p-i);};
function advect(d,u,v,w,h){return d.map((_,i)=>{
  const x=f(i%w-u[i]),y=f(Math.floor(i/w)-v[i]);if(x<0||x>w-1||y<0||y>h-1)return 0;
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,w-1),y1=Math.min(y0+1,h-1),tx=f(x-x0),ty=f(y-y0);
  const top=f(f(d[y0*w+x0]*f(1-tx))+f(d[y0*w+x1]*tx)),bottom=f(f(d[y1*w+x0]*f(1-tx))+f(d[y1*w+x1]*tx));
  return f(f(top*f(1-ty))+f(bottom*ty));
});}
function despeckle(values,w,h,ids,passes,support,majority,invalid){
  let out=values.map(v=>ids.includes(v)?v:invalid);
  for(let pass=0;pass<passes;pass++){
    const next=out.slice();let changed=false;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const at=y*w+x;if(out[at]===invalid)continue;let own=0,best=0,bestId=invalid;
      for(const id of ids){let count=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<w&&ny<h&&out[ny*w+nx]===id)count++;}
        if(id===out[at])own=count;if(count>best){best=count;bestId=id;}}
      if(own<=support&&best>=majority&&bestId!==out[at]&&bestId!==invalid){next[at]=bestId;changed=true;}
    }out=next;if(!changed)break;
  }return out;
}
function shade(d,w,h,azimuth,elevation,z){
  const a=azimuth*Math.PI/180,e=elevation*Math.PI/180,light=[f(Math.cos(e)*Math.sin(a)),f(Math.sin(e)),f(Math.cos(e)*Math.cos(a))];
  return d.map((_,i)=>{const x=i%w,y=Math.floor(i/w),dx=f((d[y*w+Math.min(x+1,w-1)]-d[y*w+Math.max(x-1,0)])/(x===0||x===w-1?1:2)),dy=f((d[Math.min(y+1,h-1)*w+x]-d[Math.max(y-1,0)*w+x])/(y===0||y===h-1?1:2));const v=[f(-dx*z),1,f(dy*z)],length=f(Math.sqrt(f(f(v[0]*v[0])+f(1+f(v[2]*v[2])))))+1e-8;return f(clamp(v.reduce((s,n,j)=>s+f(f(n/length)*light[j]),0)));});
}
function pnoaMasks(input){
  const {width:w,height:h,features,styles}=input,scale=6,sw=w*scale,sh=h*scale;
  function mask(core){const raw=new Uint8Array(sw*sh);
    for(const feature of features){const style=styles[feature.waterway]??styles.stream,stroke=Math.max(1,round((style[0]+(core?.1:.3))*scale*(core?.32:.40)));
      for(let j=1;j<feature.x.length;j++){
        const x0=Math.trunc(feature.x[j-1]*scale),x1=Math.trunc(feature.x[j]*scale),y0=Math.trunc(feature.y[j-1]*scale),y1=Math.trunc(feature.y[j]*scale);
        if(y0!==y1&&x0!==x1)throw Error('Bounded PNOA mask fixture requires axis-aligned source segments');
        const left=x0===x1?x0-Math.floor((stroke-1)/2):Math.min(x0,x1),right=x0===x1?left+stroke-1:Math.max(x0,x1),top=y0===y1?y0-Math.floor((stroke-1)/2):Math.min(y0,y1),bottom=y0===y1?top+stroke-1:Math.max(y0,y1);
        for(let y=Math.max(0,top);y<=Math.min(sh-1,bottom);y++)for(let x=Math.max(0,left);x<=Math.min(sw-1,right);x++)raw[y*sw+x]=255;
      }
    }
    const horizontal=new Uint8Array(w*sh),out=new Array(w*h);
    for(let y=0;y<sh;y++)for(let x=0;x<w;x++){const center=(x+.5)*scale;let sum=0,weight=0;for(let sx=Math.max(0,Math.ceil(center-scale-.5));sx<=Math.min(sw-1,Math.floor(center+scale-.5));sx++){const k=Math.max(0,1-Math.abs(sx+.5-center)/scale);sum+=raw[y*sw+sx]*k;weight+=k;}horizontal[y*w+x]=Math.floor(sum/weight+.5);}
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const center=(y+.5)*scale;let sum=0,weight=0;for(let sy=Math.max(0,Math.ceil(center-scale-.5));sy<=Math.min(sh-1,Math.floor(center+scale-.5));sy++){const k=Math.max(0,1-Math.abs(sy+.5-center)/scale);sum+=horizontal[sy*w+x]*k;weight+=k;}out[y*w+x]=f(Math.floor(sum/weight+.5)/255);}
    return out;
  }
  return {halo:mask(false),core:mask(true)};
}
function borderWater({width:w,height:h,classes,trim}){
  const n=w*h,water=classes.map(v=>v===1),border=new Array(n).fill(false),core=new Array(n).fill(false);
  const neighbors=i=>{const x=i%w,y=Math.floor(i/w),out=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<w&&ny<h)out.push(ny*w+nx);}return out;};
  const queue=[];for(let i=0;i<n;i++)if(water[i]&&neighbors(i).some(j=>classes[j]===0)){border[i]=true;queue.push(i);}
  for(let k=0;k<queue.length;k++)for(const j of neighbors(queue[k]))if(water[j]&&!border[j]){border[j]=true;queue.push(j);}
  const outside=classes.map((_,i)=>i).filter(i=>!water[i]);
  for(let i=0;i<n;i++)if(border[i])core[i]=outside.reduce((d,j)=>Math.min(d,Math.hypot(i%w-j%w,Math.floor(i/w)-Math.floor(j/w))),Infinity)>=trim;
  let remove=core;for(let step=0;step<trim;step++)remove=remove.map((v,i)=>v||border[i]&&neighbors(i).some(j=>remove[j]));
  return {classes:classes.map((v,i)=>remove[i]?0:v)};
}
function priorityFlood(input){
  const {width:w,height:h,indices,channels,threshold,friction,cellSize}=input,activation=threshold.map(()=>Infinity),queue=[];
  const cells=new Map(indices.map((v,i)=>[v,i]));for(const i of channels){activation[i]=0;queue.push([0,i]);}
  while(queue.length){queue.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const [current,id]=queue.shift();if(current>activation[id]+1e-6)continue;const at=cells.get(id),x=at%w,y=Math.floor(at/w);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;const next=indices[ny*w+nx];if(next<0)continue;const candidate=Math.max(current+cellSize*Math.hypot(dx,dy)*friction[next],threshold[next]);if(candidate+1e-6<activation[next]){activation[next]=f(candidate);queue.push([candidate,next]);}}
  }
  const logistic=t=>1/(1+Math.exp(-7.2*(t-.46))),lo=logistic(0),hi=logistic(1),progress=[0,.5,1].map(t=>clamp((logistic(t)-lo)/(hi-lo)));
  return {activation,progress,waterLevels:progress.map(p=>input.startLevel+(input.endLevel-input.startLevel)*p)};
}
export function executeRegionalKernel(kernel,i,legacy){
  switch(kernel){
    case 'colorado-idw':{const waterSurface=legacy.idwWaterSurface(i.coordinates,i.river,i.riverHeights);return {waterSurface,relativeElevation:i.dem.map((v,j)=>f(v-waterSurface[j]))};}
    case 'platte-idw':{const waterSurface=i.coordinates.map(([x,y])=>{const d=i.river.map(([rx,ry])=>f(f(f(x-rx)**2)+f(f(y-ry)**2))),hit=d.findIndex(v=>v<=1);if(hit>=0)return i.riverHeights[hit];const weights=d.map(v=>f(1/f(Math.pow(Math.max(v,1),1)))),sum=weights.reduce((a,b)=>f(a+b),0);return f(weights.reduce((a,v,j)=>f(a+f(v*i.riverHeights[j])),0)/sum);});return {waterSurface,relativeElevation:i.dem.map((v,j)=>f(v-waterSurface[j]))};}
    case 'climate-classification':{const temperatureBreaks=legacy.quantileBreaks(i.temperature),precipitationBreaks=legacy.quantileBreaks(i.precipitation);return {temperatureBreaks,precipitationBreaks,temperatureClasses:legacy.classify(i.temperature,temperatureBreaks),precipitationClasses:legacy.classify(i.precipitation,precipitationBreaks)};}
    case 'road-routing':{const seconds=legacy.dijkstraSeconds(i.graph,i.start),segments=i.segments.filter(s=>Math.min(seconds[s.u]??Infinity,seconds[s.v]??Infinity)<=i.cutoffMin*60).map(s=>({x0:s.x0,y0:s.y0,x1:s.x1,y1:s.y1,tmin:Math.min(seconds[s.u],seconds[s.v])/60,highway:s.highway}));return {seconds,speeds:i.speeds.map(legacy.parseMaxspeed),segments,pixels:segments.map(s=>[s.x0/16*15,(16-s.y0)/16*15,s.x1/16*15,(16-s.y1)/16*15,s.tmin])};}
    case 'solar-roofs':return {normals:i.roofs.map(legacy.roofNormal),factors:i.roofs.map(r=>legacy.orientationFactor(r,i.orientationPenalty,i.slopePenalty))};
    case 'satellite-plan':return {plan:legacy.satelliteFramePlan(i.sceneIds,i.fps,i.duration,i.crossfadeFrames)};
    case 'satellite-rgb':return {images:i.images.map(rgb=>{const out=[];for(let at=0;at<rgb.length;at+=3){for(let c=0;c<3;c++){const scaled=f(clamp(f(f(rgb[at+c]-i.low[c])/f(i.high[c]-i.low[c]))));const graded=f(clamp(f(f(scaled*f([.84,.96,1.24][c]))+f([.04,.09,.125][c]))));out.push(Math.trunc(clamp(f(f(graded*255)+.5),0,255)));}out.push(255);}return out;})};
    case 'waterway-masks':{const terrain=i.dem.map((_,at)=>{const x=at%i.width,y=Math.floor(at/i.width);let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy)sum=f(sum+i.dem[clamp(y+dy,0,i.height-1)*i.width+clamp(x+dx,0,i.width-1)]);return f(f(f(i.dem[at]*4)+sum)/12);});return {terrain,...pnoaMasks(i),priorities:i.features.map(v=>v.length*({river:3,canal:1.5}[v.waterway]??1))};}
    case 'pnoa-crop-sun':{const min=Math.min(...i.dem);return {terrain:i.dem.map(v=>f(v-min)),sunFrames:i.times.map(t=>{const p=t/Math.max(i.duration,1e-6)*Math.PI*2;return [(42+p*180/Math.PI)%360,24+8*Math.sin(p-.55)];})};}
    case 'population-height':return {population:i.values.slice(),heights:i.values.map((v,j)=>i.valid[j]?f(f(Math.pow(f(clamp(f(f(v-i.heightFloor)/f(i.clipMax-i.heightFloor)))),f(i.heightGamma)))*i.clipMax):0)};
    case 'rail-projection':return {world:i.points.map(([x,y])=>[(i.bounds[2]===i.bounds[0]?.5:(x-i.bounds[0])/(i.bounds[2]-i.bounds[0]))*i.width,(i.bounds[3]===i.bounds[1]?.5:(i.bounds[3]-y)/(i.bounds[3]-i.bounds[1]))*i.height]),dimensions:[i.width,i.height]};
    case 'basin-composite':{const rgba=[];for(let at=0;at<i.colors.length;at+=4){const luma=(i.relief[at]+i.relief[at+1]+i.relief[at+2])/3/255,s=.58+luma*.62,c=i.colors.slice(at,at+4);for(let j=0;j<3;j++)c[j]=Math.trunc(clamp(c[j]*s,0,255));c[2]=Math.max(c[2],c[0]+4)%256;const mean=(c[0]+c[1]+c[2])/3,subject=c[3]>0&&c.slice(0,3).some(v=>v<248);if(subject){const lift=mean<80?8:22;for(let j=0;j<3;j++)c[j]=clamp(c[j]+lift,0,255);if(mean>=80)c[2]=Math.max(c[2],c[0]+86)%256;}rgba.push(...c);}return {rgba,widths:i.orders.map(v=>.00022*i.canvasWidth*Math.pow(clamp(v,1,9),1.8)),dimensions:[i.canvasWidth,round(i.canvasWidth/i.aspect)]};}
    case 'basin-terrarium':{const decoded=[];for(let at=0;at<i.rgb.length;at+=3)decoded.push(f(i.rgb[at]*256+i.rgb[at+1]+i.rgb[at+2]/256-32768));const palette={};[...i.ids].sort((a,b)=>a-b).forEach((id,j)=>palette[id]=i.paletteOrder[j%i.paletteOrder.length]);return {decoded,widths:i.orders.map(v=>({3:10,4:7,5:4,6:2}[v]??0)),palette};}
    case 'gtfs-transit':{const cumulative=[0];for(let j=1;j<i.points.length;j++){const dx=f(i.points[j][0]-i.points[j-1][0]),dy=f(i.points[j][1]-i.points[j-1][1]);cumulative.push(f(cumulative[j-1]+f(Math.sqrt(f(f(dx*dx)+f(dy*dy))))));}const positions=i.times.map(time=>{if(time<i.start||time>i.end)return null;const d=(time-i.start)/Math.max(i.end-i.start,1)*cumulative.at(-1);let j=cumulative.findIndex(v=>v>d);j=clamp(j<0?i.points.length-1:j,1,i.points.length-1);const t=cumulative[j]<=cumulative[j-1]?0:(d-cumulative[j-1])/(cumulative[j]-cumulative[j-1]);return i.points[j].map((v,c)=>f(f(i.points[j-1][c]*f(1-t))+f(v*f(t))));});const clock=i.clock.map(v=>{if(v==null||!String(v).trim())return null;const parts=String(v).trim().split(':');if(parts.length!==3||parts.some(s=>!/^[-+]?\d+$/.test(s)))return null;const [h,m,s]=parts.map(Number);return m<0||m>59||s<0||s>59?null:h*3600+m*60+s;});return {cumulative,positions,clock,frameSeconds:[i.start,(i.start+i.end)/2,i.end]};}
    case 'city-buildings':{const parse=v=>{if(v==null)return null;if(typeof v==='number')return v;const s=String(v).trim().toLowerCase().replaceAll(',','.'),m=/-?\d+(?:\.\d+)?/.exec(s);return m?Number(m[0])*(/ft|feet/.test(s)?.3048:1):null;};const heights=i.tags.map(t=>{const h=parse(t.height),levels=parse(t['building:levels']);return h!==null&&Number.isFinite(h)?clamp(h,1,80):levels!==null&&Number.isFinite(levels)?clamp(Math.max(levels,1)*3.2,1,80):12;});return {heights,bins:heights.map(h=>h<=15?'low':h<=30?'mid':h<=45?'high':'landmark')};}
    case 'city-sun':{const sunFrames=[],directions=[],shadowStrength=[];for(let j=0;j<i.frames;j++){const t=j/Math.max(i.frames-1,1),noon=Math.pow(Math.sin(Math.PI*t),.9),a=82+196*t,e=11+55*noon;sunFrames.push([a,e]);const az=a*Math.PI/180,el=e*Math.PI/180,v=[f(Math.cos(el)*Math.sin(az)),f(Math.sin(el)),f(-Math.cos(el)*Math.cos(az))],len=Math.hypot(...v);directions.push(v.map(x=>f(x/len)));shadowStrength.push(.78+.26*(1-noon));}return {sunFrames,directions,shadowStrength};}
    case 'priority-flood':return priorityFlood(i);
    case 'storm-envelope':{const s=(a,b,x)=>{const t=f(clamp(f(f(x-a)/f(Math.max(f(b-a),1e-6)))));return f(f(t*t)*f(3-f(2*t)));},rain=p=>clamp(s(.58,.80,p)*(.28+.72*s(.78,.95,p))),dark=p=>s(.32,.82,p),sun=p=>{const arc=Math.sin(Math.PI*p),filter=1-.28*s(.18,.56,p)-.28*dark(p)-.2*rain(p);return [78+p*232,5+48*Math.pow(arc,1.04),(.30+.46*Math.pow(arc,1.08))*Math.max(filter,.30)];};return {rain:i.progress.map(rain),darkness:i.progress.map(dark),sunVisibility:i.progress.map(p=>clamp((.28+.72*clamp(1-sun(p)[1]/52))*(.26+.74*Math.max(s(.74,.98,p),1-rain(p)*.75)))),sunFrames:i.progress.map(p=>sun(p).slice(0,2))};}
    case 'smoke-injection':{let density=new Array(i.width*i.height).fill(0);const densityFrames=[];const norm=Math.hypot(1,f(-.42)),wind=[f(1/norm),f(f(-.42)/norm)],cross=[f(-wind[1]),wind[0]];
      for(let frame=0;frame<i.frames;frame++){density=advect(density,i.u,i.v,i.width,i.height);for(let j=0;j<i.hotspots.length;j++){const h=i.hotspots[j];if(frame<h.start_frame||frame>h.end_frame)continue;const cx=f((h.lon-i.bounds.lon_min)/(i.bounds.lon_max-i.bounds.lon_min)*(i.width-1)),cy=f((i.bounds.lat_max-h.lat)/(i.bounds.lat_max-i.bounds.lat_min)*(i.height-1)),scale=Math.min(i.width,i.height)/1024,radius=Math.max(1,h.radius_px_at_1024*scale),length=Math.max(3.8*radius,5.5*scale+4),sigma=Math.max(.65,radius*.62),pad=Math.ceil(length+4.5*radius+2),pulse=.88+.12*Math.sin(frame*.31+j*1.71+(i.seed%97)*.01);
        for(let y=Math.max(0,Math.floor(cy-pad-length*.45));y<Math.min(i.height,Math.ceil(cy+pad));y++)for(let x=Math.max(0,Math.floor(cx-pad));x<Math.min(i.width,Math.ceil(cx+pad+length));x++){const dx=f(x-cx),dy=f(y-cy),along=f(f(dx*wind[0])+f(dy*wind[1])),across=f(f(dx*cross[0])+f(dy*cross[1])),core=f(Math.exp(-f(f(dx*dx)+f(dy*dy))/(2*sigma*sigma))),gate=smooth(-.20*radius,.75*radius,along)*(along<=length?1:0),width=radius*(.58+.40*clamp(along/Math.max(length,1))),tail=Math.exp(-Math.max(along,0)/Math.max(2.4*radius,1))*Math.exp(-across*across/(2*width*width+1e-6))*gate;density[y*i.width+x]=f(clamp(f(density[y*i.width+x]+f(h.strength*pulse*(.135*core+.045*tail))),0,4));}
      }densityFrames.push(density.slice());}return {densityFrames};}
    case 'wildfire-advection':{let density=i.density.slice();const densityFrames=[];for(let j=0;j<3;j++){density=advect(density,i.u,i.v,i.width,i.height);densityFrames.push(density.slice());}return {densityFrames,alpha:i.ages.map(age=>{const a=clamp(age/Math.max(i.maxAge,1e-6)),birth=smooth(0,.06,a),peak=1-.3*smooth(0,.3,a),fade=1-Math.pow(smooth(.15,1,a),.6);return clamp(birth*peak*fade);})};}
    case 'bosnia-landcover':return {classes:despeckle(i.classes,i.width,i.height,i.classIds,i.despeckle.passes,i.despeckle.max_support,i.despeckle.min_majority,0),shade:shade(i.dem,i.width,i.height,i.azimuth,i.elevation,i.zFactor)};
    case 'swiss-landcover':{const raw=[];for(let at=0;at<i.rgb.length;at+=3){const color=i.rgb.slice(at,at+3);let best=-1,distance=Infinity;if(Math.max(...color)>i.invalidMax)i.palette.forEach((c,j)=>{const d=c.reduce((s,v,k)=>s+(v-color[k])**2,0);if(d<distance){best=j;distance=d;}});raw.push(best);}const classes=despeckle(raw,i.width,i.height,i.palette.map((_,j)=>j),i.passes,i.maxSupport,i.minMajority,-1),rgba=classes.flatMap(v=>v<0?[0,0,0,0]:[...i.display[v],255]);return {classes,rgba};}
    case 'romania-border-water':return borderWater(i);
    case 'germany-overlay-grid':{const rgba=[];for(let y=0;y<i.height;y++)for(let x=0;x<i.width;x++){const at=(Math.floor((y+.5)*i.sourceHeight/i.height)*i.sourceWidth+Math.floor((x+.5)*i.sourceWidth/i.width))*4;rgba.push(...i.rgba.slice(at,at+4));}return {rgba};}
    case 'lighthouse-relief':{const n=i.points.length,centroid=[0,1].map(c=>i.points.reduce((s,p)=>s+p[c],0)/n),dist=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2,argmax=v=>v.indexOf(Math.max(...v)),selected=[argmax(i.points.map(p=>dist(p,centroid)))];let minimum=i.points.map(p=>dist(p,i.points[selected[0]]));while(selected.length<Math.min(i.count,n)){const next=argmax(minimum);selected.push(next);minimum=minimum.map((v,j)=>Math.min(v,dist(i.points[j],i.points[next])));}const weights=i.points.map((p,j)=>{const ds=i.points.filter((_,k)=>k!==j).map(q=>dist(p,q)),count=ds.filter(d=>d<i.densityRadius**2).length,nearest=Math.sqrt(Math.min(...ds));return f(clamp(f(f(f(1-f(Math.min(count,4)*.07))-f(clamp((8000-nearest)/8000)*.18))+f(clamp((nearest-16000)/40000,0,.10))),.62,1.14));});const high=Math.max(quantile(i.dem,.995),1),terrain=i.dem.map((v,at)=>{const north=f(1-smooth(.34,.72,f(Math.floor(at/i.width)/(i.height-1)))),ht=f(clamp(f(v/high))),gain=f(1+f(f(north*ht)*.22));return f(v*gain);});return {selected,weights,terrain};}
    default:throw Error('Unimplemented original regional kernel: '+kernel);
  }
}
