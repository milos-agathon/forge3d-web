@group(0) @binding(0) var color:texture_2d<f32>;
@group(0) @binding(1) var depth:texture_2d<f32>;
@group(0) @binding(2) var normal:texture_2d<f32>;
@group(0) @binding(3) var albedo:texture_2d<f32>;
@group(0) @binding(4) var motion:texture_2d<f32>;
@group(0) @binding(5) var hzb:texture_2d<f32>;
@group(0) @binding(6) var effect:texture_2d<f32>;
struct OutputParams{ mode:u32, mip:u32, srgb:u32, pad:u32 };
@group(0) @binding(7) var<uniform> params:OutputParams;
@vertex fn vs(@builtin(vertex_index) id:u32)->@builtin(position) vec4<f32>{let xy=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));return vec4<f32>(xy[id],0.,1.);}
fn encode(c:vec3<f32>)->vec3<f32>{let v=max(c,vec3<f32>(0.));return select(v*12.92,1.055*pow(v,vec3<f32>(1./2.4))-.055,v>vec3<f32>(.0031308));}
@fragment fn fs(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
    let p=vec2<i32>(position.xy);var result=textureLoad(color,p,0);
    switch params.mode {
        case 2u:{result=vec4<f32>(vec3<f32>(textureLoad(depth,p,0).r),1.);}
        case 3u:{result=vec4<f32>(textureLoad(normal,p,0).xyz*.5+.5,1.);}
        case 4u:{result=vec4<f32>(textureLoad(albedo,p,0).rgb,1.);}
        case 5u:{result=vec4<f32>(textureLoad(motion,p,0).xy*.05+.5,.5,1.);}
        case 6u:{let mip=min(params.mip,textureNumLevels(hzb)-1u);let dim=textureDimensions(hzb,i32(mip));let q=vec2<i32>(position.xy/vec2<f32>(textureDimensions(color))*vec2<f32>(dim));result=vec4<f32>(vec3<f32>(textureLoad(hzb,q,i32(mip)).r),1.);}
        case 7u:{result=textureLoad(effect,p,0);}
        default:{}
    }
    if params.srgb==0u{result=vec4<f32>(encode(result.rgb),result.a);}return result;
}
