import type {Forge3DScene} from './scene.js';
import type {SceneNodeId} from './index.js';
import type {LabelRect} from './label-types.js';
import type {LabelPlacementReport} from './labels.js';
export interface LabelView {report:LabelPlacementReport;hits:{id:number;bounds:LabelRect}[];}
/** Geometry and picking publish together only after scene attachment succeeds. */
export class CommittedLabelViews {
 readonly #attached=new Map<Forge3DScene,{view:LabelView;ids:SceneNodeId[];generation:number}>();
 #standalone:{view:LabelView;generation:number}|undefined;#generation=0;
 render(view:LabelView):void{this.#standalone={view,generation:++this.#generation};}
 attach(scene:Forge3DScene,view:LabelView):void{
  const ids:SceneNodeId[]=[];
  try{for(const node of view.report.nodes)ids.push(scene.addNode(node));}catch(error){for(const id of ids)scene.removeNode(id);throw error;}
  for(const id of this.#attached.get(scene)?.ids??[])scene.removeNode(id);
  this.#attached.set(scene,{view,ids,generation:++this.#generation});
 }
 detach(scene:Forge3DScene):void{const current=this.#attached.get(scene);if(!scene.disposed)for(const id of current?.ids??[])scene.removeNode(id);this.#attached.delete(scene);}
 pick(x:number,y:number,scene?:Forge3DScene):number|null{
  const selected=scene?this.#attached.get(scene):[...this.#attached.values(),...this.#standalone?[this.#standalone]:[]].sort((a,b)=>b.generation-a.generation)[0];
  return [...selected?.view.hits??[]].reverse().find(p=>x>=p.bounds[0]&&x<=p.bounds[2]&&y>=p.bounds[1]&&y<=p.bounds[3])?.id??null;
 }
 remove(id:number):void{for(const entry of [...this.#attached.values(),...this.#standalone?[this.#standalone]:[]])entry.view.hits=entry.view.hits.filter(p=>p.id!==id);}
 clear():void{for(const scene of this.#attached.keys())this.detach(scene);this.#standalone=undefined;}
}
