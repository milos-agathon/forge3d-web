struct Source { position:vec4<f32>, previous:vec4<f32>, next:vec4<f32>, offset:vec4<f32>, color:vec4<f32>, tags:vec4<u32>, atlas:vec4<f32>, options:vec4<f32> };
struct Projected { clip:vec4<f32>, color:vec4<f32>, uv:vec4<f32>, world:vec4<f32>, tags:vec4<u32> };
struct Params { vp:mat4x4<f32>, viewport:vec4<f32>, eye:vec4<f32>, forward:vec4<f32>, camera:vec2<f32>, projection_round_mask:u32, padding:u32 };
@group(0) @binding(0) var<storage,read> source:array<Source>;
@group(0) @binding(1) var<storage,read_write> scratch:array<Projected>;
@group(0) @binding(2) var<storage,read_write> output:array<Projected>;
@group(0) @binding(3) var<storage,read_write> commands:array<u32>;
@group(0) @binding(4) var<uniform> params:Params;
fn direction(a:vec4<f32>,b:vec4<f32>)->vec2<f32> {
 let d=(b.xy/max(b.w,1e-6)-a.xy/max(a.w,1e-6))*params.viewport.xy;
 if(dot(d,d)<1e-10){return vec2<f32>(1,0);}return normalize(d);
}
// Host sets this dynamic mask to all ones: every binary32 bit is preserved.
// The shader compiler cannot fold the unknown integer AND into an identity
// and contract products/sums into FMAs. A constant identity bitcast cannot
// provide that boundary. Keep the same scalar operation order on the CPU.
fn projection_round(value:f32)->f32 {
 return bitcast<f32>(bitcast<u32>(value)&params.projection_round_mask);
}
fn projection_round4(value:vec4<f32>)->vec4<f32> {
 return bitcast<vec4<f32>>(bitcast<vec4<u32>>(value)&vec4<u32>(params.projection_round_mask));
}
fn projection_transform(point:vec4<f32>)->vec4<f32> {
 let x=projection_round4(params.vp[0]*point.x);let y=projection_round4(params.vp[1]*point.y);
 let z=projection_round4(params.vp[2]*point.z);let w=projection_round4(params.vp[3]*point.w);
 return projection_round4(projection_round4(projection_round4(x+y)+z)+w);
}
fn project(v:Source)->Projected {
 let world=vec3<f32>(v.position.x,projection_round(v.position.y+v.position.w),v.position.z);
 var clip=projection_transform(vec4<f32>(world,1));
 let expansion=u32(v.previous.w);var offset=vec2<f32>(0);
 if(expansion==1u){offset=v.offset.xy;}
 if(expansion>=2u){let a=projection_transform(vec4<f32>(v.previous.xyz,1));let b=projection_transform(vec4<f32>(v.next.xyz,1));let d=direction(a,b);let n=vec2<f32>(-d.y,d.x);offset=n*v.offset.x+d*v.offset.y;
  if(expansion==3u){let d0=direction(a,clip);let d1=direction(clip,b);let n0=vec2<f32>(-d0.y,d0.x);let n1=vec2<f32>(-d1.y,d1.x);let sum=n0+n1;var miter=n1;if(dot(sum,sum)>1e-10){miter=normalize(sum);}let factor=1.0/max(abs(dot(miter,n1)),1e-4);if(factor<=v.next.w){offset=miter*v.offset.x*factor;}else{offset=n1*v.offset.x;}}
 }
 let bias=projection_round(projection_round(v.options.x*1e-5)*clip.w);
 clip=vec4<f32>(clip.xy+offset*2.0/params.viewport.xy*clip.w,projection_round(clip.z-bias),clip.w);
 let biased_clip=clip;
 // Match the CPU clip storage precision across GPU arithmetic backends.
 clip=round(clip*524288.0)/524288.0;
 // Direct absolute clip rounding towards the camera. Its NDC error shrinks
 // with distance, and z down/w up cannot reverse the bias.
 if(v.options.x>0.0&&biased_clip.w>0.0&&biased_clip.z>=0.0&&biased_clip.z<=biased_clip.w){
  clip.z=floor(biased_clip.z*524288.0)/524288.0;
  clip.w=ceil(biased_clip.w*524288.0)/524288.0;
 }
 var color=v.color;if(expansion==1u&&max(abs(v.offset.x),abs(v.offset.y))*2.0/max(1.0,max(abs(v.offset.z),abs(v.offset.w)))<v.options.y){color.a=0;}
 let uv=v.offset.zw;let atlas=clamp(v.atlas.xy+(uv*vec2<f32>(.5,-.5)+vec2<f32>(.5))*v.atlas.zw,v.atlas.xy+v.options.zw,v.atlas.xy+v.atlas.zw-v.options.zw);
 return Projected(clip,color,vec4<f32>(uv,atlas),vec4<f32>(world,1),v.tags);
}
fn outside(p:vec4<f32>,plane:u32)->bool {
 switch(plane){case 0u:{return p.x < -p.w;}case 1u:{return p.x>p.w;}case 2u:{return p.y < -p.w;}case 3u:{return p.y>p.w;}case 4u:{return p.z<0;}case 5u:{return p.z>p.w;}default:{return p.w<=0;}}
}
@compute @workgroup_size(64) fn expand(@builtin(global_invocation_id) gid:vec3<u32>){
 let tri=gid.x;let count=u32(params.viewport.z);if(tri>=count/3u){return;}
 let a=project(source[tri*3u]);let b=project(source[tri*3u+1u]);let c=project(source[tri*3u+2u]);
 scratch[tri*3u]=a;scratch[tri*3u+1u]=b;scratch[tri*3u+2u]=c;
 var visible=a.color.a>0||b.color.a>0||c.color.a>0;
 for(var p=0u;p<7u;p++){if(outside(a.clip,p)&&outside(b.clip,p)&&outside(c.clip,p)){visible=false;}}
 commands[4u+tri]=select(0u,1u,visible);
}
// Hierarchical inclusive scan. Each level uses a parallel workgroup scan;
// the final scatter combines its three offsets, retaining source order.
var<workgroup> prefix:array<u32,256>;
fn scan(lane:u32,value:u32)->u32 {
 prefix[lane]=value;workgroupBarrier();
 for(var stride=1u;stride<256u;stride*=2u){
  var previous=0u;if(lane>=stride){previous=prefix[lane-stride];}
  workgroupBarrier();prefix[lane]+=previous;workgroupBarrier();
 }
 return prefix[lane];
}
@compute @workgroup_size(256) fn scan_triangles(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) block:vec3<u32>){
 let n=u32(params.viewport.z)/3u;var value=0u;if(gid.x<n){value=commands[4u+gid.x];}
 let inclusive=scan(lane,value);if(gid.x<n){commands[4u+n+gid.x]=inclusive;}
 if(lane==255u){commands[4u+2u*n+block.x]=inclusive;}
}
@compute @workgroup_size(256) fn scan_blocks(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) block:vec3<u32>){
 let n=u32(params.viewport.z)/3u;let blocks=(n+255u)/256u;var value=0u;if(gid.x<blocks){value=commands[4u+2u*n+gid.x];}
 let inclusive=scan(lane,value);if(gid.x<blocks){commands[4u+2u*n+blocks+gid.x]=inclusive;}
 if(lane==255u){commands[4u+2u*n+2u*blocks+block.x]=inclusive;}
}
@compute @workgroup_size(256) fn scan_supers(@builtin(local_invocation_index) lane:u32){
 let n=u32(params.viewport.z)/3u;let blocks=(n+255u)/256u;let supers=(blocks+255u)/256u;var value=0u;if(lane<supers){value=commands[4u+2u*n+2u*blocks+lane];}
 let inclusive=scan(lane,value);if(lane<supers){commands[4u+2u*n+2u*blocks+lane]=inclusive;}
 if(lane==0u){commands[0]=prefix[255]*3u;commands[1]=1u;commands[2]=0u;commands[3]=0u;}
}
@compute @workgroup_size(64) fn compact(@builtin(global_invocation_id) gid:vec3<u32>){
 let tri=gid.x;let n=u32(params.viewport.z)/3u;if(tri>=n||commands[4u+tri]==0u){return;}
 let blocks=(n+255u)/256u;let block=tri/256u;let superblock=block/256u;
 var offset=commands[4u+n+tri]-1u;
 if(block%256u!=0u){offset+=commands[4u+2u*n+blocks+block-1u];}
 if(superblock!=0u){offset+=commands[4u+2u*n+2u*blocks+superblock-1u];}
 for(var j=0u;j<3u;j++){output[offset*3u+j]=scratch[tri*3u+j];}
}
