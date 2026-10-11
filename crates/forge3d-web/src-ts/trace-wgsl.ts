/** Shared query kernel. Scene storage uses explicit word offsets, avoiding vec3 ABI drift. */
export const TRACE_QUERY_WGSL = `
struct Params {dims:vec4u,counts:vec4u,mode:vec4u,offsets0:vec4u,offsets1:vec4u,origin:vec4f,forward:vec4f,right:vec4f,up:vec4f,environment:vec4f,extra:vec4f,mediumMin:vec4f,mediumMax:vec4f,mediumA:vec4f,mediumS:vec4f,reuse:vec4u,thresholds:vec4f,sdfMin:vec4f,sdfMax:vec4f};
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> scene:array<u32>;
struct Hit {t:f32,id:u32,material:u32,steps:u32,bary:vec3f,p:vec3f,n:vec3f,front:u32};
fn sf(i:u32)->f32 {return bitcast<f32>(scene[i]);}
fn sv(i:u32)->vec3f {return vec3f(sf(i),sf(i+1u),sf(i+2u));}
fn safe_unit(v:vec3f)->vec3f {return v/max(length(v),1e-30);}
fn slab(lo:vec3f,hi:vec3f,o:vec3f,d:vec3f,tmin:f32,tmax:f32)->vec2f {
  var near=tmin;var far=tmax;
  for(var a=0u;a<3u;a++){if(d[a]==0.){if(o[a]<lo[a]||o[a]>hi[a]){return vec2f(1.,0.);}}else{let x=(lo[a]-o[a])/d[a];let y=(hi[a]-o[a])/d[a];near=max(near,min(x,y));far=min(far,max(x,y));}}
  return vec2f(near,far);
}
fn miss(tmax:f32)->Hit {var h:Hit;h.t=tmax;return h;}
fn triangle(i:u32,o:vec3f,d:vec3f,tmin:f32,tmax:f32)->Hit {
  var h=miss(tmax);let at=params.offsets0.x+i*16u;let a=sv(at);let e1=sv(at+4u)-a;let e2=sv(at+8u)-a;let p=cross(d,e2);let det=dot(e1,p);
  if(abs(det)<1e-8){return h;}let inv=1./det;let s=o-a;let u=dot(s,p)*inv;if(u<0.||u>1.){return h;}let q=cross(s,e1);let v=dot(d,q)*inv;if(v<0.||u+v>1.){return h;}let t=dot(e2,q)*inv;if(t<tmin||t>tmax){return h;}
  h.t=t;h.id=scene[at+12u];h.material=scene[at+13u];h.bary=vec3f(1.-(u+v),u,v);h.p=o+d*t;h.n=safe_unit(cross(e1,e2));h.front=select(0u,1u,dot(h.n,d)<=0.);if(dot(h.n,d)>0.){h.n=-h.n;}return h;
}
fn mesh_hit(o:vec3f,d:vec3f,tmin:f32,tmax:f32)->Hit {
  var h=miss(tmax);if(params.counts.x==0u||params.mode.x==1u){return h;}var stack:array<u32,64>;var top=1u;stack[0]=0u;
  for(var visited=0u;visited<params.counts.x&&top>0u;visited++){top-=1u;let i=stack[top];let at=params.offsets0.y+i*12u;let interval=slab(sv(at),sv(at+4u),o,d,tmin,h.t);if(interval.x>interval.y){continue;}let count=scene[at+11u];
    if(count>0u){let first=scene[at+10u];for(var j=0u;j<count;j++){let th=triangle(scene[params.offsets0.z+first+j],o,d,tmin,h.t);if(th.id!=0u&&(h.id==0u||th.t<h.t||(th.t==h.t&&th.id<h.id))){h=th;}}}
    else if(top+1u<64u) {stack[top]=scene[at+9u];stack[top+1u]=scene[at+8u];top+=2u;}
  }return h;
}
fn primitive(i:u32,p:vec3f)->f32 {
  let at=params.offsets0.w+i*20u;let kind=scene[at];let a=at+4u;let c=sv(a);let q=p-c;let r=sf(a+3u);
  switch kind {
    case 0u:{return length(q)-r;}
    case 1u:{let d=abs(q)-sv(a+4u);return length(max(d,vec3f(0.)))+min(max(max(d.x,d.y),d.z),0.);}
    case 2u:{let d=vec2f(length(q.xz)-r,abs(q.y)-sf(a+4u)*0.5);return length(max(d,vec2f(0.)))+min(max(d.x,d.y),0.);}
    case 3u:{return dot(p,c)+r;}
    case 4u:{return length(vec2f(length(q.xz)-r,q.y))-sf(a+4u);}
    default:{let segment=sv(a+4u)-c;let h=clamp(dot(q,segment)/max(dot(segment,segment),1e-30),0.,1.);return length(p-(c+segment*h))-r;}
  }
}
fn smooth_min(a:f32,b:f32,k:f32)->f32 {if(k<=0.){return min(a,b);}let h=clamp(0.5+0.5*(b-a)/k,0.,1.);return (1.-h)*b+h*a-k*h*(1.-h);}
struct SdfValue {distance:f32,material:u32};
var<private> distances:array<f32,256>;
var<private> materials:array<u32,256>;
fn sdf_eval(p:vec3f)->SdfValue {
  if(params.counts.w==0u){return SdfValue(1e30,0u);}
  for(var i=0u;i<params.counts.w;i++){let at=params.offsets1.x+i*8u;let left=scene[at+1u];
    if(scene[at+5u]!=0u){distances[i]=primitive(left,p);materials[i]=scene[at+4u];}
    else {let right=scene[at+2u];let op=scene[at];let a=distances[left];var b=distances[right];if(op==2u||op==5u){b=-b;}let k=sf(at+3u);var choose_left=a>=b;
      if(op==0u){distances[i]=min(a,b);choose_left=a<=b;}else if(op<3u){distances[i]=max(a,b);}else if(op==3u){distances[i]=smooth_min(a,b,k);var t=0.5;if(a+b!=0.){t=b/(a+b);}choose_left=t<0.5;}else{distances[i]=-smooth_min(-a,-b,k);}
      materials[i]=select(materials[right],materials[left],choose_left);
    }
  }let root=params.counts.w-1u;return SdfValue(distances[root],materials[root]);
}
fn sdf_normal(p:vec3f)->vec3f {let root=params.offsets1.x+(params.counts.w-1u)*8u;if(scene[root+5u]!=0u){let at=params.offsets0.w+scene[root+1u]*20u;let kind=scene[at];if(kind==0u){return safe_unit(p-sv(at+4u));}if(kind==3u){return safe_unit(sv(at+4u));}}let e=0.00004;return safe_unit(vec3f(sdf_eval(p+vec3f(e,0.,0.)).distance-sdf_eval(p-vec3f(e,0.,0.)).distance,sdf_eval(p+vec3f(0.,e,0.)).distance-sdf_eval(p-vec3f(0.,e,0.)).distance,sdf_eval(p+vec3f(0.,0.,e)).distance-sdf_eval(p-vec3f(0.,0.,e)).distance));}
fn scene_hit(o:vec3f,d:vec3f,tmin:f32,tmax:f32)->Hit {
  var h=mesh_hit(o,d,tmin,tmax);if(params.counts.w==0u||params.mode.x==2u){return h;}var t=tmin;var limit=h.t;if(params.sdfMin.w>0.5){let bounds=slab(params.sdfMin.xyz,params.sdfMax.xyz,o,d,tmin,h.t);if(bounds.x>bounds.y){return h;}t=bounds.x;limit=bounds.y;}let speed=length(d);
  for(var step=0u;step<256u&&t<=limit;step++){let p=o+d*t;let v=sdf_eval(p);if(abs(v.distance)<=0.00001){if(h.id!=0u&&t>=h.t){return h;}h.t=t;h.id=0xfffffffeu;h.material=v.material;h.steps=step+1u;h.p=p;h.n=sdf_normal(p);h.front=select(0u,1u,dot(h.n,d)<=0.);h.bary=vec3f(0.);if(dot(h.n,d)>0.){h.n=-h.n;}return h;}t+=max(abs(v.distance)/speed,0.0000025);}
  return h;
}
`;
export const TRACE_PATH_WGSL =
  TRACE_QUERY_WGSL +
  `
struct Path {o:vec4f,d:vec4f,t:vec4f,c:vec4f,a:vec4f,n:vec4f,direct:vec4f,indirect:vec4f,emission:vec4f,bent:vec4f,tags:vec4u,identity:vec4u};
struct Reservoir {sample:u32,count:u32,weight:f32,importance:f32,age:u32,coords:vec3f,position:vec4f,normal:vec4f};
@group(0) @binding(2) var<storage,read_write> paths:array<Path>;
@group(0) @binding(3) var<storage,read_write> next_paths:array<Path>;
@group(0) @binding(4) var<storage,read_write> output:array<u32>;
@group(0) @binding(5) var<storage,read_write> work:array<u32>;
@group(0) @binding(6) var<storage,read_write> reservoirs:array<Reservoir>;
@group(0) @binding(7) var<storage,read> history:array<Reservoir>;
struct QueueItem {hit:Hit,shadowO:vec4f,shadowD:vec4f,shadowC:vec4f,shadowTags:vec4u};
@group(0) @binding(8) var<storage,read_write> pending:array<QueueItem>;
fn rng(state:ptr<function,u32>)->f32 {var x=*state;x=x^(x<<13u);x=x^(x>>17u);x=x^(x<<5u);*state=x;return f32(x>>8u)/16777216.;}
fn local_world(v:vec3f,n:vec3f)->vec3f {var axis=vec3f(0.,0.,1.);if(abs(n.z)>=0.999){axis=vec3f(0.,1.,0.);}let t=safe_unit(cross(axis,n));let b=cross(n,t);return safe_unit(t*v.x+b*v.y+n*v.z);}
fn cosine(u:f32,v:f32,n:vec3f)->vec3f {let r=sqrt(u);let phi=6.28318530718*v;return local_world(vec3f(r*cos(phi),r*sin(phi),sqrt(1.-u)),n);}
fn lum(v:vec3f)->f32 {return dot(v,vec3f(0.2126,0.7152,0.0722));}
fn light_geometry(i:u32,p:vec3f,uv:vec2f)->array<vec4f,2> {
  let at=params.offsets1.z+i*16u;let kind=u32(sf(at+11u));let color=sv(at+4u);let intensity=sf(at+3u);
  if(kind==1u){return array<vec4f,2>(vec4f(-sv(at+8u),1e30),vec4f(color*intensity,0.));}
  var position=sv(at);if(kind==2u){let n=sv(at+12u);var axis=vec3f(0.,0.,1.);if(abs(n.z)>=0.999){axis=vec3f(0.,1.,0.);}let t=safe_unit(cross(axis,n));let b=cross(n,t);let radius=sqrt(uv.x)*sf(at+15u);let phi=6.28318530718*uv.y;position+=radius*(t*cos(phi)+b*sin(phi));}
  let delta=position-p;let distance=length(delta);let direction=safe_unit(delta);var scale=intensity/max(distance*distance,1e-20);if(kind==2u){let radius=sf(at+15u);scale*=max(0.,-dot(sv(at+12u),direction))*3.14159265359*radius*radius;}return array<vec4f,2>(vec4f(direction,distance),vec4f(color*scale,0.));
}
fn smith_aniso(v:vec3f,n:vec3f,ax:f32,ay:f32)->f32 {let c=max(0.,dot(v,n));if(c==0.){return 0.;}var axis=vec3f(0.,0.,1.);if(abs(n.z)>=0.999){axis=vec3f(0.,1.,0.);}let t=safe_unit(cross(axis,n));let b=cross(n,t);let x=ax*dot(v,t);let y=ay*dot(v,b);return 2.*c/(c+sqrt(c*c+x*x+y*y));}
fn trace_brdf(material:u32,n:vec3f,view:vec3f,l:vec3f)->vec3f {let at=params.offsets1.y+material*12u;let albedo=sv(at);let metallic=sf(at+3u);let rough=sf(at+7u);let ax=sf(at+9u);let ay=sf(at+10u);let nv=max(0.,dot(n,view));let nl=max(0.,dot(n,l));if(nv==0.||nl==0.||sf(at+8u)>1.){return vec3f(0.);}let diffuse=albedo*((1.-metallic)/3.14159265359);if(metallic==0.){return diffuse;}let h=safe_unit(view+l);let nh=max(0.,dot(n,h));let vh=max(0.,dot(view,h));let a=max(0.001,rough*rough);var D=0.;var G=0.;if(abs(ax-ay)<0.0001){let d=nh*nh*(a*a-1.)+1.;D=a*a/(3.14159265359*d*d);G=smith(nv,a)*smith(nl,a);}else{var axis=vec3f(0.,0.,1.);if(abs(n.z)>=0.999){axis=vec3f(0.,1.,0.);}let t=safe_unit(cross(axis,n));let b=cross(n,t);let x=dot(h,t)/ax;let y=dot(h,b)/ay;let d=x*x+y*y+nh*nh;D=1./(3.14159265359*ax*ay*d*d);G=smith_aniso(view,n,ax,ay)*smith_aniso(l,n,ax,ay);}let fresnel=albedo+(vec3f(1.)-albedo)*pow(1.-vh,5.);return diffuse+fresnel*(metallic*D*G/(4.*nv*nl));}
fn light_value(i:u32,p:vec3f,n:vec3f,material:u32,view:vec3f,uv:vec2f)->vec3f {let light=light_geometry(i,p,uv);let c=max(0.,dot(n,light[0].xyz));if(c==0.||light[0].w<0.0001){return vec3f(0.);}return trace_brdf(material,n,view,light[0].xyz)*light[1].xyz*c;}
fn choose_light(state:ptr<function,u32>)->vec4f {
  let u=rng(state);let v=rng(state);var sum=0.;for(var i=0u;i<params.mode.z;i++){sum+=sf(params.offsets1.z+i*16u+7u);}var at=u*sum;
  for(var i=0u;i<params.mode.z;i++){let w=sf(params.offsets1.z+i*16u+7u);at-=w;if(at<0.||i+1u==params.mode.z){return vec4f(bitcast<f32>(i),w/sum,clamp((at+w)/w,0.,1.),v);}}return vec4f(0.);
}
fn smith(c:f32,a:f32)->f32 {if(c<=0.){return 0.;}return 2.*c/(c+sqrt(a*a+(1.-a*a)*c*c));}
fn ggx(d:vec3f,n:vec3f,f0:vec3f,rough:f32,u:f32,v:f32,ax:f32,ay:f32)->array<vec3f,2> {
  let a=max(0.001,rough*rough);let a2=a*a;let z=sqrt((1.-u)/(1.+(a2-1.)*u));let r=sqrt(max(0.,1.-z*z));var local=vec3f(r*cos(6.28318530718*v),r*sin(6.28318530718*v),z);let aniso=abs(ax-ay)>=0.0001;if(aniso){local=vec3f(ax*sqrt(u)*cos(6.28318530718*v),ay*sqrt(u)*sin(6.28318530718*v),sqrt(1.-u));}let h=local_world(local,n);let dir=safe_unit(reflect(d,h));
  let ni=max(0.,-dot(d,n));let no=max(0.,dot(dir,n));let nh=max(0.,dot(n,h));let vh=max(0.,-dot(d,h));if(ni==0.||no==0.||nh==0.||vh==0.){return array<vec3f,2>(dir,vec3f(0.));}
  var gi=smith(ni,a);var go=smith(no,a);if(aniso){gi=smith_aniso(-d,n,ax,ay);go=smith_aniso(dir,n,ax,ay);}let fresnel=f0+(vec3f(1.)-f0)*pow(1.-vh,5.);return array<vec3f,2>(dir,fresnel*(gi*go*vh/(ni*nh)));
}
fn initial(pixel:u32)->Path {
  var p:Path;p.tags=vec4u(pixel,params.mode.y^((pixel+1u)*0x9e3779b9u)^((params.dims.z+1u)*0x85ebca6bu),1u,0u);if(p.tags.y==0u){p.tags.y=1u;}
  var state=p.tags.y;let x=(f32(pixel%params.dims.x)+rng(&state))/f32(params.dims.x)*2.-1.;let y=1.-(f32(pixel/params.dims.x)+rng(&state))/f32(params.dims.y)*2.;
  p.tags.y=state;p.o=vec4f(params.origin.xyz,0.);p.d=vec4f(safe_unit(params.forward.xyz+params.right.xyz*(x*params.extra.x*params.extra.y)+params.up.xyz*(y*params.extra.x)),0.);p.t=vec4f(1.,1.,1.,0.);return p;
}
fn shade(input:Path,hit:Hit,queued:bool,slot:u32)->Path {
  var p=input;var state=p.tags.y;let bounce=p.tags.w;var light_index=0u;var light_uv=vec2f(0.);
  if(params.mediumS.w>0.5){let interval=slab(params.mediumMin.xyz,params.mediumMax.xyz,p.o.xyz,p.d.xyz,0.00001,hit.t);if(interval.x<=interval.y){let sigma=params.mediumA.xyz+params.mediumS.xyz;let majorant=max(max(sigma.x,sigma.y),sigma.z);var flight=1e30;if(majorant>0.){flight=-log(max(1e-7,1.-rng(&state)))/majorant;}if(flight<interval.y-interval.x){p.o=vec4f(p.o.xyz+p.d.xyz*(interval.x+flight),0.);p.t=vec4f(p.t.xyz*exp((vec3f(majorant)-sigma)*flight)*params.mediumS.xyz/max(majorant,1e-30),0.);let u=rng(&state);let v=rng(&state);let g=params.mediumA.w;var z=1.-2.*u;if(abs(g)>=0.001){let a=(1.-g*g)/(1.-g+2.*g*u);z=(1.+g*g-a*a)/(2.*g);}z=clamp(z,-1.,1.);let r=sqrt(max(0.,1.-z*z));p.d=vec4f(local_world(vec3f(r*cos(6.28318530718*v),r*sin(6.28318530718*v),z),p.d.xyz),0.);p.tags.y=state;p.tags.w+=1u;if(p.tags.w>=params.dims.w){p.tags.z=0u;}return p;}p.t=vec4f(p.t.xyz*exp((vec3f(majorant)-sigma)*(interval.y-interval.x)),0.);}}
  if(hit.id==0u){let c=p.t.xyz*params.environment.xyz*(0.5+0.5*max(0.,p.d.y));p.c+=vec4f(c,0.);p.indirect+=vec4f(c,0.);p.tags.z=0u;p.tags.y=state;return p;}
  let mat=params.offsets1.y+hit.material*12u;let albedo=sv(mat);let metallic=sf(mat+3u);let emission=p.t.xyz*sv(mat+4u);let roughness=sf(mat+7u);let ior=sf(mat+8u);p.c+=vec4f(emission,0.);p.emission+=vec4f(emission,0.);
  if(bounce==0u){p.a=vec4f(albedo,0.);p.identity.x=hit.id;p.n=vec4f(hit.n,hit.t);p.direct.w=1.;let ad=cosine(rng(&state),rng(&state),hit.n);let occluded=scene_hit(hit.p+hit.n*0.0001,ad,0.00001,1.).id!=0u;p.indirect.w=select(1.,0.,occluded);p.bent=vec4f(select(ad,vec3f(0.),occluded),0.);}
  var lighting=vec3f(0.);
  if(params.mode.z>0u){if(params.mode.w==0u){let choice=choose_light(&state);light_index=bitcast<u32>(choice.x);light_uv=choice.zw;lighting=light_value(light_index,hit.p,hit.n,hit.material,-p.d.xyz,light_uv)/choice.y;}
    else {var r:Reservoir;for(var j=0u;j<params.mode.w;j++){let choice=choose_light(&state);let i=bitcast<u32>(choice.x);let value=light_value(i,hit.p,hit.n,hit.material,-p.d.xyz,choice.zw);let importance=max(lum(value),0.);let weight=importance/choice.y;r.count+=1u;r.weight+=weight;let choice_random=rng(&state);if(weight>0.&&choice_random*r.weight<weight){r.sample=i;r.importance=importance;r.coords=vec3f(choice.zw,0.);}}
      if(bounce==0u&&params.dims.z>0u){for(var neighbor=0u;neighbor<params.reuse.x;neighbor++){var dx=0i;if(neighbor>0u){dx=i32((neighbor+1u)/2u);if(neighbor%2u==0u){dx=-dx;}}let x=i32(p.tags.x%params.dims.x)+dx;if(x<0||x>=i32(params.dims.x)){continue;}let prev=history[u32(i32(p.tags.x)+dx)];if(prev.count==0u||prev.importance<=0.||prev.age>=params.reuse.z||abs(prev.normal.w-hit.t)>params.thresholds.x*max(hit.t,1.)||dot(prev.normal.xyz,hit.n)<params.thresholds.y){continue;}let importance=max(lum(light_value(prev.sample,hit.p,hit.n,hit.material,-p.d.xyz,prev.coords.xy)),0.);let weight=select(prev.weight,importance*prev.weight/prev.importance,params.thresholds.w>0.5);r.count+=prev.count;r.weight+=weight;let reuse_random=rng(&state);if(weight>0.&&reuse_random*r.weight<weight){r.sample=prev.sample;r.importance=importance;r.coords=prev.coords;r.age=prev.age+1u;}}}
      if(bounce==0u&&params.dims.z>0u){for(var neighbor=0u;neighbor<params.reuse.y;neighbor++){let dx=i32(round((rng(&state)*2.-1.)*params.thresholds.z));let dy=i32(round((rng(&state)*2.-1.)*params.thresholds.z));let x=i32(p.tags.x%params.dims.x)+dx;let y=i32(p.tags.x/params.dims.x)+dy;if(x<0||x>=i32(params.dims.x)||y<0||y>=i32(params.dims.y)){continue;}let prev=history[u32(y)*params.dims.x+u32(x)];if(prev.count==0u||prev.importance<=0.||prev.age>=params.reuse.z||abs(prev.normal.w-hit.t)>params.thresholds.x*max(hit.t,1.)||dot(prev.normal.xyz,hit.n)<params.thresholds.y){continue;}let importance=max(lum(light_value(prev.sample,hit.p,hit.n,hit.material,-p.d.xyz,prev.coords.xy)),0.);let weight=select(prev.weight,importance*prev.weight/prev.importance,params.thresholds.w>0.5);r.count+=prev.count;r.weight+=weight;let choose=rng(&state);if(weight>0.&&choose*r.weight<weight){r.sample=prev.sample;r.importance=importance;r.coords=prev.coords;r.age=prev.age+1u;}}}
      let max_count=params.mode.w*(params.reuse.z+1u);if(r.count>max_count){r.weight*=f32(max_count)/f32(r.count);r.count=max_count;}
      if(r.importance>0.&&r.count>0u){light_index=r.sample;light_uv=r.coords.xy;lighting=light_value(r.sample,hit.p,hit.n,hit.material,-p.d.xyz,r.coords.xy)*r.weight/(f32(r.count)*r.importance);}if(bounce==0u){r.position=vec4f(hit.p,0.);r.normal=vec4f(hit.n,hit.t);reservoirs[p.tags.x]=r;}
    }
  }
  let lit=p.t.xyz*lighting;
  if(params.mode.z>0u&&any(lit>vec3f(0.))){let geometry=light_geometry(light_index,hit.p,light_uv);let distance=geometry[0].w;let direction=geometry[0].xyz;if(queued){pending[slot].shadowO=vec4f(hit.p+hit.n*0.0001,0.00001);pending[slot].shadowD=vec4f(direction,distance-0.0002);pending[slot].shadowC=vec4f(lit,select(2.,1.,bounce==0u));}else if(scene_hit(hit.p+hit.n*0.0001,direction,0.00001,distance-0.0002).id==0u){p.c+=vec4f(lit,0.);if(bounce==0u){p.direct+=vec4f(lit,0.);}else{p.indirect+=vec4f(lit,0.);}}}
  var direction=vec3f(0.);
  if(ior>1.){let eta=select(ior,1./ior,hit.front!=0u);let c=-dot(p.d.xyz,hit.n);let sin2=eta*eta*(1.-c*c);let f0=pow((1.-ior)/(1.+ior),2.);if(sin2>=1.||rng(&state)<f0+(1.-f0)*pow(1.-c,5.)){direction=safe_unit(reflect(p.d.xyz,hit.n));}else{direction=safe_unit(eta*p.d.xyz+(eta*c-sqrt(1.-sin2))*hit.n);}}
  else if(rng(&state)<metallic){let sampled=ggx(p.d.xyz,hit.n,albedo,roughness,rng(&state),rng(&state),sf(mat+9u),sf(mat+10u));direction=sampled[0];p.t=vec4f(p.t.xyz*sampled[1],0.);}
  else {let u=rng(&state);var v=rng(&state);var weight=1.;if(params.reuse.w>0u){let bins=params.reuse.w;let at=params.offsets1.w+p.tags.x*bins;var total=0.;for(var j=0u;j<bins;j++){total+=sf(at+j);}var sum=0.;var bin=0u;for(;bin+1u<bins;bin++){sum+=sf(at+bin)/total;if(v<sum){break;}}var previous=sum;if(bin+1u<bins){previous-=sf(at+bin)/total;}let pdf=sf(at+bin)/total;v=(f32(bin)+clamp((v-previous)/pdf,0.,1.))/f32(bins);weight=1./(f32(bins)*pdf);if(bounce==0u){p.identity.y=bin;p.identity.z=1u;}}direction=cosine(u,v,hit.n);p.t=vec4f(p.t.xyz*albedo*weight,0.);}
  p.o=vec4f(hit.p+direction*0.0001,0.);p.d=vec4f(direction,0.);if(bounce>=2u){let survival=clamp(max(max(p.t.x,p.t.y),p.t.z),0.05,0.95);if(rng(&state)>survival){p.tags.z=0u;}p.t=vec4f(p.t.xyz/survival,0.);}
  p.tags.y=state;p.tags.w+=1u;if(p.tags.w>=params.dims.w){p.tags.z=0u;}return p;
}
fn finish(input:Path) {var p=input;let l=lum(p.c.xyz);if(params.extra.z>0.&&l>params.extra.z){let s=params.extra.z/l;p.c=vec4f(p.c.xyz*s,0.);p.direct=vec4f(p.direct.xyz*s,p.direct.w);p.indirect=vec4f(p.indirect.xyz*s,p.indirect.w);p.emission=vec4f(p.emission.xyz*s,0.);}let at=p.tags.x*28u;
  let fields=array<vec4f,7>(vec4f(p.c.xyz,1.),p.a,p.n,p.direct,p.indirect,p.emission,vec4f(p.bent.xyz,lum(p.c.xyz)*lum(p.c.xyz)));
  for(var slot=0u;slot<7u;slot++){for(var c=0u;c<4u;c++){let i=slot*4u+c;if(i==23u){output[at+i]=select(0xffffffffu,p.identity.y,p.identity.z!=0u);}else if(i==7u){if(params.dims.z==0u){output[at+i]=p.identity.x;}}else if(i==11u){if(params.dims.z==0u){output[at+i]=bitcast<u32>(p.n.w);}}else{output[at+i]=bitcast<u32>(bitcast<f32>(output[at+i])+fields[slot][c]);}}}
}
@compute @workgroup_size(64) fn megakernel(@builtin(global_invocation_id) gid:vec3u){let pixel=gid.x;if(pixel>=params.dims.x*params.dims.y){return;}var p=initial(pixel);for(var b=0u;b<params.dims.w;b++){p=shade(p,scene_hit(p.o.xyz,p.d.xyz,0.00001,1e30),false,pixel);if(p.tags.z==0u){break;}}finish(p);}
@compute @workgroup_size(64) fn raygen(@builtin(global_invocation_id) gid:vec3u){let pixel=gid.x;if(pixel<params.dims.x*params.dims.y){paths[pixel]=initial(pixel);}}
@compute @workgroup_size(64) fn intersect_queue(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=work[0]){return;}let p=paths[i];var q:QueueItem;q.hit=scene_hit(p.o.xyz,p.d.xyz,0.00001,1e30);pending[i]=q;}
@compute @workgroup_size(64) fn shade_queue(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i<work[0]){paths[i]=shade(paths[i],pending[i].hit,true,i);}}
@compute @workgroup_size(64) fn shadow_queue(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=work[0]){return;}var p=paths[i];let q=pending[i];if(q.shadowC.w>0.&&scene_hit(q.shadowO.xyz,q.shadowD.xyz,q.shadowO.w,q.shadowD.w).id==0u){p.c+=vec4f(q.shadowC.xyz,0.);if(q.shadowC.w==1.){p.direct+=vec4f(q.shadowC.xyz,0.);}else{p.indirect+=vec4f(q.shadowC.xyz,0.);}}paths[i]=p;if(p.tags.z==0u){finish(p);}}
var<workgroup> scan:array<u32,256>;
@compute @workgroup_size(256) fn compact_count(@builtin(global_invocation_id) gid:vec3u,@builtin(local_invocation_id) lid:vec3u,@builtin(workgroup_id) wid:vec3u){let i=gid.x;scan[lid.x]=0u;if(i<work[0]){scan[lid.x]=paths[i].tags.z;}workgroupBarrier();for(var step=1u;step<256u;step*=2u){var v=0u;if(lid.x>=step){v=scan[lid.x-step];}workgroupBarrier();scan[lid.x]+=v;workgroupBarrier();}if(i<params.dims.x*params.dims.y){work[4u+i]=scan[lid.x];}if(lid.x==255u){work[4u+params.dims.x*params.dims.y+wid.x]=scan[255];}}
@compute @workgroup_size(1) fn compact_prefix(){let n=params.dims.x*params.dims.y;let blocks=(n+255u)/256u;var sum=0u;for(var i=0u;i<blocks;i++){let at=4u+n+i;let count=work[at];work[at]=sum;sum+=count;}work[1]=sum;}
@compute @workgroup_size(64) fn compact_scatter(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=work[0]){return;}let p=paths[i];if(p.tags.z!=0u){let rank=work[4u+i]-1u;let offset=work[4u+params.dims.x*params.dims.y+i/256u];next_paths[offset+rank]=p;}}
@compute @workgroup_size(1) fn compact_commit(){work[0]=work[1];}
`;
