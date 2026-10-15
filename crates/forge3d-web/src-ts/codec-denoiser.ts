import { Forge3DError } from './index.js';
import { DenoiseSettings } from './offline.js';
import { HdrFrame, AovFrame } from './frames.js';
import { DENOISER_REVISION } from './codec-catalog.js';
import { checkCodecBytes, codecFailure } from './codec-dispatch.js';
import type { DenoiseSettingsInput } from './index.js';

/** Implemented by W06 Forge3DRuntime and Forge3DSession. Application-owned. */
export interface CodecDenoiseTarget {
  denoiseHdrFrame(frame: HdrFrame, aov?: AovFrame, settings?: DenoiseSettingsInput): Promise<HdrFrame>;
}
export type CodecDenoiserSelection =
  | { status: 'selected'; id: 'webgpu-atrous'; requested: 'atrous' | 'oidn'; equivalent: boolean; revision: string; owner: 'W06' }
  | { status: 'unavailable'; code: 'UNSUPPORTED_FEATURE'; reason: 'denoiser-target-required' };
export interface CodecDenoiseOptions {
  settings?: DenoiseSettingsInput;
  signal?: AbortSignal;
}
export function selectCodecDenoiser(target: CodecDenoiseTarget | undefined, method: 'atrous' | 'oidn' = 'atrous'): CodecDenoiserSelection {
  if (method !== 'atrous' && method !== 'oidn') throw codecFailure('INVALID_INPUT', 'invalid-denoiser', 'Denoiser must be atrous or oidn');
  if (!target || typeof target.denoiseHdrFrame !== 'function') return { status: 'unavailable', code: 'UNSUPPORTED_FEATURE', reason: 'denoiser-target-required' };
  return { status: 'selected', id: 'webgpu-atrous', requested: method, equivalent: method === 'oidn', revision: DENOISER_REVISION, owner: 'W06' };
}
export async function dispatchCodecDenoiser(target: CodecDenoiseTarget, frame: HdrFrame, guides: AovFrame, options: CodecDenoiseOptions, limit: number): Promise<HdrFrame> {
  if (!(frame instanceof HdrFrame) || !(guides instanceof AovFrame) || frame.width !== guides.width || frame.height !== guides.height) throw codecFailure('INVALID_INPUT', 'invalid-denoise-guides', 'Matching HDR and AOV frames are required');
  const settings = new DenoiseSettings({ ...options.settings, enabled: true });
  if (settings.method === 'none') throw codecFailure('INVALID_INPUT', 'invalid-denoiser', 'A registry denoise operation requires an active denoiser');
  if ((settings.guides.albedo && !guides.hasAlbedo) || (settings.guides.normal && !guides.hasNormal) || (settings.guides.depth && !guides.hasDepth)) throw codecFailure('INVALID_INPUT', 'missing-denoise-guide', 'Every enabled AOV guide must be present');
  checkCodecBytes(frame.width * frame.height * 68, limit);
  // W06 owns GPU admission, exclusive readback, device-loss checks and buffer release.
  try { return await target.denoiseHdrFrame(frame, guides, { ...settings.toJSON(), method: 'atrous' }); }
  catch (error) { throw Forge3DError.from(error); }
}
