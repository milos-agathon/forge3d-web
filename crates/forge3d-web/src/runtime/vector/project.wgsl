struct Source { position:vec4<f32>, previous:vec4<f32>, next:vec4<f32>, offset:vec4<f32>, color:vec4<f32>, tags:vec4<u32>, atlas:vec4<f32>, options:vec4<f32> };
struct Projected { clip:vec4<f32>, color:vec4<f32>, uv:vec4<f32>, world:vec4<f32>, tags:vec4<u32> };
struct Params { vp:mat4x4<f32>, viewport:vec4<f32>, eye:vec4<f32>, forward:vec4<f32>, camera:vec4<f32> };
@group(0) @binding(0) var<storage,read> source:array<Source>;
@group(0) @binding(1) var<storage,read_write> scratch:array<Projected>;
@group(0) @binding(2) var<storage,read_write> output:array<Projected>;
@group(0) @binding(3) var<storage,read_write> commands:array<u32>;
@group(0) @binding(4) var<uniform> params:Params;
fn direction(a:vec4<f32>,b:vec4<f32>)->vec2<f32> {
 let d=(b.xy/max(b.w,1e-6)-a.xy/max(a.w,1e-6))*params.viewport.xy;
 if(dot(d,d)<1e-10){return vec2<f32>(1,0);}return normalize(d);
}
fn project(v:Source)->Projected {
 let world=vec3<f32>(v.position.x,v.position.y+v.position.w,v.position.z);
 var clip=params.vp*vec4<f32>(world,1);
 let a=params.vp*vec4<f32>(v.previous.xyz,1);let b=params.vp*vec4<f32>(v.next.xyz,1);
 let expansion=u32(v.previous.w);var offset=vec2<f32>(0);
 if(expansion==1u){offset=v.offset.xy;}
 if(expansion>=2u){let d=direction(a,b);let n=vec2<f32>(-d.y,d.x);offset=n*v.offset.x+d*v.offset.y;
  if(expansion==3u){let d0=direction(a,clip);let d1=direction(clip,b);let n0=vec2<f32>(-d0.y,d0.x);let n1=vec2<f32>(-d1.y,d1.x);let sum=n0+n1;var miter=n1;if(dot(sum,sum)>1e-10){miter=normalize(sum);}let factor=1.0/max(abs(dot(miter,n1)),1e-4);if(factor<=v.next.w){offset=miter*v.offset.x*factor;}else{offset=n*v.offset.x;}}
 }
 clip=vec4<f32>(clip.xy+offset*2.0/params.viewport.xy*clip.w,clip.z-v.options.x*1e-5*clip.w,clip.w);
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
// Stable compaction preserves standard alpha ordering and ID ties.
@compute @workgroup_size(1) fn compact(){
 var count=0u;for(var tri=0u;tri<u32(params.viewport.z)/3u;tri++){if(commands[4u+tri]!=0u){for(var j=0u;j<3u;j++){output[count+j]=scratch[tri*3u+j];}count+=3u;}}
 commands[0]=count;commands[1]=1u;commands[2]=0u;commands[3]=0u;
}
