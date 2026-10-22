import {expect,it} from 'vitest';
import {Forge3DScene} from '../../src-ts/scene.js';
import {prepareScenePacket} from '../../src-ts/scene-packet.js';
it('deduplicates shared backing buffers across cyclic custom packet payloads',()=>{
 const backing=new ArrayBuffer(16),payload:{a:Uint8Array;b:Uint32Array;self?:unknown}={a:new Uint8Array(backing),b:new Uint32Array(backing)};payload.self=payload;
 const scene=Forge3DScene.create();scene.addNode({kind:'custom',name:'owned',layerType:'test',payload});const packet=prepareScenePacket(scene);
 expect(packet.transfer).toHaveLength(1);structuredClone(packet.snapshot,{transfer:packet.transfer});expect(backing.byteLength).toBe(16);
 const retained=packet.committed.nodes[0]!.node;if(retained.kind!=='custom')throw Error('custom');expect((retained.payload as typeof payload).a.byteLength).toBe(16);scene.dispose();
});
