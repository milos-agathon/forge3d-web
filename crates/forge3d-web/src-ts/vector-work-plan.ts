import {normalizeVectorStyle,vectorInvalid} from './vector-layers.js';
import {Forge3DError} from './runtime-failure.js';
import {triangulateVectorPolygon} from './vector-triangulation.js';
import type {VectorSnapshot,VectorPosition} from './vector-types.js';
const limit=()=>{throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Vector geometry or atlas exceeds the bounded vector budget');};
/** Resolves styles and all expansion counts before allocating atlases or emitting vertices. */
export function planVectorWork(snapshot:VectorSnapshot,spacing?:readonly number[]){
 let width=1,height=0,total=0;
 const layers=snapshot.layers.filter(l=>l.visible).map(layer=>{
  width=Math.max(width,layer.atlas?.width??0);const atlasY=height;height+=layer.atlas?.height??0;if(height>4096)limit();
  const features=layer.features.flatMap(feature=>{
   const style=normalizeVectorStyle({...layer.style,...feature.style});if(style.opacity*style.color[3]===0)return [];
   if(style.drape&&!spacing)throw vectorInvalid('draped vectors require terrain');
   const step=spacing?Math.min(...spacing):1;let vertices=0,levels=0;const segments:number[]=[];let triangles:VectorPosition[][]=[];
   if(feature.kind==='point')vertices=6;
   if(feature.kind==='line'){
    let dense=1,nonzero=0;
    for(let i=0;i<feature.positions.length-1;i++){const a=feature.positions[i]!,b=feature.positions[i+1]!,n=style.drape?Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/step)):1;if(n>100000)limit();segments.push(n);dense+=n;if(a[0]!==b[0]||a[2]!==b[2]||(!style.drape&&a[1]!==b[1]))nonzero+=n;}
    vertices=nonzero*6+(style.cap==='round'?12:0)+Math.max(0,dense-2)*(style.join==='miter'?12:6);
   }
   if(feature.kind==='polygon'){
    triangles=triangulateVectorPolygon(feature.rings);let longest=0;
    for(const triangle of triangles)for(let i=0;i<3;i++){const a=triangle[i]!,b=triangle[(i+1)%3]!;longest=Math.max(longest,Math.hypot(b[0]-a[0],b[2]-a[2]));}
    levels=style.drape?Math.max(0,Math.ceil(Math.log2(longest/step))):0;if(levels>9)limit();
    vertices=triangles.length*4**levels*3*(style.extrusion>0?2:1)+(style.extrusion>0?feature.rings.reduce((n,r)=>n+r.length,0)*2**levels*6:0);
   }
   total+=vertices;if(!Number.isSafeInteger(total)||total>3000000)limit();
   return [{feature,style,segments,triangles,levels}];
  });
  return {layer,atlasY,features};
 });
 return {layers,atlasWidth:width,atlasHeight:Math.max(1,height),vertices:total};
}
