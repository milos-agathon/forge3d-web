import {Forge3DError} from './runtime-failure.js';
import type {CrsGeoJson} from './crs-types.js';
type Path=(string|number)[];
interface Bounds {path:Path;min:number[];max:number[];dimensions:number;count:number;}
const invalid=():never=>{throw new Forge3DError('INVALID_INPUT','Invalid GeoJSON geometry');};
/** One admitted topology traversal supplies copy locations and bound ancestry. */
export function planGeoJson(input:CrsGeoJson,maxPoints:number){
 const points:{path:Path;value:number[];bounds:Bounds[]}[]=[],bounded:Bounds[]=[];let nodes=0;
 const limit=()=>{throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Geometry topology budget exceeded');};
 const coordinates=(value:unknown,depth:number,path:Path,bounds:Bounds[]):void=>{
  if(!Array.isArray(value))invalid();const array=value as unknown[];
  if(++nodes>maxPoints*16)limit();
  if(depth>0){array.forEach((child,i)=>coordinates(child,depth-1,[...path,i],bounds));return;}
  if(array.length<2||array.length>4||array.some(n=>typeof n!=='number'||!Number.isFinite(n)))invalid();
  if(points.length>=maxPoints)throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Geometry exceeds maxPoints');
  points.push({path,value:array as number[],bounds});
 };
 let topologyNodes=0;
 const visit=(node:CrsGeoJson,path:Path,parents:Bounds[],depth=0):void=>{
  if(depth>128||++topologyNodes>maxPoints*4)limit();if(!node||typeof node!=='object')invalid();
  let bounds=parents;if(node.bbox){const b={path,min:[Infinity,Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity,-Infinity],dimensions:4,count:0};bounded.push(b);bounds=[...parents,b];}
  switch(node.type){
   case 'FeatureCollection':if(!Array.isArray(node.features))invalid();node.features!.forEach((child,i)=>visit(child,[...path,'features',i],bounds,depth+1));break;
   case 'GeometryCollection':if(!Array.isArray(node.geometries))invalid();node.geometries!.forEach((child,i)=>visit(child,[...path,'geometries',i],bounds,depth+1));break;
   case 'Feature':if(node.geometry!==null){if(!node.geometry)invalid();visit(node.geometry!,[...path,'geometry'],bounds,depth+1);}break;
   default:{const dimensions:Record<string,number>={Point:0,MultiPoint:1,LineString:1,MultiLineString:2,Polygon:2,MultiPolygon:3};const d=dimensions[node.type];if(d===undefined)invalid();coordinates(node.coordinates,d!,[...path,'coordinates'],bounds);}
  }
 };
 visit(input,[],[]);
 // Bound non-coordinate metadata too, before structuredClone can duplicate it.
 let copyBytes=0;const copyLimit=Math.max(65536,maxPoints*4096),seen=new Set<object>(),pending:unknown[]=[input];
 while(pending.length){const value=pending.pop();
  if(typeof value==='string')copyBytes+=value.length*2;
  else if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);copyBytes+=32;
   if(ArrayBuffer.isView(value))copyBytes+=value.byteLength;
   else if(value instanceof ArrayBuffer)copyBytes+=value.byteLength;
   else for(const key of Object.keys(value)){copyBytes+=key.length*2+8;pending.push((value as Record<string,unknown>)[key]);}
  }else copyBytes+=8;
  if(copyBytes>copyLimit)throw new Forge3DError('RESOURCE_LIMIT_EXCEEDED','Geometry copy budget exceeded');
 }

 const at=(root:any,path:Path):any=>path.reduce((value,key)=>value[key],root);
 return {
  points,
  copy<T extends CrsGeoJson>(source:T):T{try{return structuredClone(source);}catch{return invalid();}},
  apply(root:CrsGeoJson,index:number,value:readonly number[]):void{
   const point=points[index]!,slot=at(root,point.path) as number[];slot.splice(0,slot.length,...value);
   for(const bounds of point.bounds){bounds.count++;bounds.dimensions=Math.min(bounds.dimensions,value.length);for(let i=0;i<value.length;i++){bounds.min[i]=Math.min(bounds.min[i]!,value[i]!);bounds.max[i]=Math.max(bounds.max[i]!,value[i]!);}}
  },
  finish(root:CrsGeoJson):void{for(const b of bounded){const node=at(root,b.path);if(b.count)node.bbox=[...b.min.slice(0,b.dimensions),...b.max.slice(0,b.dimensions)];else delete node.bbox;}},
 };
}
