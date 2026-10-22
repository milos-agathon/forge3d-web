import { expect,it } from 'vitest';
import { Forge3DError as PublicError } from '../../src-ts/index.js';
import { Forge3DError, normalizeErrorCode, transportFailure } from '../../src-ts/runtime-failure.js';
it('preserves public identity, known codes, details and unknown-code fallback',()=>{
 expect(PublicError).toBe(Forge3DError);
 const known=['WEBGPU_UNAVAILABLE','WEBGPU_ADAPTER_UNAVAILABLE','INSECURE_CONTEXT','WASM_LOAD_FAILED','DEVICE_REQUEST_FAILED','DEVICE_LOST','SURFACE_CREATE_FAILED','SURFACE_LOST','SURFACE_OUTDATED','OUT_OF_MEMORY','UNSUPPORTED_FEATURE','INVALID_INPUT','IO_ERROR','REQUEST_CANCELLED','SHADER_COMPILATION_FAILED','INTERNAL_ERROR','RESOURCE_LIMIT_EXCEEDED','RUNTIME_DISPOSED'];
 for(const code of known){expect(Forge3DError.from({code,message:'failure',details:{a:1}})).toMatchObject({code,details:{a:1}});expect(normalizeErrorCode(code)).toBe(code);}
 for(const code of ['new-code',null,{},42])expect(Forge3DError.from({code,message:'failure'}).code).toBe('INTERNAL_ERROR');
 const details={items:[1]},error=new Forge3DError('IO_ERROR','failure',details),wire=transportFailure(error);details.items.push(2);expect(wire.details).toEqual({items:[1]});expect(Forge3DError.from(error)).toBe(error);
 expect(transportFailure(new Forge3DError('IO_ERROR','failure',()=>{}))).not.toHaveProperty('details');
});
