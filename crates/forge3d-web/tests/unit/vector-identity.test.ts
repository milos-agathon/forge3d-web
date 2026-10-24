import {expect,it} from 'vitest';
import {compileStyle,parseStyle} from '../../src-ts/map-style.js';
import {VectorLayers} from '../../src-ts/vector-layers.js';
it('composes independent style imports deterministically while retaining selection and lineage',()=>{
 const make=(source:string)=>compileStyle(parseStyle({layers:[{id:source,type:'circle',source}]}),{[source]:[{id:7,kind:'point',position:[0,0,0]}]}).layers[0] as any;
 const a=make('roads'),b=make('places'),graph=new VectorLayers();const first=graph.add(a.source.data);graph.setSelection('kept',[first.snapshot().features[0]!.id]);const second=graph.add(b.source.data);
 expect(second.snapshot().features[0]!.id).not.toBe(first.snapshot().features[0]!.id);expect(graph.getSelection('kept')!.ids).toEqual([first.snapshot().features[0]!.id]);expect(second.snapshot().features[0]!.properties!.forge3d_identity).toEqual({source:'style:places',sourceId:7});
 const repeated=new VectorLayers();repeated.add(a.source.data);repeated.add(b.source.data);expect(repeated.snapshot().layers).toEqual(graph.snapshot().layers);expect(a.source.data.features[0].id).toBe(1);
 expect(()=>graph.add({name:'explicit',features:[{id:1,kind:'point',position:[1,0,0]}]})).toThrow('duplicate');
});
