/** W11 ordered HDR effects. Colors and LUT entries are linear RGB. */
export type PostFxKind = "ssao" | "gtao" | "ssgi" | "ssr" | "bloom" | "dof" | "motion-blur" | "taa" | "accumulation-aa" | "denoise" | "tonemap" | "lens";
export type PostFxDebugView = "none" | "color" | "depth" | "normal" | "albedo" | "motion" | "hzb" | "effect";
export type PostFxHistoryReason = "first-frame" | "explicit" | "resize" | "camera-cut" | "scene" | "settings" | "device-loss";
export type PostFxQuality = "low" | "medium" | "high" | "ultra";
export type PostFxTonemapOperator = "none" | "reinhard" | "reinhard-extended" | "aces" | "uncharted2" | "exposure" | "display";
export interface ColorLutInput { size: number; data: readonly number[] | Float32Array; }
export interface PostFxBase { id?: string; enabled?: boolean; }
export type PostFxInput = PostFxBase & (
  | { kind: "ssao" | "gtao"; radius?: number; bias?: number; intensity?: number; samples?: number; bilateralRadius?: number; temporalWeight?: number }
  | { kind: "ssgi" | "ssr"; maxDistance?: number; thickness?: number; steps?: number; samples?: number; intensity?: number; temporalWeight?: number; bilateralRadius?: number; fallback?: [number, number, number] }
  | { kind: "bloom"; threshold?: number; softness?: number; strength?: number; radius?: number; quality?: PostFxQuality }
  | { kind: "dof"; aperture?: number; focusDistance?: number; focalLength?: number; sensorSize?: number; maxBlurRadius?: number; blurRadiusScale?: number; quality?: PostFxQuality; tiltPitch?: number; tiltYaw?: number; bokehRotation?: number }
  | { kind: "motion-blur"; shutter?: number; samples?: number; maxBlurPixels?: number }
  | { kind: "taa"; historyWeight?: number; clampGamma?: number; motionScale?: number; depthThreshold?: number; jitter?: boolean }
  | { kind: "accumulation-aa"; samples?: number; jitter?: boolean }
  | { kind: "denoise"; iterations?: number; sigmaColor?: number; sigmaDepth?: number; sigmaNormal?: number }
  | { kind: "tonemap"; operator?: PostFxTonemapOperator; exposure?: number; whitePoint?: number; gamma?: number; lut?: ColorLutInput; lutStrength?: number }
  | { kind: "lens"; distortion?: number; chromaticAberration?: number; vignetteStrength?: number; vignetteRadius?: number; vignetteSoftness?: number }
);
export interface PostFxChainInput { effects?: readonly PostFxInput[]; debug?: { view: PostFxDebugView; effectId?: string; hzbMip?: number }; }
/** Fully validated serializable boundary shared with WASM (unknown fields rejected). */
export interface PostFxEffectSnapshot {
  id: string; kind: PostFxKind; enabled: boolean;
  params: number[]; quality: PostFxQuality; operator: PostFxTonemapOperator;
  lut: { size: number; data: number[] } | null;
}
export interface PostFxSnapshot { effects: PostFxEffectSnapshot[]; debug: { view: PostFxDebugView; effectId: string | null; hzbMip: number }; }
export interface PostFxReport {
  enabled: boolean; width: number; height: number; gpuBytes: number; passOrder: string[];
  colorFormat: "rgba16float"; gbufferFormat: "rgba32float" | "rgba16float"; depthFormat: "r32float";
  sampling: "texture-load"; outputEncoding: "srgb"; historyValid: boolean; historyFrames: number;
  historyReason: PostFxHistoryReason; jitter: [number, number]; hzbLevels: number;
}
export interface PostFxFrame { width: number; height: number; channels: number; data: Float32Array; }
