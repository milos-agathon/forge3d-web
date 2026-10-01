// #if terrain_material
// Native T16 masked terrain-water material, independent of the explicit planes.
// Ported from 1f4084a:terrain_pbr_pom.wgsl water override and specular branch.
fn tm_native_water(surface:TmSurface,height:f32,mask:f32)->TerrainSample {
 let depth=select(1.-clamp(height/0.2,0.,1.),mask,mask>0.01&&mask<0.99);
 let albedo=mix(vec3<f32>(0.1,0.5,0.85),vec3<f32>(0.05,0.45,0.95),depth);
 let scatter=albedo*(1.-depth*0.3)*1.2;
 let angle=0.7;let wc=cos(angle);let ws=sin(angle);
 let along=surface.world_pos.x*wc+surface.world_pos.y*ws;
 let across=-surface.world_pos.x*ws+surface.world_pos.y*wc;
 let scale=mix(0.3,1.,depth);
 let wave1=sin(along*0.05)*0.07*scale;
 let wave2=sin(along*0.15+across*0.03)*0.035*scale;
 let wave3=sin(along*0.4+1.7)*0.018;
 let cross_wave=sin(across*0.12+0.5)*0.02*scale;
 let dx=(wave1+wave2+wave3)*wc-cross_wave*ws;
 let dy=(wave1+wave2+wave3)*ws+cross_wave*wc;
 let normal=normalize(vec3<f32>(dx,1.,dy));
 let rough=0.02;let f0=vec3<f32>(pow((1.33-1.)/(1.33+1.),2.));
 let ibl=tm_ibl_split(normal,surface.view_dir,albedo,rough,0.,f0);
 let nv=max(dot(normal,surface.view_dir),0.001);
 let nl=max(dot(normal,surface.light_dir),0.);
 let half_vector=normalize(surface.view_dir+surface.light_dir);
 let nh=max(dot(normal,half_vector),0.);
 let vh=max(dot(surface.view_dir,half_vector),0.001);
 let alpha=rough*rough;let a2=max(alpha*alpha,1e-8);
 let denom=nh*nh*(a2-1.)+1.;let distribution=a2/(TM_PI*denom*denom);
 let fresnel=f0+(vec3<f32>(1.)-f0)*pow(1.-vh,5.);
 let k=alpha/2.;let geometry=(nv/(nv*(1.-k)+k))*(nl/(nl*(1.-k)+k));
 let direct=distribution*fresnel*geometry/(4.*nv*nl+0.0001);
 let sun=direct*vec3<f32>(1.,0.98,0.95)*surface.sun_intensity*nl;
 var color=((ibl.diffuse+ibl.specular)*forge3d_ibl.intensity*0.30+sun*0.5)*mix(1.,0.30,depth)
  +vec3<f32>(0.15,0.45,0.85)*0.80+scatter*2.;
 color*=max(forge3d_lighting.exposure,0.);
 if(params.render_mode==1u&&terrain_material.atmosphere[0].x>0.5){color=tm_aerial(color,surface);}
 var out:TerrainSample;out.radiance=color;out.albedo=albedo;out.normal=normal;out.covered=surface.covered;return out;
}
// #endif
