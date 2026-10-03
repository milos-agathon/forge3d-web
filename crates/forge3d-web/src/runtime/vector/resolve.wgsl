struct Highlight { ids:vec4<u32>, color:vec4<f32>, options:vec4<f32> };
@group(0) @binding(0) var accum:texture_2d<f32>;
@group(0) @binding(1) var reveal:texture_2d<f32>;
@group(0) @binding(2) var ids:texture_2d<u32>;
@group(0) @binding(3) var background:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> highlights:array<Highlight>;
@group(0) @binding(5) var<uniform> mode:vec4<u32>;
struct Out { @builtin(position) pos:vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {return Out(vec4<f32>(f32((i<<1u)&2u)*2.0-1.0,f32(i&2u)*2.0-1.0,0,1));}
fn id_at(p:vec2<i32>)->u32 {let size=vec2<i32>(textureDimensions(ids));if(any(p<vec2<i32>(0))||any(p>=size)){return 0u;}return textureLoad(ids,p,0).x;}
@fragment fn fs(v:Out)->@location(0) vec4<f32> {
 let p=vec2<i32>(v.pos.xy);let a=textureLoad(accum,p,0);var color=a;
 if(mode.x==1u){let alpha=1.0-textureLoad(reveal,p,0).r;color=vec4<f32>(a.rgb/max(a.a,1e-6)*alpha,alpha);}
 let id=id_at(p);
 for(var h=0u;h<mode.y;h++){let highlight=highlights[h];let selected=id==highlight.ids.x;let pulse=highlight.options.w;
  if(selected){color=vec4<f32>(mix(color.rgb,highlight.color.rgb*color.a,highlight.color.a*pulse),color.a);}
  if(highlight.ids.y!=0u||highlight.ids.z!=0u){let radius=i32(min(32.0,max(highlight.options.x,highlight.options.z)));var distance=1e6;
   for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){let neighbor=id_at(p+vec2<i32>(x,y));if((selected&&neighbor!=id)||(!selected&&neighbor==highlight.ids.x)){distance=min(distance,length(vec2<f32>(f32(x),f32(y))));}}}
   var strength=0.0;if(highlight.ids.y!=0u&&distance<=highlight.options.x){strength=highlight.color.a*pulse;}
   if(highlight.ids.z!=0u&&distance<=highlight.options.z){strength=max(strength,exp(-distance*distance/max(1.0,highlight.options.z*highlight.options.z*.25))*highlight.options.y*pulse);}
   let overlay=vec4<f32>(highlight.color.rgb*strength,min(strength,1.0));color=overlay+color*(1.0-overlay.a);
  }
 }
 if(mode.z!=0u){let bg=textureLoad(background,p,0);return color+bg*(1.0-color.a);}return color;
}
