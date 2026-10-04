const POISSON_SAMPLES_16: array<vec2<f32>, 16> = array<vec2<f32>, 16>(
    vec2<f32>(-0.94201624, -0.39906216), vec2<f32>(0.94558609, -0.76890725),
    vec2<f32>(-0.094184101, -0.92938870), vec2<f32>(0.34495938, 0.29387760),
    vec2<f32>(-0.91588581, 0.45771432), vec2<f32>(-0.81544232, -0.87912464),
    vec2<f32>(-0.38277543, 0.27676845), vec2<f32>(0.97484398, 0.75648379),
    vec2<f32>(0.44323325, -0.97511554), vec2<f32>(0.53742981, -0.47373420),
    vec2<f32>(-0.26496911, -0.41893023), vec2<f32>(0.79197514, 0.19090188),
    vec2<f32>(-0.24188840, 0.99706507), vec2<f32>(-0.81409955, 0.91437590),
    vec2<f32>(0.19984126, 0.78641367), vec2<f32>(0.14383161, -0.14100790)
);
const POISSON_SAMPLES_32: array<vec2<f32>, 32> = array<vec2<f32>, 32>(
    vec2<f32>(-0.975402, -0.0711386), vec2<f32>(-0.920505, -0.41142), vec2<f32>(-0.883908, 0.217872),
    vec2<f32>(-0.884518, 0.568041), vec2<f32>(-0.811945, 0.90521), vec2<f32>(-0.792474, -0.779962),
    vec2<f32>(-0.614856, 0.386578), vec2<f32>(-0.580859, -0.208777), vec2<f32>(-0.53795, 0.716666),
    vec2<f32>(-0.515427, 0.0899991), vec2<f32>(-0.454634, -0.707938), vec2<f32>(-0.420942, 0.991272),
    vec2<f32>(-0.261147, 0.588488), vec2<f32>(-0.211219, 0.114841), vec2<f32>(-0.146336, -0.259194),
    vec2<f32>(-0.139439, -0.888668), vec2<f32>(0.0116886, 0.326395), vec2<f32>(0.0380566, 0.625477),
    vec2<f32>(0.0625935, -0.50853), vec2<f32>(0.125584, 0.0469069), vec2<f32>(0.169469, -0.997253),
    vec2<f32>(0.320597, 0.291055), vec2<f32>(0.359172, -0.173468), vec2<f32>(0.435581, -0.250811),
    vec2<f32>(0.507934, 0.76124), vec2<f32>(0.566009, 0.208748), vec2<f32>(0.639979, 0.481617),
    vec2<f32>(0.652408, -0.634408), vec2<f32>(0.773463, -0.309951), vec2<f32>(0.859312, 0.271189),
    vec2<f32>(0.901218, 0.751167), vec2<f32>(0.937749, -0.832366)
);
const HEX_SAMPLES: array<vec2<f32>, 7> = array<vec2<f32>, 7>(
    vec2<f32>(0.0, 0.0),                    // Center
    vec2<f32>(1.0, 0.0),                    // Right
    vec2<f32>(0.5, 0.866025),               // Top-right
    vec2<f32>(-0.5, 0.866025),              // Top-left
    vec2<f32>(-1.0, 0.0),                   // Left
    vec2<f32>(-0.5, -0.866025),             // Bottom-left
    vec2<f32>(0.5, -0.866025)               // Bottom-right
);
fn brightpass(p:vec2<i32>)->vec4<f32>{
    let input=textureLoad(color_tex,p,0);let brightness=luma(input.rgb);let knee=params.a.x*params.a.y;
    var factor=1.;if brightness<params.a.x-knee{factor=0.;}else if brightness<params.a.x+knee{let t=(brightness-params.a.x+knee)/(2.*knee);factor=t*t;}
    return vec4<f32>(input.rgb*factor,input.a);
}
fn gaussian(p:vec2<i32>,vertical:bool)->vec4<f32>{
    // bf8db93 bloom_blur_h/v: preserve its asymmetric weights and edge normalization.
    let weights=array<f32,9>(.0077847,.0231017,.0539909,.0995906,.1420118,.1599471,.1420118,.0995906,.0539909);
    var sum=vec4<f32>(0.);var total=0.;
    for(var i=0u;i<9u;i++){
        let offset=i32(f32(i32(i)-4)*params.a.x);
        let q=p+select(vec2<i32>(offset,0),vec2<i32>(0,offset),vertical);
        if any(q<vec2<i32>(0))||any(q>=vec2<i32>(params.size.xy)){continue;}
        sum+=textureLoad(color_tex,q,0)*weights[i];total+=weights[i];
    }return sum/max(total,1e-6);
}
fn dof(p:vec2<i32>)->vec4<f32>{
    let input=textureLoad(color_tex,p,0);let uv=uv_at(vec2<f32>(p));
    let depth=mix(params.camera.x,params.camera.y,textureLoad(depth_tex,p,0).r);
    let centered=(uv-.5)*2.;let focus=max(params.a.y+params.a.y*.5*(centered.y*tan(params.c.x)+centered.x*tan(params.c.y)),.1);
    let denominator=depth*(focus+params.a.z);
    if denominator<.001{return input;}
    let coc=clamp(params.a.x*params.a.z*abs(depth-focus)/denominator*params.a.w*params.b.y,0.,params.b.x);
    if coc<.5{return input;}
    var sum=vec3<f32>(0.);var total=0.;let count=u32(params.b.z);
    let high=params.c.z>=2.;let rings=max(count/7u,1u);
    let iterations=select(count,rings*7u,high);
    for(var i=0u;i<iterations;i++){
        var v=POISSON_SAMPLES_32[min(i,31u)];
        if count<=16u{v=POISSON_SAMPLES_16[min(i,15u)];}
        if high{v=HEX_SAMPLES[i%7u]*(f32(i/7u+1u)/f32(rings));}
        let angle=params.b.w;
        let rotated=vec2<f32>(v.x*cos(angle)-v.y*sin(angle),v.x*sin(angle)+v.y*cos(angle));
        let point=vec2<f32>(p)+rotated*coc;
        if !is_inside(uv_at(point)){continue;}
        let z=mix(params.camera.x,params.camera.y,bilerp(depth_tex,point).r);
        let weight=exp(-abs(z-depth)*10.);
        sum+=bilerp(color_tex,point).rgb*weight;total+=weight;
    }
    var blur=vec3<f32>(0.);if total>0.{blur=sum/total;}
    return vec4<f32>(mix(input.rgb,blur,clamp((coc-.5)/2.,0.,1.)),input.a);
}
fn motion_blur(p:vec2<i32>)->vec4<f32>{
    let input=textureLoad(color_tex,p,0);let velocity=textureLoad(motion_tex,p,0).xy*params.a.x;
    let length_v=length(velocity);let direction=velocity*min(1.,params.a.z/max(length_v,1e-6));
    let depth=textureLoad(depth_tex,p,0).r;var sum=vec4<f32>(0.);var total=0.;let count=u32(params.a.y);
    for(var i=0u;i<count;i++){
        let t=(f32(i)+.5)/f32(count)-.5;let sample=vec2<f32>(p)+direction*t;
        let q=bounded(vec2<i32>(round(sample)));let weight=exp(-abs(textureLoad(depth_tex,q,0).r-depth)*500.);
        sum+=bilerp(color_tex,sample)*weight;total+=weight;
    }return sum/max(total,1e-6);
}
fn denoise(p:vec2<i32>)->vec4<f32>{
    let center=textureLoad(color_tex,p,0);let z=textureLoad(depth_tex,p,0).r;let n=textureLoad(normal_tex,p,0).xyz;let albedo=textureLoad(albedo_tex,p,0).rgb;
    let weights=array<f32,5>(1.,4.,6.,4.,1.);let step=i32(params.b.x);
    var sum=vec4<f32>(0.);var total=0.;
    for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
        let q=bounded(p+vec2<i32>(x,y)*step);let color=textureLoad(color_tex,q,0);
        let point=p+vec2<i32>(x,y)*step;
        if any(point<vec2<i32>(0))||any(point>=vec2<i32>(params.size.xy)){continue;}
        if textureLoad(id_tex,q,0).r!=textureLoad(id_tex,p,0).r{continue;}
        let dc=distance(color.rgb,center.rgb);let dz=abs(textureLoad(depth_tex,q,0).r-z);
        let dn=length(textureLoad(normal_tex,q,0).xyz-n);let da=length(textureLoad(albedo_tex,q,0).rgb-albedo);
        let weight=weights[u32(x+2)]*weights[u32(y+2)]*exp(-dc*dc/(params.a.y*params.a.y+1e-5)-dz*dz/(params.a.z*params.a.z+1e-5)-dn/params.a.w-da*4.);
        sum+=color*weight;total+=weight;
    }}return sum/max(total,1e-6);
}
fn uncharted(x:vec3<f32>)->vec3<f32>{return ((x*(x*.15+.10*.50)+.20*.02)/(x*(x*.15+.50)+.20*.30))-.02/.30;}
fn filmic_terrain(x:vec3<f32>)->vec3<f32>{let v=max(x,vec3<f32>(0.));return (((v*(v*.22+.10*.30)+.20*.01)/(v*(v*.22+.30)+.20*.30))-.01/.30);}
fn lut_sample(rgb:vec3<f32>)->vec3<f32>{
    let size=u32(params.b.x);let v=clamp(rgb,vec3<f32>(0.),vec3<f32>(1.))*f32(size-1u);let lo=vec3<u32>(floor(v));let hi=min(lo+1u,vec3<u32>(size-1u));let t=fract(v);
    var sum=vec3<f32>(0.);
    for(var b=0u;b<2u;b++){for(var g=0u;g<2u;g++){for(var r=0u;r<2u;r++){
        let choose=vec3<bool>(r==1u,g==1u,b==1u);let point=select(lo,hi,choose);let w=select(1.-t,t,choose);
        sum+=color_lut[(point.z*size+point.y)*size+point.x].rgb*w.x*w.y*w.z;
    }}}return sum;
}
fn tonemap(p:vec2<i32>)->vec4<f32>{
    let input=textureLoad(color_tex,p,0);var rgb=max(input.rgb*exp2(params.a.x),vec3<f32>(0.));let white=params.a.y;
    switch u32(params.b.y) {
        case 1u:{rgb=rgb/(1.+rgb);}
        case 2u:{rgb=rgb*(1.+rgb/(white*white))/(1.+rgb);}
        case 3u:{rgb=clamp(rgb*(2.51*rgb+.03)/(rgb*(2.43*rgb+.59)+.14),vec3<f32>(0.),vec3<f32>(1.));}
        case 4u:{rgb=uncharted(rgb)/uncharted(vec3<f32>(white));}
        case 5u:{rgb=1.-exp(-rgb);}
        case 6u:{
            if params.control.y==1u&&textureLoad(id_tex,p,0).r==1u{
                // Preserve native screen-mode filmic + 2.2 display encoding.
                rgb=srgb_decode(pow(clamp(filmic_terrain(rgb)/filmic_terrain(vec3<f32>(11.2)),vec3<f32>(0.),vec3<f32>(1.)),vec3<f32>(1./2.2)));
            }
        }
        default:{}
    }
    rgb=clamp(rgb,vec3<f32>(0.),vec3<f32>(1.));
    if params.b.x>=2.{rgb=mix(rgb,lut_sample(rgb),params.a.w);}
    // A nonzero gamma replaces the final sRGB transfer; decode here so the
    // sole output stage still handles the surface's transfer exactly once.
    if params.a.z>0.{rgb=srgb_decode(pow(rgb,vec3<f32>(1./params.a.z)));}
    return vec4<f32>(rgb,input.a);
}
fn display_sample(uv:vec2<f32>)->vec3<f32>{
    let point=uv*vec2<f32>(params.size.xy)-.5;let base=vec2<i32>(floor(point));let t=fract(point);
    let a=srgb_encode(textureLoad(color_tex,bounded(base),0).rgb);
    let b=srgb_encode(textureLoad(color_tex,bounded(base+vec2<i32>(1,0)),0).rgb);
    let c=srgb_encode(textureLoad(color_tex,bounded(base+vec2<i32>(0,1)),0).rgb);
    let d=srgb_encode(textureLoad(color_tex,bounded(base+vec2<i32>(1,1)),0).rgb);
    return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
fn lens(p:vec2<i32>)->vec4<f32>{
    let uv=uv_at(vec2<f32>(p));let centered=uv-.5;let r2=dot(centered,centered);
    let sample=centered*(1.+params.a.x*r2+params.a.x*.5*r2*r2)+.5;
    if !is_inside(sample){return vec4<f32>(0.,0.,0.,1.);}
    let c=sample-.5;let dist=length(c);let ca=params.a.y;
    // Native lens works after tone mapping in display space.
    let red=display_sample(c*(1.+ca*dist)+.5).r;
    let green=display_sample(sample).g;
    let blue=display_sample(c*(1.-ca*dist)+.5).b;
    let vignette=1.-smoothstep(params.a.w,params.a.w+params.b.x,length(centered)*2.)*params.a.z;
    return vec4<f32>(srgb_decode(vec3<f32>(red,green,blue)*vignette),sample_uv(color_tex,sample).a);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
    if any(id.xy>=params.size.xy){return;}let p=vec2<i32>(id.xy);var result=textureLoad(color_tex,p,0);
    switch params.size.z {
        case 1u:{result=ambient_occlusion(p,false);} case 2u:{result=ambient_occlusion(p,true);}
        case 3u:{result=indirect(p,false);} case 4u:{result=indirect(p,true);}
        case 5u:{result=bilateral(p,true);}case 6u:{result=bilateral(p,false);}
        case 7u:{result=temporal(p,false,false);}
        case 8u:{result=vec4<f32>(result.rgb*textureLoad(aux_tex,p,0).rgb,result.a);}
        case 9u:{result=vec4<f32>(result.rgb+textureLoad(aux_tex,p,0).rgb,result.a);}
        case 21u:{let spec=textureLoad(aux_tex,p,0);result=vec4<f32>(result.rgb+spec.rgb*clamp(spec.a,0.,1.),result.a);}
        case 10u:{result=brightpass(p);}case 11u:{result=gaussian(p,false);}case 12u:{result=gaussian(p,true);}
        case 13u:{result=vec4<f32>(result.rgb+textureLoad(aux_tex,p,0).rgb*params.a.z,result.a);}
        case 14u:{result=dof(p);}case 15u:{result=motion_blur(p);}
        case 16u:{result=temporal(p,true,false);}case 17u:{result=temporal(p,false,true);}
        case 18u:{result=denoise(p);}case 19u:{result=tonemap(p);}case 20u:{result=lens(p);}
        default:{}
    }
    textureStore(output_tex,p,vec4<f32>(clamp(result.rgb,vec3<f32>(0.),vec3<f32>(65504.)),clamp(result.a,0.,1.)));
}
