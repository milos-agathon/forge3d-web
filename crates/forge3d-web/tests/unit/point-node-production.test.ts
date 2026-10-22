import {expect,it,vi} from 'vitest';
import {PointSource} from '../../src-ts/pointcloud-source.js';
it('shares one decoded node while one subscriber cancels and isolates returned data',async()=>{
 const source=new PointSource();let finish!:(value:{positions:Float64Array})=>void;
 const produce=vi.fn(()=>new Promise<{positions:Float64Array}>(resolve=>{finish=resolve;})),abort=new AbortController();
 const a=source.produceNode('a',produce,abort.signal),b=source.produceNode('a',produce);await Promise.resolve();abort.abort();await expect(a).rejects.toMatchObject({code:'REQUEST_CANCELLED'});finish({positions:new Float64Array([1,2,3])});const data=await b;data.positions[0]=9;expect((await source.produceNode('a',produce)).positions[0]).toBe(1);expect(produce).toHaveBeenCalledOnce();source.dispose();
});
it('failed production is retryable',async()=>{const source=new PointSource();await expect(source.produceNode('a',async()=>{throw new Error('decode');})).rejects.toThrow('decode');expect((await source.produceNode('a',async()=>({positions:new Float64Array([1,2,3])}))).positions.length).toBe(3);source.dispose();});
