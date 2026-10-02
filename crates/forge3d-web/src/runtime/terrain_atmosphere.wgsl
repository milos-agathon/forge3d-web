// #if terrain_material
// #if tm_environment
struct TerrainEnvironment { inv_vp:mat4x4<f32>, vp:mat4x4<f32>, previous_vp:mat4x4<f32>, p:array<vec4<f32>,19>, bits:vec4<u32>,
// #if masked_reflection
 masked_vp:mat4x4<f32>, masked_controls:vec4<f32>, masked_layer:vec4<f32>,
// #endif
}
@group(2) @binding(6) var<uniform> terrain_environment:TerrainEnvironment;
// #endif
// #if tm_aerial
// Native aerial composition runs after exposure and before tonemapping.
fn tm_aerial(color:vec3<f32>,surface:TmSurface)->vec3<f32>{
 var sky:array<vec4<f32>,4>;
 sky[0]=vec4<f32>(terrain_environment.p[18].xy,0.,0.);
 sky[1]=vec4<f32>(terrain_environment.p[1].xyz,terrain_environment.p[3].x);
 sky[2]=vec4<f32>(terrain_environment.p[3].yz,terrain_environment.p[18].z,terrain_environment.p[3].w);
 sky[3]=vec4<f32>(terrain_environment.p[9].z,0.,0.,0.);
 let pixel_uv=vec2<f32>(surface.uv.x,1.-surface.uv.y);
 let far=terrain_environment.inv_vp*vec4<f32>(pixel_uv*vec2<f32>(2.,-2.)+vec2<f32>(-1.,1.),1.,1.);
 let dir=normalize(far.xyz/far.w-camera.camera_position.xyz);
 let distance=surface.view_distance;
 var params_sky:SkyParams;params_sky.sun_direction_turbidity=sky[1];params_sky.ground_albedo_sun_size_sun_intensity_exposure=sky[2];params_sky.model_pad=vec4<u32>(u32(sky[3].x),0u,0u,0u);
 let sky_rgb=eval_sky(dir,params_sky);
 let low_sun=1.-smoothstep(0.18,0.72,sky[1].y);
 let haze=clamp((sky[1].w-1.)/9.,0.,1.);
 let energy=clamp(sky[2].z*(0.5+sky[2].y*0.35),0.,8.);
 let factor=1.-exp(-sky[0].y*distance*(0.08+haze*0.04));
 let amount=clamp(factor*(0.8+haze*0.25+energy*0.05),0.,1.);
 let luma=dot(color,vec3<f32>(0.2126,0.7152,0.0722));
 let desaturated=mix(color,vec3<f32>(luma),amount*(0.4+haze*0.15));
 let warm=mix(vec3<f32>(1.),vec3<f32>(1.16,0.98,0.82),low_sun*(0.55+haze*0.25));
 let atmosphere_target=sky_rgb*(1.+energy*0.04)*mix(vec3<f32>(1.),warm,low_sun)
   +vec3<f32>(0.14,0.07,0.025)*low_sun*energy*0.18*sky[2].w;
 return mix(desaturated,atmosphere_target,amount*(0.34+low_sun*0.18+haze*0.12));
}
// #endif
// #endif
