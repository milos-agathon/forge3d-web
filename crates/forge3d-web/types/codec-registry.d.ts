import type { CodecDenoiseTarget, CodecDenoiseOptions, CodecDenoiserSelection } from './codec-denoiser.js';
import { HdrFrame, AovFrame } from "./index.js";
import type { CodecFormat, CodecDecodeOptions, CodecReplayOptions, CodecRegistryOptions, CodecRegistryStats, CodecResult, CodecSelection, CodecSource } from './codec-types.js';
/** Integrated E05 dispatch. Platform adapters and feature codecs retain ownership. */
export declare class CodecRegistry {
    #private;
    constructor(options?: CodecRegistryOptions);
    capabilities(): readonly CodecSelection[];
    select(format: string): CodecSelection;
    decode<F extends CodecFormat>(format: F, source: CodecSource, options?: CodecDecodeOptions): Promise<CodecResult<F>>;
    replay<F extends CodecFormat>(key: string, options: CodecReplayOptions<F>): Promise<CodecResult<F>>;
    replay(key: string, options?: Pick<CodecDecodeOptions, 'signal'>): Promise<CodecResult>;
    denoiserCapability(target?: CodecDenoiseTarget, method?: 'atrous' | 'oidn'): CodecDenoiserSelection;
    denoise(target: CodecDenoiseTarget, frame: HdrFrame, guides: AovFrame, options?: CodecDenoiseOptions): Promise<HdrFrame>;
    stats(): CodecRegistryStats;
    dispose(): Promise<void>;
}
