// bf8db93 SSAO/GTAO kernels, expressed in world space over linear depth.
// A fixed IGN rotation gives deterministic stationary convergence.
fn ign(pixel:vec2<f32>)->f32{return fract(52.9829189*fract(.06711056*pixel.x+.00583715*pixel.y));}
fn ambient_occlusion(p:vec2<i32>,gtao:bool)->vec4<f32>{
    if textureLoad(id_tex,p,0).r==0u{return vec4<f32>(1.);}
    let origin=world_at(p);let n=safe_normal(textureLoad(normal_tex,p,0).xyz);
    let view_up=safe_normal(vec3<f32>(params.view_projection[0][1],params.view_projection[1][1],params.view_projection[2][1]));
    let up=select(-params.forward.xyz,view_up,abs(dot(n,view_up))<.99);
    let tangent=safe_normal(cross(up,n));let bitangent=cross(n,tangent);
    let count=u32(params.a.w);let radius=params.a.x;let dimensions=vec2<f32>(params.size.xy);
    let z=view_distance(origin);let scale=length(vec3<f32>(params.view_projection[0][1],params.view_projection[1][1],params.view_projection[2][1]))*dimensions.y*.5;
    let uv=uv_at(vec2<f32>(p));let noise=ign(vec2<f32>(p))*6.28318530718;
    if !gtao {
        var occlusion=0.;
        for(var i=0u;i<count;i++){
            let alpha=(f32(i)+.5)/f32(count);let angle=alpha*4.*6.28318530718+noise;
            let direction=tangent*cos(angle)*sqrt(alpha)+bitangent*sin(angle)*sqrt(alpha)+n*sqrt(1.-alpha);
            let sample=origin+direction*radius;let projected=project(sample);
            if !is_inside(projected.xy)||projected.z<=0.{continue;}
            let q=bounded(vec2<i32>(projected.xy*dimensions));
            let sampled=world_at_depth(projected.xy,textureLoad(depth_tex,q,0).r);
            let delta=sampled-origin;let dist=length(delta);
            let range=smoothstep(0.,1.,radius/max(dist,1e-4));
            let bias=params.a.y+.5*z/max(scale,1e-4);
            let falloff=exp(-dist*2.)*smoothstep(bias,max(radius,bias+1e-5),dist);
            let contribution=max(0.,dot(n,safe_normal(delta))-bias)*falloff;
            if view_distance(sampled)-z < -bias{occlusion+=contribution*range;}
        }
        let ao=clamp(1.-clamp(occlusion/f32(count)*params.a.z,0.,1.),.05,1.);
        return vec4<f32>(vec3<f32>(ao),1.);
    }
    let directions=max(count/4u,2u);var visibility=0.;
    for(var d=0u;d<directions;d++){
        let angle=f32(d)/f32(directions)*3.14159265359+noise;
        let direction=vec2<f32>(cos(angle),sin(angle));var horizon=-1.;
        for(var step=1u;step<=4u;step++){
            let screen_radius=radius*scale/max(z,1e-4);
            let sample_uv=uv+direction*screen_radius*f32(step)/4./dimensions;
            if !is_inside(sample_uv){continue;}
            let q=bounded(vec2<i32>(sample_uv*dimensions));
            let delta=world_at_depth(sample_uv,textureLoad(depth_tex,q,0).r)-origin;
            let dist=length(delta);let cosine=dot(delta/max(dist,1e-4),n);
            let attenuation=1.-clamp(dist/radius,0.,1.);
            horizon=max(horizon,cosine*attenuation);
        }
        let angle_h=acos(clamp(horizon,-1.,1.));
        visibility+=sin(angle_h)-angle_h*cos(angle_h)+.5*3.14159265359;
    }
    let ao=clamp(1.-clamp(visibility/(f32(directions)*3.14159265359)*params.a.z,0.,1.),.05,1.);
    return vec4<f32>(vec3<f32>(ao),1.);
}
fn ray_hit(origin:vec3<f32>,direction:vec3<f32>)->vec3<f32>{
    let steps=u32(params.a.w);let maximum=params.a.x;let thickness=params.a.y;
    var old_distance=0.;var old_delta=-1.;
    for(var i=1u;i<=steps;i++){
        let t=maximum*pow(f32(i)/f32(steps),1.5);let point=origin+direction*t;
        let projected=project(point);if !is_inside(projected.xy)||projected.z<=0.{return vec3<f32>(-1.);}
        let q=bounded(vec2<i32>(projected.xy*vec2<f32>(params.size.xy)));
        if textureLoad(id_tex,q,0).r==0u{old_distance=t;continue;}
        let normalized=(view_distance(point)-params.camera.x)/(params.camera.y-params.camera.x);
        let mip=min(i32(max(floor(log2(max(t/maximum*f32(params.size.x)/f32(steps),1.))),0.)),i32(textureNumLevels(hzb_tex))-1);
        let dim=vec2<i32>(textureDimensions(hzb_tex,mip));
        let conservative=textureLoad(hzb_tex,clamp(vec2<i32>(projected.xy*vec2<f32>(dim)),vec2<i32>(0),dim-1),mip).r;
        if normalized<conservative {old_distance=t;old_delta=-1.;continue;}
        let surface_depth=mix(params.camera.x,params.camera.y,textureLoad(depth_tex,q,0).r);
        let delta=view_distance(point)-surface_depth;
        if delta>=0.&&old_delta<0.&&t>thickness*2. {
            // Binary refine the crossing. A full-resolution test bounds false hits.
            var lo=old_distance;var hi=t;var hit=projected.xy;
            for(var refine=0u;refine<5u;refine++){
                let mid=(lo+hi)*.5;let candidate=origin+direction*mid;let uv=project(candidate).xy;
                let r=bounded(vec2<i32>(uv*vec2<f32>(params.size.xy)));
                let z=mix(params.camera.x,params.camera.y,textureLoad(depth_tex,r,0).r);
                if view_distance(candidate)>z {hi=mid;hit=uv;}else{lo=mid;}
            }
            let r=bounded(vec2<i32>(hit*vec2<f32>(params.size.xy)));
            let z=mix(params.camera.x,params.camera.y,textureLoad(depth_tex,r,0).r);
            if abs(view_distance(origin+direction*hi)-z)<=thickness{return vec3<f32>(hit,hi/maximum);}
        }
        old_delta=delta;old_distance=t;
    }
    return vec3<f32>(-1.);
}
fn indirect(p:vec2<i32>,reflection:bool)->vec4<f32>{
    if textureLoad(id_tex,p,0).r==0u{return vec4<f32>(0.);}
    let surface=textureLoad(normal_tex,p,0);let n=safe_normal(surface.xyz);let roughness=clamp(surface.a,0.,1.);let origin=world_at(p)+n*params.a.y*.1;
    var tangent=safe_normal(cross(n,vec3<f32>(0.,1.,0.)));if dot(tangent,tangent)<.1{tangent=vec3<f32>(1.,0.,0.);}
    let bitangent=cross(n,tangent);let count=select(u32(params.b.x),1u,reflection);
    var radiance=vec3<f32>(0.);var confidence=0.;
    for(var i=0u;i<count;i++){
        let u=(f32(i)+.5)/f32(count);let angle=f32(i)*2.39996323;
        var direction=tangent*cos(angle)*sqrt(u)+bitangent*sin(angle)*sqrt(u)+n*sqrt(1.-u);
        if reflection{direction=reflect(safe_normal(origin-params.eye.xyz),n);}
        let fallback=environment(select(n,direction,reflection),roughness,reflection);
        let hit=ray_hit(origin,direction);
        if hit.x<0.{radiance+=fallback;continue;}
        let edge=smoothstep(0.,.05,min(min(hit.x,hit.y),min(1.-hit.x,1.-hit.y)))*(1.-hit.z);
        let light=sample_uv(color_tex,hit.xy).rgb;
        radiance+=mix(fallback,light,edge);confidence+=edge;
    }
    let albedo=textureLoad(albedo_tex,p,0).rgb;
    // Native SSR miss records expose the environment but carry zero composite
    // weight, because the lit G-buffer already contains specular IBL.
    if reflection&&confidence==0.{return vec4<f32>(radiance/f32(count)*params.a.z,0.);}
    if !reflection{radiance*=albedo;}else{radiance*=specular_weight(p,n,safe_normal(params.eye.xyz-origin),roughness);}
    return vec4<f32>(radiance/f32(count)*params.a.z,confidence/f32(count));
}
fn bilateral(p:vec2<i32>,horizontal:bool)->vec4<f32>{
    let radius=i32(params.a.x);let center_z=textureLoad(depth_tex,p,0).r;
    let center_n=textureLoad(normal_tex,p,0).xyz;let id=textureLoad(id_tex,p,0).r;
    if id==0u{return textureLoad(color_tex,p,0);}
    var sum=vec4<f32>(0.);var total=0.;
    for(var i=-radius;i<=radius;i++){
        let q=bounded(p+select(vec2<i32>(0,i),vec2<i32>(i,0),horizontal));
        if textureLoad(id_tex,q,0).r!=id{continue;}
        let dz=abs(textureLoad(depth_tex,q,0).r-center_z);
        let dn=1.-clamp(dot(center_n,textureLoad(normal_tex,q,0).xyz),0.,1.);
        let weight=exp(-f32(i*i)/max(f32(radius*radius),1.)-dz/max(params.a.y,1e-6)-dn*16.);
        sum+=textureLoad(color_tex,q,0)*weight;total+=weight;
    }
    return sum/max(total,1e-6);
}
fn temporal(p:vec2<i32>,taa:bool,accumulation:bool)->vec4<f32>{
    // AA histories live on the unjittered pixel grid. Reconstruct the current
    // sample there before blending; otherwise the resolved image itself jitters.
    let aa=taa||accumulation;
    let sample=vec2<f32>(p)+select(vec2<f32>(0.),vec2<f32>(params.camera.z,-params.camera.w),aa);
    let current=bilerp(color_tex,sample);if params.control.x==0u{return current;}
    let motion=bilerp(motion_tex,sample).xy;
    let old=vec2<f32>(p)-motion+select(vec2<f32>(params.d.z-params.camera.z,params.camera.w-params.d.w),vec2<f32>(0.),aa);
    if any(old<vec2<f32>(0.))||any(old>vec2<f32>(params.size.xy)-1.){return current;}
    let q=bounded(vec2<i32>(round(old+select(vec2<f32>(0.),vec2<f32>(params.d.z,-params.d.w),aa))));
    let current_pixel=bounded(vec2<i32>(round(sample)));let depth=textureLoad(depth_tex,current_pixel,0).r;
    let threshold=select(.01,params.a.w,taa);
    if textureLoad(id_tex,current_pixel,0).r!=textureLoad(old_id_tex,q,0).r||abs(depth-textureLoad(old_depth_tex,q,0).r)>max(threshold,depth*threshold){return current;}
    let history=bilerp(history_tex,old);var previous=history.rgb;
    var weight=params.a.x;
    if accumulation {
        let count=min(params.size.w,u32(params.a.x)-1u);weight=f32(count)/f32(count+1u);
        if length(motion)>.01 {weight=0.;}
    } else {
        var low=vec3<f32>(1e10);var high=vec3<f32>(-1e10);var sum=vec3<f32>(0.);var squares=vec3<f32>(0.);
        for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
            var v=bilerp(color_tex,sample+vec2<f32>(f32(x),f32(y))).rgb;
            if taa{v=rgb_ycocg(v);}
            low=min(low,v);high=max(high,v);sum+=v;squares+=v*v;
        }}
        if taa {
            let mean=sum/9.;let sigma=sqrt(max(squares/9.-mean*mean,vec3<f32>(0.)));
            low=max(low,mean-params.a.y*sigma);high=min(high,mean+params.a.y*sigma);
            previous=ycocg_rgb(clamp(rgb_ycocg(previous),low,high));
            weight*=clamp(1.-length(motion/vec2<f32>(params.size.xy))*params.a.z,0.,1.);
        }else{previous=clamp(previous,low,high);}
    }
    return vec4<f32>(mix(current.rgb,previous,weight),current.a);
}
