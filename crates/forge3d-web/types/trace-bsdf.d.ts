import type { TraceVec3 } from "./trace-types.js";
import type { EffectiveTraceMaterial } from "./trace-scene.js";
export declare const reflectDirection: (incident: TraceVec3, normal: TraceVec3) => TraceVec3;
export declare function smithG1(cosine: number, alpha: number): number;
/** The same Lambert/GGX mixture used by scatter, evaluated for direct lights. */
export declare function traceBrdf(m: EffectiveTraceMaterial, n: TraceVec3, view: TraceVec3, light: TraceVec3): TraceVec3;
/** GGX half-vector importance sampling with the matching BRDF/PDF weight. */
export declare function sampleGgx(incident: TraceVec3, normal: TraceVec3, f0: TraceVec3, roughness: number, u: number, v: number, ax?: number, ay?: number): {
    direction: TraceVec3;
    weight: TraceVec3;
};
/** Schlick dielectric sampling; the face flag distinguishes entry from exit. */
export declare function sampleDielectric(incident: TraceVec3, normal: TraceVec3, frontFace: boolean, ior: number, u: number): TraceVec3;
/** Free-flight importance ratio for a scalar majorant and RGB extinction. */
export declare function mediumRatio(sigma: TraceVec3, majorant: number, distance: number): TraceVec3;
