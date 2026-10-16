@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var destination:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
    let size=textureDimensions(destination);if any(id.xy>=size){return;}
    let source_size=textureDimensions(source);let lo=id.xy*source_size/size;let hi=(id.xy+1u)*source_size/size;
    var depth=1.;for(var y=lo.y;y<hi.y;y++){for(var x=lo.x;x<hi.x;x++){depth=min(depth,textureLoad(source,vec2<i32>(i32(x),i32(y)),0).r);}}
    textureStore(destination,vec2<i32>(id.xy),vec4<f32>(depth));
}
