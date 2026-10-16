import { HdrFrame, AovFrame } from "./index.js";
import type { DenoiseSettingsInput } from './index.js';
/** Implemented by W06 Forge3DRuntime and Forge3DSession. Application-owned. */
export interface CodecDenoiseTarget {
    denoiseHdrFrame(frame: HdrFrame, aov?: AovFrame, settings?: DenoiseSettingsInput, options?: {
        signal?: AbortSignal;
    }): Promise<HdrFrame>;
}
export type CodecDenoiserSelection = {
    status: 'selected';
    id: 'webgpu-atrous';
    requested: 'atrous' | 'oidn';
    equivalent: boolean;
    revision: string;
    owner: 'W06';
} | {
    status: 'unavailable';
    code: 'UNSUPPORTED_FEATURE';
    reason: 'denoiser-target-required';
};
export interface CodecDenoiseOptions {
    settings?: DenoiseSettingsInput;
    signal?: AbortSignal;
}
export declare function selectCodecDenoiser(target: CodecDenoiseTarget | undefined, method?: 'atrous' | 'oidn'): CodecDenoiserSelection;
export declare function dispatchCodecDenoiser(target: CodecDenoiseTarget, frame: HdrFrame, guides: AovFrame, options: CodecDenoiseOptions, limit: number): Promise<HdrFrame>;
