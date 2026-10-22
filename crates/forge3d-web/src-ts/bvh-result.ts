import type {BvhNode,BvhStats,TraceTriangle} from './trace-types.js';
import {normalizeTriangles} from './bvh-build.js';
import {traceInvalid} from './trace-math.js';
export interface BvhResult {
 triangles:readonly TraceTriangle[];
 nodes:readonly BvhNode[];
 indices:Uint32Array;
 stats:Pick<BvhStats,'backend'|'method'|'buildTimeMs'>;
}
/** Validates a complete candidate before any installed state is touched. */
export function ownBvhResult(input:BvhResult) {
 const triangles=normalizeTriangles(input.triangles),nodes=structuredClone([...input.nodes]),indices=input.indices.slice();
 const count=triangles.length;
 if(indices.length!==count||new Set(indices).size!==count||indices.some(i=>i>=count))traceInvalid('BVH indices must be a complete primitive permutation');
 const seen=new Set<number>(),covered=new Set<number>();let maxDepth=0,leafCount=0;
 const stack:[[number,number]]=[[0,0]];
 while(stack.length){
  const [at,depth]=stack.pop()!;
  if(!Number.isSafeInteger(at)||at<0||at>=nodes.length||seen.has(at))traceInvalid('Invalid BVH topology');
  seen.add(at);maxDepth=Math.max(maxDepth,depth);const node=nodes[at]!;
  if([...node.min,...node.max].some(v=>!Number.isFinite(v))||node.min.some((v,i)=>v>node.max[i]!))traceInvalid('Invalid BVH bounds');
  if(!Number.isSafeInteger(node.count)||node.count<0||!Number.isSafeInteger(node.first)||node.first<0)traceInvalid('Invalid BVH leaf range');
  if(node.count){
   leafCount++;if(node.first+node.count>count||node.left!==0||node.right!==0)traceInvalid('Invalid BVH leaf range');
   for(let i=node.first;i<node.first+node.count;i++){if(covered.has(i))traceInvalid('Overlapping BVH leaves');covered.add(i);}
  }else{
   if(node.left<=at||node.right<=at)traceInvalid('BVH children must follow their parent');
   stack.push([node.left,depth+1],[node.right,depth+1]);
  }
 }
 if(seen.size!==nodes.length||covered.size!==count)traceInvalid('Incomplete BVH topology');
 return {triangles,nodes,indices,stats:{...input.stats,triangleCount:count,nodeCount:nodes.length,leafCount,maxDepth,memoryUsageBytes:count*68+nodes.length*48}};
}
