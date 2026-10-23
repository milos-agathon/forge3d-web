import {expect,it} from 'vitest';
import {PointSource} from '../../src-ts/pointcloud-source.js';
it('rejects whole-file replacement after ranged metadata and remains invalid',async()=>{
 let tag='"one"';const source=new PointSource({fetch:async(_url,{headers})=>headers.Range?new Response(new Uint8Array([1,2]),{status:206,headers:{etag:tag,'Content-Range':'bytes 0-1/4'}}):new Response(new Uint8Array([3,4,5,6]),{headers:{etag:tag}})});
 expect(await source.range('https://example.test/data',0,2)).toEqual(new Uint8Array([1,2]));tag='"two"';
 await expect(source.read('https://example.test/data')).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'source-generation-changed'}});
 await expect(source.range('https://example.test/data',0,2)).rejects.toMatchObject({code:'IO_ERROR'});source.dispose();
});
it('rejects ranged replacement after a whole-file generation',async()=>{
 const source=new PointSource({fetch:async(_url,{headers})=>headers.Range?new Response(null,{status:412}):new Response(new Uint8Array([1,2,3,4]),{headers:{etag:'"one"'}})});
 await source.read('https://example.test/data');await expect(source.range('https://example.test/data',2,2)).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'source-generation-changed'}});source.dispose();
});

it('rejects an unverifiable same-size representation transition without validators',async()=>{
 const source=new PointSource({fetch:async(_url,{headers})=>headers.Range?new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Range':'bytes 0-1/4'}}):new Response(new Uint8Array([9,9,9,9]))});
 await source.range('https://example.test/data',0,2);
 await expect(source.read('https://example.test/data')).rejects.toMatchObject({code:'IO_ERROR',details:{reason:'source-generation-changed'}});
 source.dispose();
});
