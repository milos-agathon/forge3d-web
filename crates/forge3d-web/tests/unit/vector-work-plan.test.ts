import {expect,it,vi} from 'vitest';
import {VectorLayers} from '../../src-ts/vector-layers.js';
import {compileVectorPacket} from '../../src-ts/vector-geometry.js';
import {TerrainDataset} from '../../src-ts/terrain-dataset.js';
it('rejects aggregate draped expansion before terrain queries or vertex emission',()=>{
 const layers=new VectorLayers();layers.add({name:'many',style:{drape:true},features:Array.from({length:170},(_,i)=>({id:i+1,kind:'line' as const,positions:[[0,0,0],[1000,0,0]] as [number,number,number][]}))});
 const query=vi.spyOn(TerrainDataset.prototype,'query');try{expect(()=>compileVectorPacket(layers,{width:2,height:2,spacing:[1,1],heights:new Float32Array(4)})).toThrow('bounded vector budget');expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();layers.dispose();}
});
