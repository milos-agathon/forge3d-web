export interface ProbeReflectionMaterial {
    albedoMode: "material" | "colormap" | "mix";
    colormapStrength: number;
    rawHeightRange: readonly [number, number];
    overlay: null | {
        domain: readonly [number, number];
        strength: number;
        offset: number;
        blendMode: "alpha" | "add" | "multiply" | "replace";
        stops: readonly (readonly [number, readonly [number, number, number]])[];
    };
    grassColor: readonly [number, number, number];
    dirtColor: readonly [number, number, number];
    rockColor: readonly [number, number, number];
    snowColor: readonly [number, number, number];
    snowEnabled: boolean;
    snowAltitudeMin: number;
    snowAltitudeBlend: number;
    snowSlopeMaxDeg: number;
    snowSlopeBlendDeg: number;
    snowAspectInfluence: number;
    rockEnabled: boolean;
    rockSlopeMinDeg: number;
    rockSlopeBlendDeg: number;
    wetnessEnabled: boolean;
    wetnessStrength: number;
    wetnessSlopeInfluence: number;
}
export interface ProbeReflectionLighting {
    /** y-up world-space direction toward the light. */
    lightDirection?: readonly [number, number, number];
    lightColor?: readonly [number, number, number];
    lightIntensity?: number;
    /** Native equirectangular, interleaved linear RGB, independent of runtime IBL ownership. */
    environment?: {
        width: number;
        height: number;
        data: Float32Array;
    };
    environmentIntensity?: number;
    environmentRotationDegrees?: number;
}
export declare function getTerrainProbeMaterialDefaults(color?: readonly [number, number, number]): ProbeReflectionMaterial;
export declare function normalizeProbeLighting(input?: ProbeReflectionLighting, skyIntensity?: number): {
    lightDirection: number[];
    lightColor: number[];
    lightIntensity: number;
    environment: {
        width: number;
        height: number;
        data: Float32Array;
    } | null;
    environmentIntensity: number;
    environmentRotationRad: number;
};
