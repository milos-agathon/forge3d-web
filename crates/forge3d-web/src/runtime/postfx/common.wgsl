struct Params {
    size: vec4<u32>, // width, height, lane, history frames
    control: vec4<u32>, // history valid, auxiliary mode, debug mip, surface is sRGB
    a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, d: vec4<f32>,
    inverse_vp: mat4x4<f32>, view_projection: mat4x4<f32>,
    eye: vec4<f32>, forward: vec4<f32>, camera: vec4<f32>, // near, far, jitter x/y
};
@group(0) @binding(0) var color_tex: texture_2d<f32>;
@group(0) @binding(1) var depth_tex: texture_2d<f32>;
@group(0) @binding(2) var normal_tex: texture_2d<f32>;
@group(0) @binding(3) var albedo_tex: texture_2d<f32>;
@group(0) @binding(4) var motion_tex: texture_2d<f32>;
@group(0) @binding(5) var history_tex: texture_2d<f32>;
@group(0) @binding(6) var old_depth_tex: texture_2d<f32>;
@group(0) @binding(7) var old_id_tex: texture_2d<u32>;
@group(0) @binding(8) var id_tex: texture_2d<u32>;
@group(0) @binding(9) var hzb_tex: texture_2d<f32>;
@group(0) @binding(10) var aux_tex: texture_2d<f32>;
@group(0) @binding(11) var output_tex: texture_storage_2d<rgba16float,write>;
@group(0) @binding(12) var<uniform> params: Params;
@group(0) @binding(13) var<storage,read> color_lut: array<vec4<f32>>;
@group(0) @binding(14) var ibl_specular:texture_cube<f32>;
@group(0) @binding(15) var ibl_irradiance:texture_cube<f32>;
@group(0) @binding(16) var ibl_sampler:sampler;
struct IblParams { enabled:u32,mip_count:u32,pad:vec2<u32>,intensity:f32,rotation:f32,pad2:vec2<f32> };
@group(0) @binding(17) var<uniform> ibl_params:IblParams;
@group(0) @binding(18) var ibl_brdf:texture_2d<f32>;
fn rotate_env(v:vec3<f32>)->vec3<f32>{let c=cos(ibl_params.rotation);let s=sin(ibl_params.rotation);return vec3<f32>(v.x*c+v.z*s,v.y,v.z*c-v.x*s);}
fn environment(direction:vec3<f32>,roughness:f32,specular:bool)->vec3<f32>{
    if ibl_params.enabled==0u{return params.c.xyz;}
    let d=rotate_env(direction);var value=vec3<f32>(0.);
    if specular {value=textureSampleLevel(ibl_specular,ibl_sampler,d,roughness*roughness*f32(max(ibl_params.mip_count,1u)-1u)).rgb;}
    else{value=textureSampleLevel(ibl_irradiance,ibl_sampler,d,0.).rgb;}
    return value*max(ibl_params.intensity,0.);
}
fn specular_weight(p:vec2<i32>,normal:vec3<f32>,view:vec3<f32>,roughness:f32)->vec3<f32>{
    let albedo=textureLoad(albedo_tex,p,0);let metallic=albedo.a;let f0=mix(vec3<f32>(.04),albedo.rgb,metallic);let ndv=clamp(dot(normal,view),0.,1.);
    let schlick=f0+(max(vec3<f32>(1.-roughness),f0)-f0)*pow(1.-ndv,5.);
    if ibl_params.enabled==0u{return schlick*(1.-roughness)*(1.-roughness);}
    let brdf=textureSampleLevel(ibl_brdf,ibl_sampler,vec2<f32>(ndv,roughness),0.).rg;return schlick*brdf.x+brdf.y;
}
fn bounded(p:vec2<i32>) -> vec2<i32> {return clamp(p,vec2<i32>(0),vec2<i32>(params.size.xy)-1);}
fn uv_at(p:vec2<f32>)->vec2<f32>{return (p+0.5)/vec2<f32>(params.size.xy);}
fn bilerp(tex:texture_2d<f32>, p:vec2<f32>)->vec4<f32>{
    let dim=vec2<i32>(textureDimensions(tex));let base=vec2<i32>(floor(p));let t=fract(p);
    let a=textureLoad(tex,clamp(base,vec2<i32>(0),dim-1),0);
    let b=textureLoad(tex,clamp(base+vec2<i32>(1,0),vec2<i32>(0),dim-1),0);
    let c=textureLoad(tex,clamp(base+vec2<i32>(0,1),vec2<i32>(0),dim-1),0);
    let d=textureLoad(tex,clamp(base+vec2<i32>(1,1),vec2<i32>(0),dim-1),0);
    return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
fn sample_uv(tex:texture_2d<f32>,uv:vec2<f32>)->vec4<f32>{return bilerp(tex,uv*vec2<f32>(textureDimensions(tex))-0.5);}
fn luma(c:vec3<f32>)->f32{return dot(c,vec3<f32>(0.2126,0.7152,0.0722));}
fn safe_normal(n:vec3<f32>)->vec3<f32>{return n*inverseSqrt(max(dot(n,n),1e-12));}
fn world_at(p:vec2<i32>)->vec3<f32>{return world_at_depth(uv_at(vec2<f32>(p)),textureLoad(depth_tex,p,0).r);}
fn world_at_depth(uv:vec2<f32>,depth:f32)->vec3<f32>{
    let ndc=vec2<f32>(uv.x*2.-1.,1.-uv.y*2.);
    let a=params.inverse_vp*vec4<f32>(ndc,0.,1.);let b=params.inverse_vp*vec4<f32>(ndc,1.,1.);
    let origin=a.xyz/a.w;let direction=safe_normal(b.xyz/b.w-origin);
    let distance=mix(params.camera.x,params.camera.y,depth);
    return origin+direction*((distance-dot(origin-params.eye.xyz,params.forward.xyz))/max(dot(direction,params.forward.xyz),1e-6));
}
fn project(point:vec3<f32>)->vec3<f32>{
    let clip=params.view_projection*vec4<f32>(point,1.);
    let ndc=clip.xyz/max(clip.w,1e-6);return vec3<f32>(ndc.x*.5+.5,.5-ndc.y*.5,clip.w);
}
fn view_distance(point:vec3<f32>)->f32{return dot(point-params.eye.xyz,params.forward.xyz);}
fn is_inside(uv:vec2<f32>)->bool{return all(uv>=vec2<f32>(0))&&all(uv<vec2<f32>(1));}
fn srgb_encode(c:vec3<f32>)->vec3<f32>{let v=max(c,vec3<f32>(0));return select(v*12.92,1.055*pow(v,vec3<f32>(1./2.4))-.055,v>vec3<f32>(.0031308));}
fn srgb_decode(c:vec3<f32>)->vec3<f32>{let v=max(c,vec3<f32>(0));return select(v/12.92,pow((v+.055)/1.055,vec3<f32>(2.4)),v>vec3<f32>(.04045));}
fn rgb_ycocg(c:vec3<f32>)->vec3<f32>{return vec3<f32>(dot(c,vec3<f32>(.25,.5,.25)),c.r*.5-c.b*.5,-c.r*.25+c.g*.5-c.b*.25);}
fn ycocg_rgb(c:vec3<f32>)->vec3<f32>{return vec3<f32>(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}
