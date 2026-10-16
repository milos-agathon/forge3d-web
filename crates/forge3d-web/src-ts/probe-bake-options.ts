import { finite, scatterInvalid } from "./scatter-mesh.js";
export interface ProbeReflectionMaterial {
  albedoMode: "material" | "colormap" | "mix"; colormapStrength: number;
  rawHeightRange: readonly [number, number];
  overlay: null | { domain: readonly [number, number]; strength: number; offset: number; blendMode: "alpha" | "add" | "multiply" | "replace"; stops: readonly (readonly [number, readonly [number, number, number]])[] };
  grassColor: readonly [number, number, number]; dirtColor: readonly [number, number, number];
  rockColor: readonly [number, number, number]; snowColor: readonly [number, number, number];
  snowEnabled: boolean; snowAltitudeMin: number; snowAltitudeBlend: number;
  snowSlopeMaxDeg: number; snowSlopeBlendDeg: number; snowAspectInfluence: number;
  rockEnabled: boolean; rockSlopeMinDeg: number; rockSlopeBlendDeg: number;
  wetnessEnabled: boolean; wetnessStrength: number; wetnessSlopeInfluence: number;
}
export interface ProbeReflectionLighting {
  /** y-up world-space direction toward the light. */
  lightDirection?: readonly [number, number, number]; lightColor?: readonly [number, number, number]; lightIntensity?: number;
  /** Native equirectangular, interleaved linear RGB, independent of runtime IBL ownership. */
  environment?: { width: number; height: number; data: Float32Array };
  environmentIntensity?: number; environmentRotationDegrees?: number;
}
export function getTerrainProbeMaterialDefaults(color: readonly [number, number, number] = [.3,.4,.2]): ProbeReflectionMaterial {
  return {albedoMode:"material",colormapStrength:0,rawHeightRange:[0,1],overlay:null,grassColor:[...color],dirtColor:[...color],rockColor:[...color],snowColor:[...color],
    snowEnabled:false,snowAltitudeMin:0,snowAltitudeBlend:1,snowSlopeMaxDeg:45,snowSlopeBlendDeg:1,snowAspectInfluence:0,
    rockEnabled:false,rockSlopeMinDeg:45,rockSlopeBlendDeg:1,wetnessEnabled:false,wetnessStrength:0,wetnessSlopeInfluence:0};
}
export function normalizeProbeLighting(input: ProbeReflectionLighting = {}, skyIntensity = 1) {
  const direction=input.lightDirection ?? [0,1,0], color=input.lightColor ?? [1,1,1];
  if(direction.length!==3 || color.length!==3 || Math.hypot(...direction)<1e-8) scatterInvalid("probe light requires a nonzero direction and RGB color");
  direction.forEach(x=>finite(x,"light direction"));color.forEach(x=>finite(x,"light color",0));
  let environment:null | {width:number;height:number;data:Float32Array}=null;
  if(input.environment){
    const e=input.environment;
    if(!Number.isInteger(e.width)||!Number.isInteger(e.height)||e.width<1||e.height<1||e.width*e.height>262144||!(e.data instanceof Float32Array)||e.data.length!==e.width*e.height*3)scatterInvalid("probe environment must be packed RGB, at most 262144 pixels");
    e.data.forEach(x=>finite(x,"environment value",0));environment={width:e.width,height:e.height,data:e.data.slice()};
  }
  return {lightDirection:[direction[0],direction[2],direction[1]],lightColor:[...color],lightIntensity:finite(input.lightIntensity??1,"lightIntensity",0),environment,
    environmentIntensity:finite(input.environmentIntensity??skyIntensity,"environmentIntensity",0),environmentRotationRad:finite(input.environmentRotationDegrees??0,"environmentRotationDegrees")*Math.PI/180};
}
