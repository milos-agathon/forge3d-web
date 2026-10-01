import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export async function compareNativeScatterShaders(page: Page) {
  const truth=JSON.parse(readFileSync(new URL('../golden/w09/scatter-shader.json',import.meta.url),'utf8'));
  const runtime=JSON.parse(readFileSync(new URL('../golden/w09/scatter-runtime.json',import.meta.url),'utf8'));
  const port=readFileSync(new URL('../../src/runtime/scatter/shader.rs',import.meta.url),'utf8');
  const vertex=port.split('const VERTEX: &str = r#"')[1]!.split('"#;')[0]!;
  const helpers=port.split('const HELPERS: &str = r#"')[1]!.split('"#;')[0]!;
  const shade=helpers.slice(helpers.indexOf('fn scatter_shade(')).replace('discard;','return vec4<f32>(0.0);');
  return page.evaluate(async({native,vertex,shade,runtime})=>{
    const gpu=(navigator as any).gpu,adapter=await gpu.requestAdapter();if(!adapter)throw new Error('Native scatter comparison requires WebGPU');
    const device=await adapter.requestDevice();
    const item=(text:string,marker:string)=>{const start=text.indexOf(marker),opening=text.indexOf('{',start);let depth=1,end=opening+1;while(depth){depth+=(text[end]==='{')?1:(text[end]==='}')?-1:0;end++;}return text.slice(start,end);};
    const extra=`@group(2) @binding(0) var<storage,read> data:array<vec4<f32>>; @group(2) @binding(1) var<storage,read_write> results:array<vec4<f32>>;`;
    const common=`struct Camera {view_projection:mat4x4<f32>,camera_position:vec4<f32>}; @group(1) @binding(0) var<uniform> camera:Camera;
struct Settings {wind_phase:vec4<f32>,wind_vector:vec4<f32>,wind_fade:vec4<f32>,blend:vec4<f32>,contact:vec4<f32>,height_mapping:vec4<f32>,height_scale:vec4<f32>,streaming:vec4<u32>}; @group(0) @binding(0) var<uniform> scatter_settings:Settings;
fn forge3d_safe_direction(v:vec3<f32>)->vec3<f32>{return normalize(v);}`;
    const nativeWind=native.replace('@vertex\n','')+extra+`@compute @workgroup_size(1) fn compare(@builtin(global_invocation_id) gid:vec3<u32>){let i=gid.x;let b=i*6u;if(b>=arrayLength(&data)){return;}var input:VsIn;input.position=data[b].xyz;input.normal=data[b+1u].xyz;input.i_m0=data[b+2u];input.i_m1=data[b+3u];input.i_m2=data[b+4u];input.i_m3=data[b+5u];let out=vs_main(input);results[i*2u]=vec4<f32>(out.world_pos,1.0);results[i*2u+1u]=vec4<f32>(out.n_ws,1.0);}`;
    const webWind=common+extra+`struct Input{position:vec3<f32>,normal:vec3<f32>,instance_row0:vec4<f32>,instance_row1:vec4<f32>,instance_row2:vec4<f32>,instance_row3:vec4<f32>};
@compute @workgroup_size(1) fn compare(@builtin(global_invocation_id) gid:vec3<u32>){let i=gid.x;let b=i*6u;if(b>=arrayLength(&data)){return;}let rows=transpose(mat4x4<f32>(data[b+2u],data[b+3u],data[b+4u],data[b+5u]));var input:Input;input.position=data[b].xyz;input.normal=data[b+1u].xyz;input.instance_row0=rows[0];input.instance_row1=rows[1];input.instance_row2=rows[2];input.instance_row3=rows[3];`+vertex.slice(0,vertex.indexOf('    output.position ='))+`results[i*2u]=vec4<f32>(scatter_position,1.0);results[i*2u+1u]=vec4<f32>(scatter_normal,1.0);}`;
    // Execute the original native blend/contact statements. A discarded fragment
    // is represented by zero RGBA in both compute wrappers.
    const fs=item(native,'fn fs_main('),alpha=fs.slice(fs.indexOf('  var alpha ='),fs.indexOf('  let lit =')).replace('discard;','return vec4<f32>(0.0);');
    const contact=fs.slice(fs.indexOf('  var contact ='),fs.lastIndexOf('}'));
    const nativeShade=item(native,'struct ScatterBatchUniforms {')+'@group(0) @binding(0) var<uniform> U:ScatterBatchUniforms;'+item(native,'fn saturate(')+extra+`fn shade(lit:vec3<f32>,height_delta:f32,n:vec3<f32>)->vec4<f32>{`+alpha+contact+`}
@compute @workgroup_size(1) fn compare(@builtin(global_invocation_id) gid:vec3<u32>){let i=gid.x;let b=i*2u;if(b>=arrayLength(&data)){return;}results[i]=shade(vec3<f32>(0.8,0.4,0.2),data[b].x,data[b+1u].xyz);}`;
    const webShade=common+extra+'fn scatter_height_delta(position:vec3<f32>)->f32{return position.y;}'+shade+`@compute @workgroup_size(1) fn compare(@builtin(global_invocation_id) gid:vec3<u32>){let i=gid.x;let b=i*2u;if(b>=arrayLength(&data)){return;}results[i]=scatter_shade(vec3<f32>(0.8,0.4,0.2),0.7,vec3<f32>(0.0,data[b].x,0.0),data[b+1u].xyz);}`;
    const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],view=[...identity];view[14]=-50;
    const camera=new Float32Array([...identity,0,0,50,1]);
    const run=async(code:string,input:Float32Array,uniform:Float32Array,count:number,lanes:number)=>{
      device.pushErrorScope('validation');const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'compare'}});
      const buffer=(bytes:Float32Array,usage:number)=>{const b=device.createBuffer({size:bytes.byteLength,usage:usage|8});device.queue.writeBuffer(b,0,bytes);return b;};
      const u=buffer(uniform,64),c=buffer(camera,64),d=buffer(input,128),out=device.createBuffer({size:count*lanes*4,usage:128|4}),read=device.createBuffer({size:count*lanes*4,usage:1|8});
      const bg=(group:number,entries:any[])=>device.createBindGroup({layout:pipeline.getBindGroupLayout(group),entries});
      const group0=bg(0,[{binding:0,resource:{buffer:u}}]);
      const group1=bg(1,code===webWind?[{binding:0,resource:{buffer:c}}]:[]);
      const group2=bg(2,[{binding:0,resource:{buffer:d}},{binding:1,resource:{buffer:out}}]);
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.setBindGroup(2,group2);pass.dispatchWorkgroups(count);pass.end();encoder.copyBufferToBuffer(out,0,read,0,count*lanes*4);device.queue.submit([encoder.finish()]);await read.mapAsync(1);const result=new Float32Array(read.getMappedRange().slice(0));read.unmap();const error=await device.popErrorScope();for(const b of[u,c,d,out,read])b.destroy();if(error)throw new Error(error.message);return result;
    };
    const error=(a:Float32Array,b:Float32Array)=>a.reduce((m,v,i)=>Math.max(m,Math.abs(v-b[i]!)),0);
    const windInput:number[]=[];for(let instance=0;instance<runtime.transforms.length/16;instance++){const row=runtime.transforms.slice(instance*16,instance*16+16);const cols=[0,1,2,3].flatMap(col=>[row[col],row[col+4],row[col+8],row[col+12]]);for(const position of [[-1,0,0],[1,6,0],[-1,10,0]])for(const normal of [[0,0,1],[0,1,0]])windInput.push(...position,0,...normal,0,...cols);}
    const wind=new Float32Array(windInput),windCount=wind.length/24;
    const profile=(phase:number[],vector:number[],fade:number[],blend=[0,0.75,2.5,0],contact=[0,3,0.35,0.65])=>({native:new Float32Array([...view,...identity,.8,.4,.2,.7,0,-1,0,1,...phase,...vector,...fade,...blend,...contact]),web:new Float32Array([...phase,...vector,...fade,...blend,...contact,0,0,1,1,0,1,0,1,1,1,1,1])});
    const w=runtime.wind,profiles=[profile(w.phase,w.vector,w.fade),profile([0,0,1,.2],w.vector,w.fade),profile([0,0,0,0],[0,0,0,0],[0,0,0,0]),profile([1,1,0,1],w.vector,w.fade),profile(w.phase,w.vector,[1,1,0,0]),profile(w.phase,w.vector,[.1,.8,1,2]),profile(w.phase,[1e-7,0,0,12],w.fade)];
    let windMaxAbs=0;for(const p of profiles)windMaxAbs=Math.max(windMaxAbs,error(await run(nativeWind,wind,p.native,windCount,8),await run(webWind,wind,p.web,windCount,8)));
    const wrong=profiles[0]!.web.slice();wrong[4]=-wrong[4]!;const windControl=error(await run(nativeWind,wind,profiles[0]!.native,windCount,8),await run(webWind,wind,wrong,windCount,8));
    const blendInput:number[]=[];for(const height of[-2,-.75,-.00005,0,.00005,1,3])for(const n of[[0,1,0],[0,0,1],[.6,.8,0]])blendInput.push(height,0,0,0,...n,0);const input=new Float32Array(blendInput),count=input.length/8;
    const shadeProfiles=[profile(w.phase,w.vector,w.fade,[1,.75,2.5,0],[1,3,.35,.65]),profile(w.phase,w.vector,w.fade,[1,.00001,.00001,0],[1,.00001,.9,.4]),profile(w.phase,w.vector,w.fade)];let shadeMaxAbs=0;for(const p of shadeProfiles)shadeMaxAbs=Math.max(shadeMaxAbs,error(await run(nativeShade,input,p.native,count,4),await run(webShade,input,p.web,count,4)));
    device.destroy();return{windMaxAbs,shadeMaxAbs,windControl,windSamples:windCount*profiles.length,shadeSamples:count*shadeProfiles.length};
  },{native:truth.source,vertex,shade,runtime});
}
