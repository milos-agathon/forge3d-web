export type EnvironmentDebug =
  | "none"
  | "transmittance"
  | "clouds"
  | "water-mask"
  | "foam"
  | "reflection";
export interface SunPosition {
  azimuth: number;
  elevation: number;
  direction: [number, number, number];
  daytime: boolean;
}
export interface SunInput {
  latitude: number;
  longitude: number;
  utc: string;
  color?: [number, number, number];
  intensity?: number;
  timeScale?: number;
}
export interface SkyInput {
  model?: "preetham" | "hosek-wilkie";
  turbidity?: number;
  groundAlbedo?: number;
  sunSize?: number;
  sunIntensity?: number;
  aerialPerspective?: boolean;
  aerialDensity?: number;
  exposure?: number;
}
export interface FogInput {
  mode?: "uniform" | "height" | "exponential";
  scattering?: number;
  absorption?: number;
  density?: number;
  height?: number;
  falloff?: number;
  color?: [number, number, number];
  anisotropy?: number;
  godRays?: boolean;
  shaftIntensity?: number;
  shaftSamples?: number;
  useShadows?: boolean;
}
export interface CloudsInput {
  /** Native clip-space quad, or depth-clipped world-space clouds. */
  renderPath?: "native" | "world";
  color?: [number, number, number];
  scatterStrength?: number;
  mode?: "billboard" | "volumetric" | "hybrid";
  preset?: "static" | "gentle" | "moderate" | "stormy";
  density?: number;
  coverage?: number;
  scale?: number;
  height?: number;
  thickness?: number;
  wind?: [number, number];
  animationSpeed?: number;
  seed?: number;
  shadowStrength?: number;
  absorption?: number;
  anisotropy?: number;
  ambient?: number;
  fadeDistance?: number;
}
export interface DensityVolumeInput {
  bounds: [number, number, number, number, number, number];
  density?: number;
  color?: [number, number, number];
  anisotropy?: number;
  dimensions?: [number, number, number];
  data?: Float32Array | number[];
}
export interface WaterLayerInput {
  bounds: [number, number, number, number];
  height?: number;
  mode?: "disabled" | "transparent" | "reflective" | "animated";
  fresnelPower?: number;
  hueShift?: number;
  tintColor?: [number, number, number];
  tintStrength?: number;
  rippleScale?: number;
  rippleSpeed?: number;
  refractionStrength?: number;
  shoreAttenuationWidth?: number;
  waveDistortionStrength?: number;
  shallowColor?: [number, number, number];
  deepColor?: [number, number, number];
  depthScale?: number;
  alpha?: number;
  waveAmplitude?: number;
  waveFrequency?: number;
  waveSpeed?: number;
  flow?: [number, number];
  roughness?: number;
  reflection?: "sky" | "screen" | "planar";
  reflectionStrength?: number;
  foamWidth?: number;
  foamIntensity?: number;
  maskDimensions?: [number, number];
  mask?: Float32Array | number[];
}
export interface SunClock {
  latitude: number;
  longitude: number;
  unixSeconds: number;
  timeScale: number;
}
export interface EnvironmentInput {
  sunClock?: SunClock | null;
  sun?: SunInput;
  sunDirection?: [number, number, number];
  sunColor?: [number, number, number];
  sunIntensity?: number;
  sky?: SkyInput | null;
  fog?: FogInput | null;
  clouds?: CloudsInput | null;
  volumes?: DensityVolumeInput[];
  water?: WaterLayerInput[];
  quality?: "low" | "medium" | "high" | "ultra";
  resolutionScale?: 0.5 | 1;
  steps?: number;
  temporalWeight?: number;
  volumetricMode?: "raymarch" | "froxel";
  maxDistance?: number;
  debug?: EnvironmentDebug;
}
export interface EnvironmentSnapshot {
  sunClock: SunClock | null;
  sky: Required<SkyInput> | null;
  fog: Required<FogInput> | null;
  clouds: Required<Omit<CloudsInput, "preset">> | null;
  volumes: (Required<Omit<DensityVolumeInput, "data">> & {
    data: number[];
  })[];
  water: (Required<Omit<WaterLayerInput, "mask">> & {
    mask: number[];
  })[];
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  resolutionScale: 0.5 | 1;
  steps: number;
  temporalWeight: number;
  volumetricMode: "raymarch" | "froxel";
  maxDistance: number;
  debug: EnvironmentDebug;
}
export interface EnvironmentMemoryReport {
  gpuBytes: number;
  width: number;
  height: number;
  effectWidth: number;
  effectHeight: number;
  resolutionScale: number;
  steps: number;
  volumeCount: number;
  waterCount: number;
  historyValid: boolean;
}
