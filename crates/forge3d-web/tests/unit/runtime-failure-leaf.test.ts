import { expect,it,vi } from 'vitest';
vi.mock('../../src-ts/index.js',()=>{throw Error('low-level import reached facade');});
import { readByteSource } from '../../src-ts/browser-io.js';
it('loads and executes the low-level byte reader without evaluating the facade',async()=>{
 expect(await readByteSource(new Uint8Array([1,2]))).toEqual(new Uint8Array([1,2]));
 await expect(readByteSource(new Uint8Array([1,2]),{maxBytes:1})).rejects.toHaveProperty('code','RESOURCE_LIMIT_EXCEEDED');
});
