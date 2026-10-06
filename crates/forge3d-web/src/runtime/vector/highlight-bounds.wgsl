struct Highlight { ids:vec4<u32>, color:vec4<f32>, options:vec4<f32> };
struct Mode { values:vec4<u32>, options:vec4<f32> };
@group(0) @binding(0) var ids:texture_2d<u32>;
@group(0) @binding(1) var<storage,read> highlights:array<Highlight>;
@group(0) @binding(2) var<storage,read_write> bounds:array<atomic<u32>>;
@group(0) @binding(3) var<uniform> mode:Mode;
@compute @workgroup_size(1) fn reset(){let size=textureDimensions(ids);atomicStore(&bounds[0],size.x);atomicStore(&bounds[1],size.y);atomicStore(&bounds[2],0u);atomicStore(&bounds[3],0u);}
var<workgroup> local_bounds:array<vec4<u32>,64>;
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) p:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let size=textureDimensions(ids);var value=vec4<u32>(size,0u,0u);
 if(all(p.xy<size)){
  let id=textureLoad(ids,vec2<i32>(p.xy),0).x;var lo=0u;var hi=mode.values.y;
  if(id!=0u){while(lo<hi){let mid=lo+(hi-lo)/2u;if(highlights[mid].ids.x<id){lo=mid+1u;}else{hi=mid;}}
   if(lo<mode.values.y&&highlights[lo].ids.x==id){value=vec4<u32>(p.xy,p.xy);}
  }
 }
 local_bounds[lane]=value;workgroupBarrier();
 for(var stride=32u;stride>0u;stride/=2u){if(lane<stride){let other=local_bounds[lane+stride];local_bounds[lane]=vec4<u32>(min(local_bounds[lane].xy,other.xy),max(local_bounds[lane].zw,other.zw));}workgroupBarrier();}
 if(lane==0u){let b=local_bounds[0];if(all(b.xy<=b.zw)){atomicMin(&bounds[0],b.x);atomicMin(&bounds[1],b.y);atomicMax(&bounds[2],b.z);atomicMax(&bounds[3],b.w);}}
}
