import { normalizeVectorStyle, vectorInvalid, VectorLayers } from "./vector-layers.js";
import { TerrainDataset } from "./terrain-dataset.js";
import type { TerrainHeightmapInput } from "./index.js";
import type { VectorPosition, VectorSnapshot, VectorSelectionStyle } from "./vector-types.js";

export interface VectorPacket { vertices:number[][]; oit:string; culling:string; featureCount:number; atlas:{width:number;height:number;rgba:number[]}; highlights:number[][] }
type P=VectorPosition;
const cross=(a:P,b:P,c:P)=>(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);
function inside(p:P,a:P,b:P,c:P):boolean {return cross(a,b,p)>=-1e-10&&cross(b,c,p)>=-1e-10&&cross(c,a,p)>=-1e-10;}
function area(r:P[]):number {return r.reduce((sum,p,i)=>{const q=r[(i+1)%r.length]!;return sum+p[0]*q[2]-q[0]*p[2];},0)/2;}
function inRing(p:P,r:P[]):boolean {let hit=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i]!,b=r[j]!;if((a[2]>p[2])!==(b[2]>p[2])&&p[0]<(b[0]-a[0])*(p[2]-a[2])/(b[2]-a[2])+a[0])hit=!hit;}return hit;}
function same(a:P,b:P):boolean{return a[0]===b[0]&&a[2]===b[2];}
function intersects(a:P,b:P,c:P,d:P):boolean {return cross(a,b,c)*cross(a,b,d)<-1e-12&&cross(c,d,a)*cross(c,d,b)<-1e-12;}

/** Ear clipping with visible bridges for holes. Invalid/self-intersecting rings fail. */
export function triangulateVectorPolygon(input:P[][]):P[][] {
  const rings=input.map(r=>{const out=r.map(p=>[...p] as P);if(out.length>3&&same(out[0]!,out.at(-1)!))out.pop();if(Math.abs(area(out))<1e-12)throw vectorInvalid("degenerate polygon ring");return out;});
  let outer=rings[0]!;if(area(outer)<0)outer.reverse();
  for(const hole of rings.slice(1)){
    if(area(hole)>0)hole.reverse();
    let hi=0;for(let i=1;i<hole.length;i++)if(hole[i]![0]>hole[hi]![0])hi=i;
    const h=hole[hi]!;let best=-1,bestDistance=Infinity;
    for(let i=0;i<outer.length;i++){
      const v=outer[i]!,mid:P=[(v[0]+h[0])/2,0,(v[2]+h[2])/2];
      if(!inRing(mid,outer)||rings.slice(1).some(r=>inRing(mid,r)))continue;
      if([outer,...rings.slice(1)].some(r=>r.some((a,k)=>{const b=r[(k+1)%r.length]!;return !same(a,h)&&!same(b,h)&&!same(a,v)&&!same(b,v)&&intersects(h,v,a,b);})))continue;
      const d=(v[0]-h[0])**2+(v[2]-h[2])**2;if(d<bestDistance){best=i;bestDistance=d;}
    }
    if(best<0)throw vectorInvalid("polygon hole has no visible bridge");
    const ordered=[...hole.slice(hi),...hole.slice(0,hi)];
    outer=[...outer.slice(0,best+1),...ordered,h,outer[best]!,...outer.slice(best+1)];
  }
  const triangles:P[][]=[],points=[...outer];
  while(points.length>3){let clipped=false;for(let i=0;i<points.length;i++){
    const a=points[(i+points.length-1)%points.length]!,b=points[i]!,c=points[(i+1)%points.length]!;
    if(cross(a,b,c)<=1e-12)continue;
    if(points.some((p,k)=>k!==i&&k!==(i+points.length-1)%points.length&&k!==(i+1)%points.length&&!same(p,a)&&!same(p,b)&&!same(p,c)&&inside(p,a,b,c)))continue;
    triangles.push([a,b,c]);points.splice(i,1);clipped=true;break;
  }if(!clipped)throw vectorInvalid("polygon is self-intersecting or degenerate");}
  if(points.length===3&&Math.abs(cross(points[0]!,points[1]!,points[2]!))>1e-12)triangles.push(points);
  return triangles;
}

/** CPU topology; projection, billboard expansion, elevation and culling run on GPU. */
export function compileVectorPacket(source:VectorLayers|VectorSnapshot,terrain?:TerrainHeightmapInput):VectorPacket {
  const snapshot=source instanceof VectorLayers?source.snapshot():VectorLayers.from(source).snapshot();
  const dataset=terrain?TerrainDataset.fromArray(terrain):undefined;
  const layers=snapshot.layers.filter(l=>l.visible);
  const atlasWidth=Math.max(1,...layers.map(l=>l.atlas?.width??0));
  const atlasHeight=Math.max(1,layers.reduce((n,l)=>n+(l.atlas?.height??0),0));
  if(atlasHeight>4096)throw new Forge3DResourceError();
  const rgba=new Uint8Array(atlasWidth*atlasHeight*4);rgba.fill(255);
  const vertices:number[][]=[];let atlasY=0,featureCount=0;
  const highlights:number[][]=[];
  function highlight(id:number,s:VectorSelectionStyle){const c=s.color??[1,.8,0,.5];highlights.push([id,s.outline?1:0,s.glow?1:0,0,...c,s.outlineWidth??2,s.glowIntensity??.5,s.glowRadius??8,(s.pulseSpeed??0)>0?Math.sin(snapshot.timeSeconds*(s.pulseSpeed??0))*.5+.5:1]);}
  for(const selection of snapshot.selections)if(selection.visible)for(const id of selection.ids)highlight(id,selection.style);
  if(snapshot.hover!==null)highlight(snapshot.hover,snapshot.hoverStyle);
  for(const layer of layers){
    const atlas=layer.atlas;if(atlas){for(let y=0;y<atlas.height;y++)rgba.set(atlas.rgba.subarray(y*atlas.width*4,(y+1)*atlas.width*4),((atlasY+y)*atlasWidth)*4);}
    for(const feature of layer.features){
      const s=normalizeVectorStyle({...layer.style,...feature.style});if(s.opacity*s.color[3]===0)continue;featureCount++;
      const color=[s.color[0],s.color[1],s.color[2],s.color[3]*s.opacity];
      const drape=(p:P):P=>{if(!s.drape)return [...p];if(!dataset)throw vectorInvalid("draped vectors require terrain");const hx=(dataset.width-1)*dataset.spacing[0]/2,hz=(dataset.height-1)*dataset.spacing[1]/2;const q=dataset.query(Math.max(-hx,Math.min(hx,p[0])),Math.max(-hz,Math.min(hz,p[2])));if(!q||!Number.isFinite(q.elevation))throw vectorInvalid("cannot drape onto nodata");return [p[0],(q.elevation-dataset.domain[0])*dataset.exaggeration+s.drapeOffset,p[2]];};
      const tileX=atlas?s.atlasTile%(atlas.width/atlas.tileSize):0,tileY=atlas?Math.floor(s.atlasTile/(atlas.width/atlas.tileSize)):0;
      const uvrect=atlas?[tileX*atlas.tileSize/atlasWidth,(atlasY+tileY*atlas.tileSize)/atlasHeight,atlas.tileSize/atlasWidth,atlas.tileSize/atlasHeight]:[0,0,1,1];
      const emit=(p:P,prev:P,next:P,expand:number,offset:number[],uv:number[],shape:number,elevation=0)=>{vertices.push([...p,elevation,...prev,expand,...next,s.miterLimit,...offset,...uv,...color,feature.id,shape,0,0,...uvrect,s.depthBias,s.lodThreshold,.5/atlasWidth,.5/atlasHeight]);};
      const point=(p:P,size:number,shape:number)=>{for(const [x,y] of [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]])emit(p,p,p,1,[x!*(size/2+1),y!*(size/2+1)],[x!*(1+2/size),y!*(1+2/size)],shape);};
      if(feature.kind==="point")point(drape(feature.position),s.pointSize,["circle","square","diamond","triangle","texture","sphere"].indexOf(s.shape)+1);
      if(feature.kind==="line"){
        const dense:P[]=[];const originals=feature.positions;
        for(let i=0;i<originals.length-1;i++){const a=originals[i]!,b=originals[i+1]!;const n=s.drape&&dataset?Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/Math.min(...dataset.spacing))):1;if(n>100000)throw new Forge3DResourceError();for(let j=0;j<n;j++){const t=j/n;dense.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]);}}dense.push(originals.at(-1)!);
        const ps=dense.map(drape);const w=s.lineWidth/2;
        for(let i=0;i<ps.length-1;i++){const a=ps[i]!,b=ps[i+1]!;if(a.every((x,k)=>x===b[k]))continue;const start=i===0&&s.cap==="square"?-w:0,end=i===ps.length-2&&s.cap==="square"?w:0;
          const quad:[[P,number,number],...Array<[P,number,number]>]=[[a,-w-1,start],[a,w+1,start],[b,w+1,end],[a,-w-1,start],[b,w+1,end],[b,-w-1,end]];
          for(const [p,x,y] of quad)emit(p,a,b,2,[x,y],[x/w,0],7);
        }
        if(s.cap==="round"){point(ps[0]!,s.lineWidth,1);point(ps.at(-1)!,s.lineWidth,1);}
        for(let i=1;i<ps.length-1;i++){
          const p=ps[i]!,a=ps[i-1]!,b=ps[i+1]!;
          if(s.join==="round")point(p,s.lineWidth,1);
          else for(const side of [-1,1]){emit(p,a,p,2,[side*w,0],[side,0],0);if(s.join==="miter")emit(p,a,b,3,[side*w,0],[side,0],0);else emit(p,p,p,0,[0,0],[0,0],0);emit(p,p,b,2,[side*w,0],[side,0],0);}
        }
      }
      if(feature.kind==="polygon"){
        const triangles=triangulateVectorPolygon(feature.rings);
        const edgeLength=(a:P,b:P)=>Math.hypot(b[0]-a[0],b[2]-a[2]);
        const longest=Math.max(...triangles.flatMap(t=>t.map((p,i)=>edgeLength(p,t[(i+1)%3]!))));
        const levels=s.drape&&dataset?Math.max(0,Math.ceil(Math.log2(longest/Math.min(...dataset.spacing)))):0;
        if(levels>9||triangles.length*4**levels*3+vertices.length>3_000_000)throw new Forge3DResourceError();
        const midpoint=(a:P,b:P):P=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
        const roof=(a:P,b:P,c:P,level:number):void=>{
          if(level===0){for(const source of [a,b,c]){const p=drape(source);emit(p,p,p,0,[0,0],[0,0],0,s.extrusion);}return;}
          const ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
          roof(a,ab,ca,level-1);roof(ab,b,bc,level-1);roof(ca,bc,c,level-1);roof(ab,bc,ca,level-1);
        };
        for(const [a,b,c] of triangles)roof(a!,b!,c!,levels);
        if(s.extrusion>0)for(const ring of feature.rings)for(let i=0;i<ring.length;i++){
          const start=ring[i]!,end=ring[(i+1)%ring.length]!,segments=2**levels;
          const at=(t:number):P=>drape([start[0]+(end[0]-start[0])*t,start[1]+(end[1]-start[1])*t,start[2]+(end[2]-start[2])*t]);
          for(let j=0;j<segments;j++){const a=at(j/segments),b=at((j+1)/segments);for(const [p,e] of [[a,0],[b,0],[b,s.extrusion],[a,0],[b,s.extrusion],[a,s.extrusion]] as [P,number][])emit(p,p,p,0,[0,0],[0,0],0,e);}
        }
      }
      if(vertices.length>3_000_000)throw new Forge3DResourceError();
    }
    atlasY+=atlas?.height??0;
  }
  return {vertices,oit:snapshot.oit,culling:snapshot.culling,featureCount,atlas:{width:atlasWidth,height:atlasHeight,rgba:[...rgba]},highlights};
}
class Forge3DResourceError extends Error {readonly code="RESOURCE_LIMIT_EXCEEDED";constructor(){super("Vector geometry or atlas exceeds the bounded vector budget");}}
