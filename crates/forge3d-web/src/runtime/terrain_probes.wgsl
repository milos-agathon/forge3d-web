// W09 vec4 storage ABI: four header vectors, ten vectors per probe, then mip-major cubemaps.
@group(1) @binding(3) var<storage, read> local_probes: array<vec4<f32>>;
struct LocalProbeLighting { irradiance: vec3<f32>, reflection: vec3<f32>, weight: f32, reflection_weight: f32 }
fn local_probe_sh(index: u32, normal: vec3<f32>) -> vec3<f32> {
    let n = normal.xzy;
    let basis = array<f32,9>(0.282095,0.488603*n.y,0.488603*n.z,0.488603*n.x,1.092548*n.x*n.y,1.092548*n.y*n.z,0.315392*(3.0*n.z*n.z-1.0),1.092548*n.x*n.z,0.546274*(n.x*n.x-n.y*n.y));
    var result = vec3<f32>(0.0);
    for (var k=0u;k<9u;k++) { result += local_probes[5u+index*10u+k].rgb*basis[k]; }
    return max(result,vec3<f32>(0.0));
}
fn local_probe_cube_uv(direction: vec3<f32>) -> vec3<f32> {
    let d = normalize(direction);let a=abs(d);
    var face=0.0;var uv=vec2<f32>(0.0);
    if (a.x>=a.y && a.x>=a.z) {if(d.x>=0.0){face=0.0;uv=vec2<f32>(-d.z,-d.y)/a.x;}else{face=1.0;uv=vec2<f32>(d.z,-d.y)/a.x;}}
    else if(a.y>=a.z){if(d.y>=0.0){face=2.0;uv=vec2<f32>(d.x,d.z)/a.y;}else{face=3.0;uv=vec2<f32>(d.x,-d.z)/a.y;}}
    else{if(d.z>=0.0){face=4.0;uv=vec2<f32>(d.x,-d.y)/a.z;}else{face=5.0;uv=vec2<f32>(-d.x,-d.y)/a.z;}}
    return vec3<f32>(uv*0.5+0.5,face);
}
fn local_probe_mip(index:u32,direction:vec3<f32>,level:u32) -> vec3<f32> {
    let count=u32(local_probes[3].x);let base_size=u32(local_probes[2].z);var offset=4u+count*10u;
    for(var l=0u;l<level;l++){let size=max(1u,base_size>>l);offset+=count*6u*size*size;}
    let size=max(1u,base_size>>level);let coordinate=local_probe_cube_uv(direction);
    let pixel=clamp(coordinate.xy,vec2<f32>(0.0),vec2<f32>(1.0))*f32(size-1u);
    let p0=vec2<u32>(floor(pixel));let p1=min(p0+vec2<u32>(1u),vec2<u32>(size-1u));let frac=fract(pixel);
    offset+=(index*6u+u32(coordinate.z))*size*size;
    return mix(mix(local_probes[offset+p0.y*size+p0.x].rgb,local_probes[offset+p0.y*size+p1.x].rgb,frac.x),mix(local_probes[offset+p1.y*size+p0.x].rgb,local_probes[offset+p1.y*size+p1.x].rgb,frac.x),frac.y);
}
fn local_probe_reflection(index:u32,position:vec3<f32>,direction:vec3<f32>,roughness:f32) -> vec3<f32> {
    let center=local_probes[4u+index*10u].xyz;
    // Box projection within the local grid cell, with finite reciprocal for axis-aligned rays.
    let half_extent=vec3<f32>(local_probes[0].z,max(local_probes[0].z,local_probes[0].w),local_probes[0].w)*0.5;
    let safe=select(vec3<f32>(1e-6),direction,abs(direction)>vec3<f32>(1e-6));
    let d0=(center-half_extent-position)/safe;let d1=(center+half_extent-position)/safe;
    let exit=max(d0,d1);let distance=min(exit.x,min(exit.y,exit.z));
    var projected=direction;
    if(distance>0.0 && all(abs(position-center)<=half_extent)){projected=position+direction*distance-center;}
    let mip=clamp(roughness,0.0,1.0)*max(local_probes[2].w-1.0,0.0);let l0=u32(floor(mip));let l1=min(l0+1u,u32(local_probes[2].w)-1u);
    return mix(local_probe_mip(index,projected.xzy,l0),local_probe_mip(index,projected.xzy,l1),fract(mip));
}
fn local_probe_lighting(position:vec3<f32>,normal:vec3<f32>,view:vec3<f32>,roughness:f32)->LocalProbeLighting {
    var result=LocalProbeLighting(vec3<f32>(0.0),vec3<f32>(0.0),0.0,0.0);
    let count=u32(local_probes[3].x);if(count==0u){return result;}
    let dims=vec2<u32>(local_probes[1].xy);let extent=vec2<f32>(dims-vec2<u32>(1u));
    let uv=(position.xz-local_probes[0].xy)/local_probes[0].zw;let clamped=clamp(uv,vec2<f32>(0.0),extent);
    let p0=vec2<u32>(floor(clamped));let p1=min(p0+vec2<u32>(1u),dims-vec2<u32>(1u));let frac=fract(clamped);
    var edge=vec2<f32>(1.0);
    if(dims.x>1u){edge.x=clamp(min(uv.x,extent.x-uv.x)*local_probes[0].z/local_probes[2].x,0.0,1.0);}
    if(dims.y>1u){edge.y=clamp(min(uv.y,extent.y-uv.y)*local_probes[0].w/local_probes[2].y,0.0,1.0);}
    let ids=array<u32,4>(p0.y*dims.x+p0.x,p0.y*dims.x+p1.x,p1.y*dims.x+p0.x,p1.y*dims.x+p1.x);
    let weights=array<f32,4>((1.0-frac.x)*(1.0-frac.y),frac.x*(1.0-frac.y),(1.0-frac.x)*frac.y,frac.x*frac.y);
    for(var corner=0u;corner<4u;corner++){let id=ids[corner];if(id<count){result.irradiance+=local_probe_sh(id,normal)*weights[corner];result.reflection+=local_probe_reflection(id,position,reflect(-view,normal),roughness)*weights[corner];}}
    result.weight=min(edge.x,edge.y)*local_probes[1].z;result.reflection_weight=min(edge.x,edge.y)*local_probes[1].w;return result;
}
fn local_probe_debug(value:vec3<f32>,sample:LocalProbeLighting)->vec3<f32>{
    let debug=u32(local_probes[3].y);
    if(debug==1u){return sample.irradiance*sample.weight;}if(debug==2u){return sample.reflection*sample.reflection_weight;}if(debug==3u){return vec3<f32>(sample.weight);}return value;
}
