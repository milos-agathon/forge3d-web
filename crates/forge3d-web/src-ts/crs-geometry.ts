import {planGeoJson} from './crs-geometry-plan.js';
import type {CrsTransformer} from './crs.js';
import type {CrsCoordinate,CrsGeoJson,CrsTransformOptions} from './crs-types.js';
/** Admit topology before copying; transform slots and bounds share the checked plan. */
export async function reprojectGeoJson<T extends CrsGeoJson>(transformer:CrsTransformer,input:T,source:string,target:string,options:CrsTransformOptions):Promise<T>{
 const plan=planGeoJson(input,transformer.maxPoints),result=plan.copy(input);
 for(const stride of [2,3,4] as const){
  const group=plan.points.map((point,index)=>({point,index})).filter(({point})=>point.value.length===stride);if(!group.length)continue;
  const converted=await transformer.transformCoords(group.map(({point})=>point.value) as unknown as CrsCoordinate[],source,target,{...options,stride,alwaysXY:true});
  group.forEach(({index},i)=>plan.apply(result,index,converted[i]!));
 }
 if(!plan.points.length)await transformer.transformCoords([],source,target,options);
 plan.finish(result);
 if('crs' in result)(result as CrsGeoJson).crs={type:'name',properties:{name:target}};
 return result;
}
