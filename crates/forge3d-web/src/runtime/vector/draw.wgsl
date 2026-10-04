struct Projected { clip:vec4<f32>, color:vec4<f32>, uv:vec4<f32>, world:vec4<f32>, tags:vec4<u32> };
struct Params { vp:mat4x4<f32>, viewport:vec4<f32>, eye:vec4<f32>, forward:vec4<f32>, camera:vec2<f32>, projection_round_mask:u32, padding:u32 };
@group(0) @binding(0) var<storage,read> vertices:array<Projected>;
@group(0) @binding(1) var<uniform> params:Params;
@group(0) @binding(2) var atlas:texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler:sampler;
struct Out { @builtin(position) clip:vec4<f32>, @location(0) color:vec4<f32>, @location(1) uv:vec4<f32>, @location(2) world:vec3<f32>, @location(3) @interpolate(flat) tags:vec4<u32>, @location(4) @interpolate(flat) opaque:u32 };
// Pass classification uses source alpha, not perspective interpolation of 1.0.
@vertex fn vs(@builtin(vertex_index) index:u32)->Out {let v=vertices[index];return Out(v.clip,v.color,v.uv,v.world.xyz,v.tags,select(0u,1u,v.color.a>=1.0));}
fn coverage(v:Out)->vec4<f32> {
 var color=v.color;if(v.opaque!=0u){color.a=1.0;}let shape=v.tags.y;var distance=-1.0;
 if(shape==1u||shape==6u){distance=length(v.uv.xy)-1.0;}
 if(shape==2u||shape==5u){distance=max(abs(v.uv.x),abs(v.uv.y))-1.0;}
 if(shape==3u){distance=(abs(v.uv.x)+abs(v.uv.y)-1.0)*.70710678;}
 if(shape==4u){distance=max(-v.uv.y-1.0,abs(v.uv.x)*.89442719+v.uv.y*.44721359-.44721359);}
 if(shape==7u){distance=abs(v.uv.x)-1.0;}
 let aa=max(fwidth(distance),.0001);color.a*=1.0-smoothstep(-aa,aa,distance);
 if(shape==5u){color*=textureSample(atlas,atlas_sampler,v.uv.zw);}
 if(shape==6u){let z=sqrt(max(0.0,1.0-dot(v.uv.xy,v.uv.xy)));color=vec4<f32>(color.rgb*(.25+.75*z),color.a);}
 if(color.a<=.01){discard;}return color;
}
struct Weighted { @location(0) accum:vec4<f32>, @location(1) reveal:vec4<f32> };
@fragment fn fs_opaque(v:Out)->@location(0) vec4<f32>{if(v.opaque==0u){discard;}let c=coverage(v);return vec4<f32>(c.rgb*c.a,c.a);}
@fragment fn fs_weighted(v:Out)->Weighted {if(v.opaque!=0u){discard;}let c=coverage(v);let depth=length(v.world-params.eye.xyz);let weight=c.a*clamp(.03/(1e-5+pow(depth/200.0,4.0)),.01,3000.0);return Weighted(vec4<f32>(c.rgb*c.a,c.a)*weight,vec4<f32>(c.a));}
@fragment fn fs_standard(v:Out)->@location(0) vec4<f32>{if(v.opaque!=0u){discard;}let c=coverage(v);return vec4<f32>(c.rgb*c.a,c.a);}
struct Pick { @location(0) id:u32, @location(1) depth:f32, @location(2) world:vec4<f32> };
@fragment fn fs_pick(v:Out)->Pick {let c=coverage(v);return Pick(v.tags.x,v.clip.z,vec4<f32>(v.world,1));}
struct Aov { @location(0) depth:f32, @location(1) id:u32 };
// Reserved AOV namespace: full feature IDs are available in fs_pick only.
const AOV_ID_VECTOR:u32=0xffffffefu;
@fragment fn fs_aov(v:Out)->Aov {let c=coverage(v);return Aov(clamp((dot(v.world-params.eye.xyz,params.forward.xyz)-params.camera.x)/(params.camera.y-params.camera.x),0.0,1.0),AOV_ID_VECTOR);}
struct Surface { @location(0) albedo:vec4<f32>, @location(1) normal:vec4<f32> };
@fragment fn fs_surface(v:Out)->Surface {let c=coverage(v);var n=cross(dpdx(v.world),dpdy(v.world));if(dot(n,params.eye.xyz-v.world)<0.0){n=-n;}return Surface(c,vec4<f32>(n/max(length(n),1e-6),1));}
