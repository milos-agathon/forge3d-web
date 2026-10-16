
struct Env { inv_vp:mat4x4<f32>, vp:mat4x4<f32>, previous_vp:mat4x4<f32>, p:array<vec4<f32>,19>, bits:vec4<u32> }
@group(0) @binding(0) var<uniform> env:Env;
@group(0) @binding(1) var<storage,read> data:array<f32>;
@group(0) @binding(2) var scene_color:texture_2d<f32>;
@group(0) @binding(3) var scene_depth:texture_depth_2d;
@group(0) @binding(4) var effect:texture_2d<f32>;
@group(0) @binding(5) var history:texture_2d<f32>;
@group(0) @binding(6) var previous_depth:texture_2d<f32>;
@group(0) @binding(7) var linear_sampler:sampler;
@group(0) @binding(8) var reflections:texture_2d_array<f32>;
@group(0) @binding(9) var froxels:texture_3d<f32>;
@group(0) @binding(10) var froxel_output:texture_storage_3d<rgba16float,write>;
fn v4(i:u32)->vec4<f32>{return vec4<f32>(data[i],data[i+1u],data[i+2u],data[i+3u]);}
struct Fullscreen { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32> }
@vertex fn vs_env(@builtin(vertex_index) i:u32)->Fullscreen {
 let uv=vec2<f32>(f32((i<<1u)&2u),f32(i&2u));var o:Fullscreen;
 o.position=vec4<f32>(uv*vec2<f32>(2.,-2.)+vec2<f32>(-1.,1.),0.,1.);o.uv=uv;return o;
}
fn world(uv:vec2<f32>,depth:f32)->vec3<f32>{let v=env.inv_vp*vec4<f32>(uv*vec2<f32>(2.,-2.)+vec2<f32>(-1.,1.),depth,1.);return v.xyz/v.w;}
fn depth_at(uv:vec2<f32>)->f32{let dim=textureDimensions(scene_depth);let px=clamp(vec2<i32>(uv*vec2<f32>(dim)),vec2<i32>(0),vec2<i32>(dim)-1);return textureLoad(scene_depth,px,0);}
fn sky_color(dir:vec3<f32>)->vec3<f32>{var s:SkyParams;s.sun_direction_turbidity=vec4<f32>(env.p[1].xyz,env.p[3].x);s.ground_albedo_sun_size_sun_intensity_exposure=vec4<f32>(env.p[3].y,env.p[3].z,select(env.p[1].w,env.p[18].z,env.p[9].w>0.5),env.p[3].w);s.model_pad=vec4<u32>(u32(env.p[9].z),0u,0u,0u);return eval_sky(dir,s);}
// Native T17 aerial composition (terrain_pbr_pom.wgsl), shared by all covered geometry.
fn aerial_perspective(color:vec3<f32>,dir:vec3<f32>,distance:f32)->vec3<f32>{
 let low_sun=1.-smoothstep(0.18,0.72,env.p[1].y);
 let haze=clamp((env.p[3].x-1.)/9.,0.,1.);
 let energy=clamp(env.p[18].z*(0.5+env.p[3].z*0.35),0.,8.);
 let factor=1.-exp(-env.p[18].y*distance*(0.08+haze*0.04));
 let amount=clamp(factor*(0.8+haze*0.25+energy*0.05),0.,1.);
 let luma=dot(color,vec3<f32>(0.2126,0.7152,0.0722));
 let desaturated=mix(color,vec3<f32>(luma),amount*(0.4+haze*0.15));
 let warm=mix(vec3<f32>(1.),vec3<f32>(1.16,0.98,0.82),low_sun*(0.55+haze*0.25));
 let atmosphere_target=sky_color(dir)*(1.+energy*0.04)*mix(vec3<f32>(1.),warm,low_sun)
   +vec3<f32>(0.14,0.07,0.025)*low_sun*energy*0.18*env.p[3].w;
 return mix(desaturated,atmosphere_target,amount*(0.34+low_sun*0.18+haze*0.12));
}
fn fog_light(dir:vec3<f32>,p:vec3<f32>)->vec3<f32>{
 let ambient=select(env.p[5].xyz,sky_color(dir),env.p[9].w>0.5);
 let strength=select(1.,env.p[16].z,env.p[5].w>0.5);
 return ambient+env.p[2].xyz*env.p[1].w*hg_phase(dot(dir,env.p[1].xyz),env.p[4].w)*sun_visibility(p)*strength;
}
// Native TV6 integer lattice hashing retains all 32 seed bits on every backend.
fn hash3(p:vec3<f32>,seed:u32)->f32 {
 let cell=vec3<i32>(p);var v=seed ^ (bitcast<u32>(cell.x)*0x9e3779b9u) ^ (bitcast<u32>(cell.y)*0x85ebca6bu) ^ (bitcast<u32>(cell.z)*0xc2b2ae35u);
 v^=v>>16u;v*=0x7feb352du;v^=v>>15u;v*=0x846ca68bu;v^=v>>16u;return f32(v)/4294967295.;
}
fn noise_seed(p:vec3<f32>,seed:u32)->f32 {
 let i=floor(p);let f=fract(p);let u=f*f*(3.-2.*f);
 return mix(mix(mix(hash3(i,seed),hash3(i+vec3<f32>(1,0,0),seed),u.x),mix(hash3(i+vec3<f32>(0,1,0),seed),hash3(i+vec3<f32>(1,1,0),seed),u.x),u.y),mix(mix(hash3(i+vec3<f32>(0,0,1),seed),hash3(i+vec3<f32>(1,0,1),seed),u.x),mix(hash3(i+vec3<f32>(0,1,1),seed),hash3(i+vec3<f32>(1,1,1),seed),u.x),u.y),u.z);
}
fn noise(p:vec3<f32>)->f32{return noise_seed(p,env.bits.x);}
@group(2) @binding(0) var cloud_ibl_specular:texture_cube<f32>;
@group(2) @binding(1) var cloud_ibl_irradiance:texture_cube<f32>;
@group(2) @binding(2) var cloud_ibl_sampler:sampler;
// Native cloud scattering, factored to keep its radiometric contract testable.
fn cloud_phase(c:f32,g:f32)->f32 {let g2=g*g;let denom=pow(1.+g2-2.*g*c,1.5);return (1.-g2)/max(denom,1e-3)/(4.*PI);}
fn cloud_scattering(density:f32,dir:vec3<f32>,irradiance:vec3<f32>,reflection:vec3<f32>,shadow:f32)->vec3<f32>{
 let sunlight=env.p[17].w*env.p[1].w*cloud_phase(dot(dir,env.p[1].xyz),env.p[8].z)*density*shadow;
 return (env.p[17].xyz*(sunlight+env.p[8].w)+irradiance*0.35+reflection*0.15)*exp(-env.p[8].y*density);
}
fn cloud_density(p:vec3<f32>)->f32 {
 if(env.p[12].w<0.5||env.bits.z!=0u||env.p[6].y<=0.0){return 0.;}
 let y=(p.y-env.p[6].w)/env.p[7].x;if(y<0.||y>1.){return 0.;}
 let n=(p-vec3<f32>(env.p[7].y*env.p[0].w*env.p[7].w,0.,env.p[7].z*env.p[0].w*env.p[7].w))/env.p[6].z;
 let f=noise(n)*0.65+noise(n*2.13)*0.25+noise(n*4.31)*0.1;
 return max(0.,f-(1.-env.p[6].y))*env.p[6].x*smoothstep(0.,0.15,y)*(1.-smoothstep(0.7,1.,y));
}
// bf8db932 clouds.wgsl and renderer/data.rs: native fullscreen quad rendering.
// R8 texels and repeat/linear filtering are evaluated analytically, with the
// same quantization and resolution as native. No extra GPU allocations.
fn native_noise_texel(cell:vec3<f32>,resolution:f32)->f32 {
 let p=((cell%resolution)+resolution)%resolution;
 let f=sin(p.x*0.125+p.y*0.175+p.z*0.215);
 let g=cos(p.x*0.05+p.y*0.09+p.z*0.07);
 return floor(clamp((f+g)*0.25+0.5,0.,1.)*255.)/255.;
}
fn native_noise(p:vec3<f32>)->f32 {
 let resolution=min(env.p[11].y*2.,128.);let q=fract(p)*resolution-0.5;
 let cell=floor(q);let f=fract(q);var value=0.;
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let weight=select(1.-f.x,f.x,x==1)*select(1.-f.y,f.y,y==1)*select(1.-f.z,f.z,z==1);
  value+=native_noise_texel(cell+vec3<f32>(f32(x),f32(y),f32(z)),resolution)*weight;
 }}}return value;
}
fn native_fbm(pos:vec3<f32>,octaves:i32)->f32 {
 var value=0.;var amplitude=0.5;var frequency=1.;var position=pos;
 for(var j=0;j<octaves;j++){value+=amplitude*native_noise(position*frequency);frequency*=2.;amplitude*=0.5;position=position*1.73+vec3<f32>(23.17,7.33,11.91);}
 return clamp(value*1.1,0.,1.);
}
fn native_shape_texel(cell:vec2<f32>)->f32 {
 let p=clamp(cell,vec2<f32>(0.),vec2<f32>(255.));let dist=length((p-128.)/128.);
 let softness=1.-pow(dist,1.5);let noise=sin(p.x*0.1)*0.1+cos(p.y*0.12)*0.1;
 return floor(clamp(softness+noise,0.,1.)*255.)/255.;
}
fn native_shape(uv:vec2<f32>)->f32 {
 let q=uv*256.-0.5;let cell=floor(q);let f=fract(q);
 return mix(mix(native_shape_texel(cell),native_shape_texel(cell+vec2<f32>(1.,0.)),f.x),mix(native_shape_texel(cell+vec2<f32>(0.,1.)),native_shape_texel(cell+1.),f.x),f.y);
}
fn native_cloud(uv:vec2<f32>)->vec4<f32> {
 // Native quad's UV increases from bottom to top.
 let tex_uv=uv*vec2<f32>(2.,-2.)+vec2<f32>(-1.,1.);
 let time=env.p[0].w*env.p[7].w;let wind=env.p[7].yz*time;
 let sample_pos=vec3<f32>(tex_uv*env.p[6].z*0.01+wind,time*0.05);
 let octaves=clamp(i32(env.p[11].y/16.),2,6);
 let base=native_fbm(sample_pos,octaves);let detail=native_fbm(sample_pos*2.7+vec3<f32>(17.3,9.1,3.7),octaves+1);
 let combined=clamp(base*0.65+detail*0.35,0.,1.);
 let shape_alpha=clamp(native_shape(tex_uv*0.5+0.5)*1.15,0.,1.);
 var density=clamp(smoothstep(1.-env.p[6].y,1.,combined)*env.p[6].x*mix(0.85,1.,shape_alpha),0.,1.);
 if(density<0.01){return vec4<f32>(0.);}
 if(env.p[9].y<0.5){density*=0.85;}else if(env.p[9].y>1.5){density=mix(density*0.75,density,clamp(1.-length(tex_uv),0.,1.));}else{density=clamp(density*env.p[11].y/32.,0.,1.);}
 let view_dir=normalize(vec3<f32>(tex_uv,1.5));let normal=normalize(vec3<f32>(0.15*tex_uv.x,1.,0.15*tex_uv.y));
 let sunlight=env.p[17].w*env.p[1].w*cloud_phase(dot(view_dir,env.p[1].xyz),env.p[8].z)*density;
 // Native default one-texel IBL cube: +Y irradiance and +Z reflection.
 let irradiance=vec3<f32>(179.,204.,242.)/255.;let reflection=vec3<f32>(189.,194.,204.)/255.;
 let color=(env.p[17].xyz*(sunlight+env.p[8].w)+irradiance*0.35+reflection*0.15)*exp(-env.p[8].y*density);
 return vec4<f32>(color*density,density);
}

fn hg_phase(c:f32,g:f32)->f32{return (1.-g*g)/(4.*PI*pow(max(1e-6,1.+g*g-2.*g*c),1.5));}
fn box_range(o:vec3<f32>,d:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>)->vec2<f32>{
 var near=0.;var far=env.p[11].x;
 for(var axis=0u;axis<3u;axis++){if(abs(d[axis])<1e-7){if(o[axis]<lo[axis]||o[axis]>hi[axis]){return vec2<f32>(0.);}}else{let a=(lo[axis]-o[axis])/d[axis];let b=(hi[axis]-o[axis])/d[axis];near=max(near,min(a,b));far=min(far,max(a,b));}}
 return vec2<f32>(near,far);
}
fn volume_sample(p:vec3<f32>,base:u32)->f32 {
 let lo=v4(base);let hi=v4(base+4u);if(any(p<lo.xyz)||any(p>hi.xyz)){return 0.;}
 let dim=vec3<u32>(v4(base+12u).xyz);let q=(p-lo.xyz)/(hi.xyz-lo.xyz)*vec3<f32>(dim-1u);let cell=vec3<u32>(floor(q));let frac=fract(q);
 var result=0.;for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
 let point=min(cell+vec3<u32>(x,y,z),dim-1u);let index=u32(data[base+11u])+point.x+dim.x*(point.y+dim.y*point.z);
 let weight=select(1.-frac.x,frac.x,x==1u)*select(1.-frac.y,frac.y,y==1u)*select(1.-frac.z,frac.z,z==1u);result+=data[index]*weight;
 }}}return result*lo.w;
}
fn froxel_sample(uv:vec2<f32>,distance:f32)->vec4<f32>{
 let dims=vec3<i32>(textureDimensions(froxels));let q=vec3<f32>(uv,distance/env.p[11].x)*vec3<f32>(dims)-0.5;let cell=vec3<i32>(floor(q));let frac=fract(q);
 var result=vec4<f32>(0.);for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
 let point=clamp(cell+vec3<i32>(x,y,z),vec3<i32>(0),dims-1);let weight=select(1.-frac.x,frac.x,x==1)*select(1.-frac.y,frac.y,y==1)*select(1.-frac.z,frac.z,z==1);result+=textureLoad(froxels,point,0)*weight;
 }}}return result;
}
// Screen depth occlusion is used when no shadow map is present. Offscreen points
// retain illumination; foreground occluders suppress the scattered sun energy.
struct EnvShadows {matrices:array<mat4x4<f32>,4>,splits:vec4<f32>,light_direction:vec4<f32>,params0:vec4<f32>,params1:vec4<f32>,params2:vec4<f32>,params3:vec4<f32>,control:vec4<u32>}
@group(1) @binding(0) var environment_shadow_maps:texture_depth_2d_array;
@group(1) @binding(1) var<uniform> environment_shadows:EnvShadows;
fn sun_visibility(p:vec3<f32>)->f32 {
 if(env.p[5].w<0.5||env.bits.y==0u){return 1.;}
 if(environment_shadows.control.x!=0u){
   let count=max(environment_shadows.control.z,1u);var cascade=count-1u;let view_depth=dot(p-env.p[0].xyz,env.p[15].xyz);
   for(var j=0u;j<count;j++){if(view_depth<=environment_shadows.splits[j]){cascade=j;break;}}
   let clip=environment_shadows.matrices[cascade]*vec4<f32>(p,1.);let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2<f32>(0.5,-0.5)+0.5;
   if(all(uv>=vec2<f32>(0.))&&all(uv<=vec2<f32>(1.))&&ndc.z>=0.&&ndc.z<=1.){let dims=textureDimensions(environment_shadow_maps);let texel=clamp(vec2<i32>(uv*vec2<f32>(dims)),vec2<i32>(0),vec2<i32>(dims)-1);let depth=textureLoad(environment_shadow_maps,texel,i32(cascade),0);return select(0.,1.,ndc.z-environment_shadows.params0.z<=depth);}
   return 1.;
 }
 for(var i=1u;i<=u32(env.p[16].w);i++){let sample=p+env.p[1].xyz*(f32(i)*env.p[11].x/(16.*env.p[16].w));let clip=env.vp*vec4<f32>(sample,1.);if(clip.w<=0.){continue;}let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2<f32>(0.5,-0.5)+0.5;if(any(uv<vec2<f32>(0.))||any(uv>vec2<f32>(1.))){continue;}if(ndc.z>depth_at(uv)+0.001){return 0.;}}
 return 1.;
}

fn fog_density(p:vec3<f32>)->f32 {
 if(env.p[14].y<0.5){return env.p[4].x;}
 var h=p.y-env.p[4].y;if(env.p[14].y<1.5){h=max(h,0.);}
 return env.p[4].x*exp(clamp(-h*env.p[4].z,-20.,20.));
}
fn hue_shift(color: vec3<f32>, shift: f32) -> vec3<f32> {
    // Simple hue shift using color rotation
    let cos_shift = cos(shift);
    let sin_shift = sin(shift);

    // Convert to approximate HSV-like rotation
    let shifted = mat3x3<f32>(
        cos_shift + (1.0 - cos_shift) * 0.213, (1.0 - cos_shift) * 0.715 - sin_shift * 0.072, (1.0 - cos_shift) * 0.072 + sin_shift * 0.213,
        (1.0 - cos_shift) * 0.213 + sin_shift * 0.143, cos_shift + (1.0 - cos_shift) * 0.715, (1.0 - cos_shift) * 0.072 - sin_shift * 0.928,
        (1.0 - cos_shift) * 0.213 - sin_shift * 0.787, (1.0 - cos_shift) * 0.715 + sin_shift * 0.072, cos_shift + (1.0 - cos_shift) * 0.072
    ) * color;

    return clamp(shifted, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Surface modes use the same geometry in display, atmosphere clipping and HDR guides.
fn surface_wave(uv:vec2<f32>,b:u32)->f32 {
 if(data[b+7u]<2.5){return 0.;}
 let wave=v4(b+16u);let time=env.p[0].w;
 return simple_wave(uv,time,wave.x,wave.y,wave.z)+simple_wave(uv*wave.w,time,wave.x*min(wave.w,1.)*0.15,7.,data[b+37u]);
}
fn surface_normal(uv:vec2<f32>,b:u32)->vec3<f32>{
 let eps=0.01;let h=surface_wave(uv,b);
 return normalize(vec3<f32>(h-surface_wave(uv+vec2<f32>(eps,0.),b),eps,h-surface_wave(uv+vec2<f32>(0.,eps),b)));
}
// The three native water wave terms, evaluated in world XZ units.
fn simple_wave(uv:vec2<f32>,time:f32,amplitude:f32,frequency:f32,speed:f32)->f32 {
 return sin(uv.x*frequency+time*speed)*amplitude+sin(uv.y*frequency*1.3+time*speed*0.8)*amplitude*0.7+sin((uv.x+uv.y)*frequency*0.6+time*speed*1.2)*amplitude*0.5;
}
fn wave_normal(uv:vec2<f32>,time:f32,amplitude:f32,frequency:f32,speed:f32)->vec3<f32>{
 let eps=0.01;let h=simple_wave(uv,time,amplitude,frequency,speed);let x=simple_wave(uv+vec2<f32>(eps,0.),time,amplitude,frequency,speed);let z=simple_wave(uv+vec2<f32>(0.,eps),time,amplitude,frequency,speed);return normalize(vec3<f32>(h-x,eps,h-z));
}
fn water_hit(origin:vec3<f32>,dir:vec3<f32>,limit:f32,w:u32)->vec2<f32>{
 if(data[128u+w*48u+42u]>0.5){return vec2<f32>(0.);}
 if(abs(dir.y)<1e-6){return vec2<f32>(-1.,0.);}
 let b=128u+w*48u;let bounds=v4(b);let prop=v4(b+4u);let wave=v4(b+16u);let flow=v4(b+24u).zw;
 if(prop.y<=0.||prop.w<0.5){return vec2<f32>(-1.,0.);}
 var t=(prop.x-origin.y)/dir.y;
 for(var iteration=0;iteration<5;iteration++){let p=origin+dir*t;let uv=p.xz+flow*env.p[0].w;let h=prop.x+surface_wave(uv,b);let normal=surface_normal(uv,b);let derivative=dot(normal,dir)/normal.y;if(abs(derivative)>1e-5){t-=(p.y-h)/derivative;}}
 let p=origin+dir*t;if(t<=0.||t>=limit||p.x<bounds.x||p.z<bounds.y||p.x>bounds.z||p.z>bounds.w){return vec2<f32>(-1.,0.);}
 let uv=(p.xz-bounds.xy)/(bounds.zw-bounds.xy);let dim=vec2<u32>(u32(data[b+28u]),u32(data[b+29u]));let cell=min(vec2<u32>(uv*vec2<f32>(dim)),dim-1u);return vec2<f32>(t,data[u32(data[b+30u])+cell.x+dim.x*cell.y]);
}
@fragment fn fs_effect(i:Fullscreen)->@location(0) vec4<f32>{
 let z=depth_at(i.uv);let origin=world(i.uv,0.);let far=world(i.uv,min(z,0.999999));let dir=normalize(far-origin);var distance=min(length(far-origin),env.p[11].x);
 for(var w=0u;w<u32(env.p[11].w);w++){let h=water_hit(origin,dir,distance,w);if(h.x>0.&&h.y>0.){distance=h.x;}}
 var radiance=vec3<f32>(0.);var transmittance=1.;let steps=u32(env.p[11].y);
 // Height fog, integrated with depth-correct world distances.
 if(env.p[12].z>0.5){let dt=distance/f32(steps);for(var j=0u;j<steps;j++){let p=origin+dir*((f32(j)+0.5)*dt);var density=fog_density(p);var lit=fog_light(dir,p);
 if(env.p[14].x>0.5){let cached=froxel_sample(i.uv,(f32(j)+0.5)*dt);lit=cached.rgb;density=cached.a;}
 let absorb=1.-exp(-density*dt*(env.p[14].z+env.p[14].w));
 radiance+=transmittance*absorb*lit*env.p[14].z/max(1e-6,env.p[14].z+env.p[14].w);transmittance*=1.-absorb;}}
 // Each declared box is clipped before marching, so a thin box cannot be skipped
 // by a step spanning the whole camera frustum.
 for(var v=0u;v<u32(env.p[11].z);v++){let base=v*16u;let interval=box_range(origin,dir,v4(base).xyz,v4(base+4u).xyz);let end=min(interval.y,distance);if(end<=interval.x){continue;}let dt=(end-interval.x)/f32(steps);for(var j=0u;j<steps;j++){let p=origin+dir*(interval.x+(f32(j)+0.5)*dt);let absorb=1.-exp(-volume_sample(p,base)*dt);let light=v4(base+8u).xyz+env.p[2].xyz*env.p[1].w*hg_phase(dot(dir,env.p[1].xyz),data[base+7u])*sun_visibility(p);radiance+=transmittance*absorb*light;transmittance*=1.-absorb;}}
 if(env.p[12].w>0.5&&env.bits.z==0u&&abs(dir.y)>1e-6){let a=(env.p[6].w-origin.y)/dir.y;let b=(env.p[6].w+env.p[7].x-origin.y)/dir.y;let begin=max(0.,min(a,b));let end=min(distance,max(a,b));if(end>begin){var count=steps;if(env.p[9].y<0.5||(env.p[9].y>1.5&&begin>env.p[9].x*0.5)){count=1u;}let dt=(end-begin)/f32(count);for(var j=0u;j<count;j++){let p=origin+dir*(begin+(f32(j)+0.5)*dt);let density=cloud_density(p)*(1.-smoothstep(env.p[9].x*0.75,env.p[9].x,length(p-env.p[0].xyz)));let absorb=1.-exp(-density*dt*env.p[8].y*0.08);var shadow=1.;for(var k=1u;k<=4u;k++){shadow*=exp(-cloud_density(p+env.p[1].xyz*f32(k)*env.p[7].x/4.)*env.p[7].x*env.p[8].y*0.02);}let irradiance=textureSampleLevel(cloud_ibl_irradiance,cloud_ibl_sampler,vec3<f32>(0.,1.,0.),0.).rgb;let reflection=textureSampleLevel(cloud_ibl_specular,cloud_ibl_sampler,reflect(-dir,vec3<f32>(0.,1.,0.)),0.).rgb;let lit=cloud_scattering(density,dir,irradiance,reflection,shadow);radiance+=transmittance*absorb*lit;transmittance*=1.-absorb;}}}
 // Reproject stable history. Reject depth discontinuities and offscreen samples.
 if(env.p[12].y>0.5&&env.p[2].w>0.){let clip=env.previous_vp*vec4<f32>(far,1.);let uv=clip.xy/clip.w*vec2<f32>(0.5,-0.5)+0.5;if(clip.w>0.&&all(uv>=vec2<f32>(0.))&&all(uv<=vec2<f32>(1.))){let dz=textureSampleLevel(previous_depth,linear_sampler,uv,0.).r;if(abs(dz-clip.z/clip.w)<0.001){let prev=textureSampleLevel(history,linear_sampler,uv,0.);radiance=mix(radiance,prev.rgb,env.p[2].w);transmittance=mix(transmittance,prev.a,env.p[2].w);}}}
 return vec4<f32>(clamp(radiance,vec3<f32>(0.),vec3<f32>(65504.)),clamp(transmittance,0.,1.));
}
@fragment fn fs_depth(i:Fullscreen)->@location(0) f32{return depth_at(i.uv);}
// Depth bilateral upscale prevents atmosphere bleeding across silhouettes.
fn upscaled(uv:vec2<f32>)->vec4<f32>{let dims=vec2<i32>(textureDimensions(effect));let center=uv*vec2<f32>(dims)-0.5;let base=vec2<i32>(floor(center));let fraction=fract(center);let z=depth_at(uv);var result=vec4<f32>(0.);var total=0.;for(var y=0;y<2;y++){for(var x=0;x<2;x++){let pos=clamp(base+vec2<i32>(x,y),vec2<i32>(0),dims-1);let suv=(vec2<f32>(pos)+0.5)/vec2<f32>(dims);let dz=abs(depth_at(suv)-z);let weight=select(1.-fraction.x,fraction.x,x==1)*select(1.-fraction.y,fraction.y,y==1)*exp(-dz*10000.);result+=textureLoad(effect,pos,0)*weight;total+=weight;}}if(total<1e-5){return textureLoad(effect,clamp(vec2<i32>(uv*vec2<f32>(dims)),vec2<i32>(0),dims-1),0);}return result/total;}
@fragment fn fs_composite(i:Fullscreen)->@location(0) vec4<f32>{
 let z=depth_at(i.uv);let origin=world(i.uv,0.);let hit=world(i.uv,min(z,0.999999));let dir=normalize(hit-origin);var base=textureSampleLevel(scene_color,linear_sampler,i.uv,0.);if(z>=0.999999&&env.p[9].w>0.5){base=vec4<f32>(sky_color(dir),1.);}
 // Project cloud density along the sun to darken terrain and general geometry.
 if(z<0.999999&&env.p[12].w>0.5&&env.p[1].y>0.001){let t=(env.p[6].w+env.p[7].x*0.5-hit.y)/env.p[1].y;if(t>0.){let d=cloud_density(hit+env.p[1].xyz*t);base=vec4<f32>(base.rgb*(1.-env.p[8].x*(1.-exp(-d*env.p[7].x*0.02))),base.a);}}
 var water_mask=0.;var foam_value=0.;var reflected=vec3<f32>(0.);var closest=length(hit-origin);
 for(var w=0u;w<u32(env.p[11].w);w++){let b=128u+w*48u;let prop=v4(b+4u);if(data[b+42u]>0.5){continue;}let h=water_hit(origin,dir,closest,w);if(h.x<=0.||h.y<=0.){continue;}let t=h.x;let mask=h.y;let p=origin+dir*t;water_mask=mask;closest=t;
 let wave=v4(b+16u);var light=v4(b+20u);if(prop.w<1.5){light.x=0.;}let misc=v4(b+24u);let normal=surface_normal(p.xz+misc.zw*env.p[0].w,b);let r=reflect(dir,normal);reflected=sky_color(r);
 if(light.z>0.5&&light.z<1.5){let clip=env.vp*vec4<f32>(p+r*max(1.,length(hit-p)),1.);let ruv=clip.xy/clip.w*vec2<f32>(0.5,-0.5)+0.5;if(clip.w>0.&&all(ruv>vec2<f32>(0.))&&all(ruv<vec2<f32>(1.))&&depth_at(ruv)<0.999999){reflected=textureSampleLevel(scene_color,linear_sampler,ruv,0.).rgb;}}
 if(light.z>1.5){let ruv=clamp(i.uv+normal.xz*wave.x*data[b+40u],vec2<f32>(0.001),vec2<f32>(0.999));let tex=textureSampleLevel(reflections,linear_sampler,ruv,i32(w),0.);reflected=mix(reflected,tex.rgb,tex.a);}
 let depth=max(0.,p.y-hit.y);let controls=v4(b+36u);let tint=v4(b+32u);var body=mix(hue_shift(mix(v4(b+8u).xyz,v4(b+12u).xyz,1.-exp(-depth/prop.z)),controls.x),tint.rgb,tint.a);
 let refracted_uv=clamp(i.uv+normal.xz*controls.z*0.03,vec2<f32>(0.001),vec2<f32>(0.999));if(depth_at(refracted_uv)>=z){body=mix(body,textureSampleLevel(scene_color,linear_sampler,refracted_uv,0.).rgb,controls.z*exp(-depth/prop.z));}let fresnel=0.02+0.98*pow(1.-clamp(dot(-dir,normal),0.,1.),light.w);let spec=pow(max(0.,dot(r,env.p[1].xyz)),mix(256.,8.,light.y))*env.p[1].w;var color=mix(body,reflected,fresnel*light.x)+env.p[2].xyz*spec;
 foam_value=(1.-smoothstep(0.,max(misc.x,0.001),depth))*misc.y*(0.6+0.4*noise_seed(vec3<f32>(p.xz*0.3*(data[b+41u]/20.)+misc.zw*env.p[0].w,0.),0u));color=mix(color,vec3<f32>(1.),foam_value);base=vec4<f32>(mix(base.rgb,color,prop.y*mask*select(1.,smoothstep(0.,max(controls.w,0.001),depth),controls.w>0.)),1.);
 }
 let fx=upscaled(i.uv);var result=base.rgb*fx.a+fx.rgb;
 if(z<0.999999&&env.p[18].x>0.5&&env.p[9].w>0.5&&env.p[18].w<0.5){result=aerial_perspective(result,dir,closest);}
 if(env.p[12].w>0.5&&env.bits.z!=0u){let cloud=native_cloud(i.uv);result=result*(1.-cloud.a)+cloud.rgb*cloud.a;}
 switch(u32(env.p[12].x)){case 1u:{result=vec3<f32>(fx.a);}case 2u:{result=vec3<f32>(1.-fx.a);}case 3u:{result=vec3<f32>(water_mask);}case 4u:{result=vec3<f32>(foam_value);}case 5u:{result=reflected;}default:{}}
 return vec4<f32>(result,base.a);
}

@compute @workgroup_size(4,4,4) fn cs_froxel(@builtin(global_invocation_id) id:vec3<u32>){
 let dims=textureDimensions(froxel_output);if(any(id>=dims)){return;}
 let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(dims.xy);let origin=world(uv,0.);let dir=normalize(world(uv,0.999999)-origin);
 let distance=(f32(id.z)+0.5)/f32(dims.z)*env.p[11].x;let p=origin+dir*distance;
 let density=fog_density(p);
 let light=fog_light(dir,p);
 textureStore(froxel_output,vec3<i32>(id),min(vec4<f32>(light,density),vec4<f32>(65504.)));
}

// Offline guides describe the visible water surface rather than the terrain below it.
struct WaterSurface {position:vec3<f32>,normal:vec3<f32>,albedo:vec3<f32>,layer:u32,valid:bool}
fn water_surface(uv:vec2<f32>)->WaterSurface {
 let origin=world(uv,0.);let hit=world(uv,min(depth_at(uv),0.999999));let dir=normalize(hit-origin);
 var closest=length(hit-origin);var result:WaterSurface;result.valid=false;
 for(var w=0u;w<u32(env.p[11].w);w++){
  let h=water_hit(origin,dir,closest,w);if(h.x<=0.||h.y<=0.){continue;}
  closest=h.x;let b=128u+w*48u;let prop=v4(b+4u);let wave=v4(b+16u);let flow=v4(b+24u).zw;
  result.position=origin+dir*h.x;result.normal=surface_normal(result.position.xz+flow*env.p[0].w,b);
  let tint=v4(b+32u);result.albedo=mix(hue_shift(mix(v4(b+8u).xyz,v4(b+12u).xyz,1.-exp(-max(0.,result.position.y-hit.y)/prop.z)),data[b+36u]),tint.rgb,tint.a);result.layer=w;result.valid=true;
 }
 return result;
}
struct WaterPrimary {@location(0) depth:f32,@location(1) id:u32,@location(2) motion:vec2<f32>}
@fragment fn fs_water_primary(i:Fullscreen)->WaterPrimary {
 let water=water_surface(i.uv);if(!water.valid){discard;}
 var out:WaterPrimary;let d=dot(water.position-env.p[0].xyz,env.p[15].xyz);
 out.depth=clamp((d-env.p[16].x)/(env.p[16].y-env.p[16].x),0.,1.);out.id=0xfffffff0u+water.layer;
 let current=env.vp*vec4<f32>(water.position,1.);let previous=env.previous_vp*vec4<f32>(water.position,1.);
 out.motion=vec2<f32>(0.);if(abs(current.w)>1e-12&&abs(previous.w)>1e-12){out.motion=(current.xy/current.w-previous.xy/previous.w)*vec2<f32>(0.5*env.p[10].x,-0.5*env.p[10].y);}
 return out;
}
struct WaterGuides {@location(0) albedo:vec4<f32>,@location(1) normal:vec4<f32>}
@fragment fn fs_water_surface(i:Fullscreen)->WaterGuides {
 let water=water_surface(i.uv);if(!water.valid){discard;}var out:WaterGuides;
 out.albedo=vec4<f32>(water.albedo,1.);out.normal=vec4<f32>(water.normal,1.);return out;
}
