struct Highlight { ids:vec4<u32>, color:vec4<f32>, options:vec4<f32> };
@group(0) @binding(0) var accum:texture_2d<f32>;
@group(0) @binding(1) var reveal:texture_2d<f32>;
@group(0) @binding(2) var ids:texture_2d<u32>;
@group(0) @binding(3) var background:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> highlights:array<Highlight>;
struct Mode { values:vec4<u32>, options:vec4<f32> };
@group(0) @binding(5) var<uniform> mode:Mode;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var<storage,read> bounds:array<u32>;
@group(0) @binding(8) var highlight_overlay:texture_2d<f32>;
@group(0) @binding(9) var highlight_tint:texture_2d<f32>;
struct Out { @builtin(position) pos:vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {return Out(vec4<f32>(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0,1));}
fn id_at(p:vec2<i32>)->u32 {let size=vec2<i32>(textureDimensions(ids));if(any(p<vec2<i32>(0))||any(p>=size)){return 0u;}return textureLoad(ids,p,0).x;}
// Highlights are sorted, unique IDs; the count has no arbitrary 4096 cap.
fn find(id:u32)->u32 {
 if(id==0u){return mode.values.y;}var lo=0u;var hi=mode.values.y;
 while(lo<hi){let mid=lo+(hi-lo)/2u;if(highlights[mid].ids.x<id){lo=mid+1u;}else{hi=mid;}}
 if(lo<mode.values.y&&highlights[lo].ids.x==id){return lo;}return mode.values.y;
}
fn strength(h:Highlight,distance:f32)->f32 {
 var value=0.0;
 if(h.ids.y!=0u&&distance<=h.options.x){value=h.color.a*h.options.w;}
 if(h.ids.z!=0u&&distance<=h.options.z){value=max(value,exp(-distance*distance/max(1.0,h.options.z*h.options.z*.25))*h.options.y*h.options.w);}
 return min(value,1.0);
}
fn linearize(x:vec3<f32>)->vec3<f32>{return select(pow((x+vec3<f32>(.055))/1.055,vec3<f32>(2.4)),x/12.92,x<=vec3<f32>(.04045));}
struct Effect { @location(0) overlay:vec4<f32>, @location(1) tint:vec4<f32> };
fn effect(p:vec2<i32>)->Effect {
 var tint=vec4<f32>(0);var overlay=vec4<f32>(0);
 let id=id_at(p);let selected=find(id);let radius=i32(mode.values.w&65535u);
 if(selected<mode.values.y){let h=highlights[selected];tint=vec4<f32>(h.color.rgb,h.color.a*h.options.w);}
 // One neighbourhood traversal for all selected features. Repeated neighbor
 // IDs reuse their lookup; interior pixels only compare IDs to their own.
 let minimum=vec2<i32>(i32(bounds[0]),i32(bounds[1]));let maximum=vec2<i32>(i32(bounds[2]),i32(bounds[3]));
 let nearest=max(max(minimum-p,p-maximum),vec2<i32>(0));
 let first_ring=select(max(1,max(nearest.x,nearest.y)),1,selected<mode.values.y);
 if(radius>0&&all(minimum<=maximum)&&first_ring<=radius){
  var best=0.0;var previous=0u;var neighbor_highlight=mode.values.y;
  // Concentric rings visit the closest boundary first. Once the global
  // strength bound is reached no farther sample can change the overlay.
  for(var ring=first_ring;ring<=radius;ring++){
   for(var sample=0;sample<8*ring;sample++){
    var offset=vec2<i32>(0);
    if(sample<2*ring){offset=vec2<i32>(-ring+sample,-ring);}
    else if(sample<4*ring){offset=vec2<i32>(ring,-ring+sample-2*ring);}
    else if(sample<6*ring){offset=vec2<i32>(ring-(sample-4*ring),ring);}
    else {offset=vec2<i32>(-ring,ring-(sample-6*ring));}
    let distance=length(vec2<f32>(offset));if(distance>f32(radius)){continue;}
    let neighbor_position=p+offset;
    if(selected>=mode.values.y&&(any(neighbor_position<minimum)||any(neighbor_position>maximum))){continue;}
    let neighbor=id_at(neighbor_position);
    if(selected<mode.values.y&&neighbor!=id){let h=highlights[selected];let value=strength(h,distance);if(value>best){best=value;overlay=vec4<f32>(h.color.rgb*value,value);}}
    if(neighbor!=id&&neighbor!=0u){
     if(neighbor!=previous){neighbor_highlight=find(neighbor);previous=neighbor;}
     if(neighbor_highlight<mode.values.y){let h=highlights[neighbor_highlight];let value=strength(h,distance);if(value>best){best=value;overlay=vec4<f32>(h.color.rgb*value,value);}}
    }
    if(best>=mode.options.x){break;}
   }
   if(best>=mode.options.x){break;}
  }

 }
 return Effect(overlay,tint);
}
@fragment fn fs_highlight(v:Out)->Effect {return effect(vec2<i32>(v.pos.xy));}
@fragment fn fs(v:Out)->@location(0) vec4<f32> {
 let p=vec2<i32>(v.pos.xy);let a=textureLoad(accum,p,0);var color=a;
 if(mode.values.x==1u){let alpha=1.0-textureLoad(reveal,p,0).r;color=vec4<f32>(a.rgb/max(a.a,1e-6)*alpha,alpha);}
 color=color+textureLoad(opaque,p,0)*(1.0-color.a);
 let tint=textureLoad(highlight_tint,p,0);let overlay=textureLoad(highlight_overlay,p,0);
 color=vec4<f32>(mix(color.rgb,tint.rgb*color.a,tint.a),color.a);
 color=overlay+color*(1.0-overlay.a);
 if(mode.values.z!=0u){let bg=textureLoad(background,p,0);color=color+bg*(1.0-color.a);}
 if(mode.values.x==2u&&a.a>0.0){
  let mapped=pow(max(color.rgb,vec3<f32>(0))/(vec3<f32>(1)+max(color.rgb,vec3<f32>(0))),vec3<f32>(1.0/2.2));
  color=vec4<f32>(select(mapped,linearize(mapped),(mode.values.w&65536u)!=0u),color.a);
 }
 return color;
}
