// Executes immutable historical shader sources on an independent WebGPU device.
// No browser-runtime shader or CPU post-FX implementation is used by this oracle.
const root = "/tests/golden/w11/native/";
const source = name => fetch(root + name.replaceAll("/", "__")).then(r => { if (!r.ok) throw Error(name); return r.text(); });
const encode = x => x <= .0031308 ? x * 12.92 : 1.055 * Math.max(x, 0) ** (1 / 2.4) - .055;
export function adaptNativeDofSource(code) {
  // Preserve the historical RGB debug overlay and alpha while avoiding a
  // multi-component swizzle assignment, which Firefox's Naga parser rejects.
  return code
    .replace("final_color.rgb = mix(final_color.rgb, vec3<f32>(1.0, 1.0, 0.0), coc_overlay * 0.3);", "final_color = vec4<f32>(mix(final_color.rgb, vec3<f32>(1.0, 1.0, 0.0), coc_overlay * 0.3), final_color.a);")
    .replace(/textureSample\((\w+), (\w+), (\w+)\)/g, "textureSampleLevel($1, $2, $3, 0.0)");
}
export function nativeSsrInputs(packedNormals, worldNormals, projection, matrices) {
  const normal = new Float32Array(packedNormals), camera = new Float32Array(matrices);
  // The pinned fallback shader multiplies this channel directly by the mip
  // count. Web IBL uses perceptual roughness squared for the same source LOD.
  for (let i = 3; i < normal.length; i += 4) normal[i] = worldNormals[i] ** 2;
  // Despite the field's historical name, fallback_env divides NDC by these
  // entries as focal lengths. Supply projection scales to reconstruct the
  // same ray; the other native effects retain the true inverse projection.
  camera[48] = projection[0]; camera[53] = projection[5];
  return {normal, camera};
}
const halfFloat=new Float32Array(1),halfBits=new Uint32Array(halfFloat.buffer);
function half(x) {
  halfFloat[0]=x;const bits=halfBits[0];
  const sign = (bits >>> 16) & 0x8000, exp = ((bits >>> 23) & 255) - 112, mantissa = bits & 0x7fffff;
  if (exp <= 0) return exp < -10 ? sign : sign | (((mantissa | 0x800000) + (1 << (12 - exp))) >>> (14 - exp));
  // Rounding may carry into the exponent (e.g. 0.49999997 -> 0.5).
  return sign | ((Math.min(exp, 30) << 10) + ((mantissa + 4096) >>> 13));
}
function fromHalf(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exp = (bits >>> 10) & 31, mantissa = bits & 1023;
  return sign * (exp ? 2 ** (exp - 15) * (1 + mantissa / 1024) : 2 ** -14 * mantissa / 1024);
}
export function referenceSpecularCube(size, levels) {
  let texels=0;for(let mip=0;mip<levels;mip++)texels+=6*Math.max(1,size>>mip)**2;
  const data=new Uint16Array(texels*4);let offset=0;
  for(let mip=0;mip<levels;mip++){
    const dim=Math.max(1,size>>mip);
    for(let face=0;face<6;face++)for(let y=0;y<dim;y++)for(let x=0;x<dim;x++){
      const u=(x+.5)/dim*2-1,v=(y+.5)/dim*2-1;
      let dx,dy,dz;
      switch(face){case 0:dx=1;dy=-v;dz=-u;break;case 1:dx=-1;dy=-v;dz=u;break;case 2:dx=u;dy=1;dz=v;break;case 3:dx=u;dy=-1;dz=-v;break;case 4:dx=u;dy=-v;dz=1;break;default:dx=-u;dy=-v;dz=-1;}
      const length=Math.hypot(dx,dy,dz);
      data[offset++]=half(.08+.07*dx/length+2*mip);
      data[offset++]=half(.12+.07*dy/length+2*mip);
      data[offset++]=half(.16+.07*dz/length+2*mip);
      data[offset++]=half(1);
    }
  }
  return new Uint8Array(data.buffer);
}
export function imageMetrics(a, b, width, height, channels = 4) {
  let ssim = 0, windows = 0, maxAbs = 0, mae = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); maxAbs = Math.max(maxAbs, d); mae += d; }
  for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) for (let c = 0; c < Math.min(channels, 3); c++) {
    let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
    for (let yy = y; yy < Math.min(y + 8, height); yy++) for (let xx = x; xx < Math.min(x + 8, width); xx++) {
      const i = (yy * width + xx) * channels + c, av = a[i], bv = b[i];
      n++; sa += av; sb += bv; aa += av * av; bb += bv * bv; ab += av * bv;
    }
    const ma = sa / n, mb = sb / n, va = Math.max(aa / n - ma * ma, 0), vb = Math.max(bb / n - mb * mb, 0), cov = ab / n - ma * mb;
    ssim += ((2 * ma * mb + .0001) * (2 * cov + .0009)) / ((ma * ma + mb * mb + .0001) * (va + vb + .0009)); windows++;
  }
  return {ssim: ssim / windows, maxAbs, mae: mae / a.length};
}
export async function nativeComparisons(api, r, camera) {
  const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
  const width = r.width, height = r.height, resources = [], errors = [];
  device.addEventListener("uncapturederror", e => errors.push(e.error.message));
  const sampler = device.createSampler({magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge"});
  const buffer = data => { const b = device.createBuffer({size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(b, 0, data); resources.push(b); return b; };
  function texture(data, format = "rgba16float") {
    const t = device.createTexture({size: [width, height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST}); resources.push(t);
    if (data) { const values = format === "rgba16float" ? Uint16Array.from(data, half) : data; device.queue.writeTexture({texture: t}, values, {bytesPerRow: width * (format === "r32float" ? 4 : format === "rgba32float" ? 16 : 8)}, [width, height]); }
    return t;
  }
  async function dispatch(code, entry, bindings, format = "rgba16float") {
    const output = texture(null, format), module = device.createShaderModule({code});
    const info = await module.getCompilationInfo(); if (info.messages.some(m => m.type === "error")) throw Error(info.messages.map(m => m.message).join("\n"));
    const pipeline = await device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint: entry}});
    const entries = bindings.map(([binding, value]) => ({binding, resource: value === "output" ? output.createView() : value instanceof GPUTexture ? value.createView() : value instanceof GPUBuffer ? {buffer: value} : value}));
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end(); device.queue.submit([encoder.finish()]);
    return output;
  }
  async function read(t) {
    const bytes = t.format === "r32float" ? 4 : t.format === "rgba8unorm" ? 4 : 8, row = Math.ceil(width * bytes / 256) * 256;
    const b = device.createBuffer({size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}); resources.push(b);
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({texture: t}, {buffer: b, bytesPerRow: row}, [width, height]); device.queue.submit([encoder.finish()]); await b.mapAsync(GPUMapMode.READ);
    const channels = t.format === "r32float" ? 1 : 4, result = new Float32Array(width * height * channels), data = new DataView(b.getMappedRange());
    for (let y = 0; y < height; y++) for (let x = 0; x < width * channels; x++) result[y * width * channels + x] = t.format === "r32float" ? data.getFloat32(y * row + x * 4, true) : t.format === "rgba8unorm" ? data.getUint8(y * row + x) / 255 : fromHalf(data.getUint16(y * row + x * 2, true));
    b.unmap(); return result;
  }
  try {
    r.setPostFx([{kind: "tonemap", operator: "aces"}]); r.render();
    const color = await r.readPostFxIntermediate("color"), depth = await r.readPostFxIntermediate("depth"), normal = await r.readPostFxIntermediate("normal");
    const input = texture(color.data), z = Float32Array.from(depth.data, d => d < .999 ? camera.near + d * (camera.far - camera.near) : 0);
    const nativeDepth = texture(z, "r32float"), depthRgba = new Float32Array(width * height * 4);
    z.forEach((v, i) => { depthRgba[i * 4] = v || camera.far; });
    const dofDepth = texture(depthRgba), view = api.lookAt(camera.position, camera.target, camera.up), projection = api.perspective(camera.fovYDegrees, width / height, camera.near, camera.far);
    const packed = new Float32Array(normal.data.length);
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) packed[i * 4 + c] = .5 + .5 * (view[c] * normal.data[i * 4] + view[c + 4] * normal.data[i * 4 + 1] + view[c + 8] * normal.data[i * 4 + 2]);
    const nativeNormal = texture(packed, "rgba32float"), matrices = new Float32Array(88);
    matrices.set(view); matrices.set(api.invertMatrix(view), 16); matrices.set(projection, 32); matrices.set(api.invertMatrix(projection), 48); matrices.set(api.multiplyMatrices(projection, view), 64); matrices.set(camera.position, 80);
    const cam = buffer(matrices), common = await source("src/shaders/ssao/common.wgsl"), results = {};
    for (const kind of ["ssao", "gtao"]) {
      const effect = {kind, id: kind, radius: .8, intensity: 1.5, samples: 32, bilateralRadius: 0, temporalWeight: 0}; r.setPostFx([effect]); r.render();
      const actual = await r.readPostFxIntermediate(kind + ":trace"), params = new ArrayBuffer(48), f = new Float32Array(params), u = new Uint32Array(params);
      f.set([.8, 1.5, .025]); u[3] = 32; u[4] = kind === "gtao" ? 1 : 0; f.set([1 / width, 1 / height, .5 * height * projection[5], .05], 6);
      const output = await dispatch(common + "\n" + await source(`src/shaders/ssao/${kind}.wgsl`), "cs_" + kind, [[0, nativeDepth], [2, nativeNormal], [5, "output"], [6, buffer(new Uint8Array(params))], [7, cam]], "r32float");
      const expected = await read(output), values = Float32Array.from(expected, v => v), actualScalar = actual.data.filter((_, i) => i % 4 === 0);
      // Background zero depth is explicitly a neutral AO value in both graphs.
      results[kind] = {...imageMetrics(values, actualScalar, width, height, 1), control: imageMetrics(values, new Float32Array(values.length), width, height, 1).ssim};
    }
    r.setPostFx([{kind: "bloom", id: "bloom",threshold:.3,strength:1}, {kind: "tonemap", operator: "aces"}]); r.render();
    const bp = await dispatch((await source("src/shaders/bloom_brightpass.wgsl")).replaceAll("rgba8unorm", "rgba16float"), "main", [[0, input], [1, "output"], [2, buffer(new Float32Array([.3, .5, 0, 0]))]]);
    const h = await dispatch((await source("src/shaders/bloom_blur_h.wgsl")).replaceAll("rgba8unorm", "rgba16float").replace("OFFSETS[i] * uniforms.radius", "f32(OFFSETS[i]) * uniforms.radius"), "main", [[0, bp], [1, "output"], [2, buffer(new Float32Array([1, 1, 0, 0]))]]);
    const v = await dispatch((await source("src/shaders/bloom_blur_v.wgsl")).replaceAll("rgba8unorm", "rgba16float").replace("OFFSETS[i] * uniforms.radius", "f32(OFFSETS[i]) * uniforms.radius"), "main", [[0, h], [1, "output"], [2, buffer(new Float32Array([1, 1, 0, 0]))]]);
    const composite = await dispatch((await source("src/shaders/bloom_composite.wgsl")).replaceAll("rgba8unorm", "rgba16float"), "main", [[0, input], [1, v], [2, "output"], [3, buffer(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))]]);
    const bloom = await r.readPostFxIntermediate("bloom:composite"), bloomExpected = await read(composite);
    results.bloom = {...imageMetrics(bloomExpected, bloom.data, width, height), control: imageMetrics(bloomExpected, color.data, width, height).ssim};
    for (const [quality, samples, level, maxBlur] of [["medium", 16, 1, 12], ["high", 24, 2, 16]]) {
      r.setPostFx([{kind: "dof", id: "focus", aperture: 1, focusDistance: 1, quality, tiltPitch: .25, tiltYaw: -.15}]); r.render();
      const params = new ArrayBuffer(80), f = new Float32Array(params), u = new Uint32Array(params);
      f.set([1, 1, 50, 36, 1, maxBlur]); u[6] = samples; u[7] = level; f.set([width, height, 1 / width, 1 / height], 12); f[18] = .25; f[19] = -.15;
      const code = adaptNativeDofSource(await source("src/shaders/dof.wgsl"));
      const out = await dispatch(code, "cs_dof", [[0, buffer(new Uint8Array(params))], [1, input], [2, dofDepth], [3, sampler], [4, "output"]]);
      const expected = await read(out), actual = await r.readPostFxIntermediate("focus:resolve");
      results["dof-" + quality] = {...imageMetrics(expected, actual.data, width, height), control: imageMetrics(expected, color.data, width, height).ssim};
    }
    r.setPostFx([{kind: "tonemap", id: "map", operator: "aces"}, {kind: "lens", id: "lens", distortion: .3, chromaticAberration: .08, vignetteStrength: .8}]); r.render();
    const mapped = await r.readPostFxIntermediate("map:resolve"), display = Float32Array.from(mapped.data, (v, i) => i % 4 === 3 ? v : encode(v)), params = new ArrayBuffer(32), f = new Float32Array(params), u = new Uint32Array(params);
    u[0] = 1; f.set([.3, .08, .8, .8, .3], 1); u[6] = width; u[7] = height;
    const lensOutput = await dispatch(await source("src/shaders/lens_effects.wgsl"), "cs_lens_effects", [[0, buffer(new Uint8Array(params))], [1, texture(display)], [2, "output"], [3, sampler]], "rgba8unorm");
    const expected = await read(lensOutput), actual = Float32Array.from(await r.readRgba(), v => v / 255);
    results.lens = {...imageMetrics(expected, actual, width, height), control: imageMetrics(expected, display, width, height).ssim};
    const toneCode=await source("src/shaders/postprocess_tonemap.wgsl"),toneModule=device.createShaderModule({code:toneCode});
    const tonePipeline=await device.createRenderPipelineAsync({layout:"auto",vertex:{module:toneModule,entryPoint:"vs_main"},fragment:{module:toneModule,entryPoint:"fs_main",targets:[{format:"rgba8unorm"}]},primitive:{topology:"triangle-list"}});
    for(const [operator,index,graded] of [["reinhard",0,false],["reinhard-extended",1,false],["aces",2,false],["uncharted2",3,false],["exposure",4,false],["aces",2,true]]){
      const lut=api.createIdentityColorLut(3);if(graded)for(let i=0;i<lut.data.length;i+=3)lut.data[i]=1-lut.data[i];
      r.setPostFx([{kind:"tonemap",id:"map",operator,exposure:1,gamma:2.2,...(graded?{lut}:{})}]);r.render();
      const lutTexture=device.createTexture({dimension:"3d",size:[3,3,3],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(lutTexture);
      const rgba=new Uint16Array(3**3*4);for(let i=0;i<3**3;i++){rgba[i*4]=half(lut.data[i*3]);rgba[i*4+1]=half(lut.data[i*3+1]);rgba[i*4+2]=half(lut.data[i*3+2]);rgba[i*4+3]=half(1);}
      device.queue.writeTexture({texture:lutTexture},rgba,{bytesPerRow:24,rowsPerImage:3},[3,3,3]);
      const p=new ArrayBuffer(48),f=new Float32Array(p),u=new Uint32Array(p);f.set([2,4,2.2]);u[3]=index;u[4]=graded?1:0;f[5]=1;f[6]=3;
      const out=device.createTexture({size:[width,height],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});resources.push(out);
      const group=device.createBindGroup({layout:tonePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:input.createView()},{binding:1,resource:sampler},{binding:2,resource:{buffer:buffer(new Uint8Array(p))}},{binding:3,resource:lutTexture.createView()},{binding:4,resource:sampler}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:out.createView(),clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(tonePipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);
      const expected=await read(out),actual=Float32Array.from(await r.readRgba(),v=>v/255),control=Float32Array.from(expected,(_,i)=>i%4===3?1:0);
      results["tonemap-"+operator+(graded?"-lut":"")]={...imageMetrics(expected,actual,width,height),control:imageMetrics(expected,control,width,height).ssim};
    }
    r.setPostFx([{kind:"taa",id:"aa",jitter:false},{kind:"tonemap",operator:"aces"}]);r.render();r.render();
    const tp=new ArrayBuffer(32),tf=new Float32Array(tp);tf.set([width,height,0,0,.9,1.25,100]);
    const nativeTaa=await dispatch(await source("src/shaders/taa.wgsl"),"taa_resolve",[[0,input],[1,input],[2,texture(new Float32Array(width*height*4))],[3,nativeDepth],[4,sampler],[5,buffer(new Uint8Array(tp))],[6,"output"]]);
    const taaExpected=await read(nativeTaa),taaActual=await r.readPostFxIntermediate("aa:resolve");
    results.taa={...imageMetrics(taaExpected,taaActual.data,width,height),control:imageMetrics(taaExpected,new Float32Array(taaExpected.length),width,height).ssim};
    r.setPostFx([{kind:"denoise",id:"noise",iterations:1,sigmaDepth:.000001},{kind:"tonemap",operator:"aces"}]);r.render();
    const dp=new Float32Array([width,height,1,.2,.2,.000001,0,0]);
    const denoiseCode=(await source("src/shaders/denoise_atrous.wgsl")).replace("texture_depth_2d","texture_2d<f32>").replace("textureLoad(depth_tex, coords, 0);","textureLoad(depth_tex, coords, 0).r;").replace("textureLoad(depth_tex, sample_coords, 0);","textureLoad(depth_tex, sample_coords, 0).r;");
    const nativeDenoise=await dispatch(denoiseCode,"main",[[0,input],[1,"output"],[2,texture(depth.data,"r32float")],[3,buffer(dp)]]);
    const denoiseExpected=await read(nativeDenoise),denoiseActual=await r.readPostFxIntermediate("noise:atrous-0");
    results.denoise={...imageMetrics(denoiseExpected,denoiseActual.data,width,height),control:imageMetrics(denoiseExpected,new Float32Array(denoiseExpected.length),width,height).ssim};
    const ibl = await api.ImageBasedLighting.fromLinear({width:4,height:2,data:Float32Array.from({length:32},(_,i)=>[.12,.24,.36,1][i%4])},{quality:"low"});
    const readyIbl=await ibl.prepare(r),iblSnapshot=readyIbl.snapshot(),prepared=iblSnapshot.prepared;
    // Exercise SSR against known directional texels and distinct mip radiance.
    // Convolution is covered by W04/W10; its device-specific output must not
    // determine the independent fallback shader's input pattern.
    prepared.specular=referenceSpecularCube(prepared.specularSize,prepared.specularMipCount);r.setIbl(iblSnapshot);
    function cube(bytes,size,levels=1){
      const t=device.createTexture({size:[size,size,6],mipLevelCount:levels,format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(t);
      let offset=0;for(let mip=0;mip<levels;mip++){const dim=Math.max(1,size>>mip),length=dim*dim*6*8;device.queue.writeTexture({texture:t,mipLevel:mip},bytes.subarray(offset,offset+length),{bytesPerRow:dim*8,rowsPerImage:dim},[dim,dim,6]);offset+=length;}
      return t.createView({dimension:"cube"});
    }
    const diffuse=cube(prepared.irradiance,prepared.irradianceSize),specular=cube(prepared.specular,prepared.specularSize,prepared.specularMipCount);
    const ssrInputs=nativeSsrInputs(packed,normal.data,projection,matrices);
    const ssrNormal=texture(ssrInputs.normal,"rgba32float"),ssrCamera=buffer(ssrInputs.camera);
    const hit=texture(new Float32Array(width*height*4)),empty=texture(new Float32Array(width*height*4));
    const rgbOnly = data => data.filter((_,i)=>i%4!==3);
    for(const kind of ["ssgi","ssr"]){
      r.setPostFx([{kind,id:kind,maxDistance:.001,thickness:.001,intensity:1,steps:4,samples:1,bilateralRadius:0,temporalWeight:0}]);r.render();
      const alb=texture((await r.readPostFxIntermediate("albedo")).data);
      let output,roughnessControl;
      if(kind==="ssgi"){
        const p=new ArrayBuffer(160),f=new Float32Array(p),u=new Uint32Array(p);f[0]=.001;f[1]=1;u[2]=4;f[4]=1/width;f[5]=1/height;
        output=await dispatch(await source("src/shaders/ssgi/shade.wgsl"),"cs_shade",[[0,input],[1,sampler],[2,diffuse],[3,sampler],[4,hit],[5,"output"],[6,buffer(new Uint8Array(p))],[7,cam],[8,nativeNormal],[9,alb]]);
      }else{
        const p=new ArrayBuffer(32),f=new Float32Array(p),u=new Uint32Array(p);u[0]=4;f[1]=.001;f[2]=.001;f[3]=1;f[4]=1/width;f[5]=1/height;
        const counters=device.createBuffer({size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});resources.push(counters);
        output=await dispatch(await source("src/shaders/ssr/fallback_env.wgsl"),"cs_fallback",[[0,empty],[1,hit],[2,nativeDepth],[3,ssrNormal],[4,specular],[5,sampler],[6,"output"],[7,buffer(new Uint8Array(p))],[8,ssrCamera],[9,counters]]);
        const wrong=await dispatch(await source("src/shaders/ssr/fallback_env.wgsl"),"cs_fallback",[[0,empty],[1,hit],[2,nativeDepth],[3,nativeNormal],[4,specular],[5,sampler],[6,"output"],[7,buffer(new Uint8Array(p))],[8,ssrCamera],[9,counters]]);
        roughnessControl=rgbOnly(await read(wrong));
      }
      const expected=rgbOnly(await read(output)),actual=rgbOnly((await r.readPostFxIntermediate(kind+":trace")).data);
      for(let i=0;i<width*height;i++)if(depth.data[i]>=.999){expected.fill(0,i*3,i*3+3);actual.fill(0,i*3,i*3+3);}
      results[kind+"-ibl-fallback"]={...imageMetrics(expected,actual,width,height,3),control:imageMetrics(expected,new Float32Array(expected.length),width,height,3).ssim};
      if(kind==="ssr"){
        for(let i=0;i<width*height;i++)if(depth.data[i]>=.999)roughnessControl.fill(0,i*3,i*3+3);
        results["ssr-ibl-fallback"].roughnessControl=imageMetrics(expected,roughnessControl,width,height,3).ssim;
        const composed=await r.readPostFxIntermediate("ssr:composite"),base=await r.readPostFxIntermediate("color");
        results.ssrMissCompositeDelta=imageMetrics(base.data,composed.data,width,height).mae;
      }
    }
    if (errors.length) throw Error(errors.join("\n")); return results;
  } finally { resources.forEach(r => r.destroy()); device.destroy(); }
}
