// Execute pinned native WGSL arithmetic independently of the runtime compositor.
function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`native function missing: ${name}`);
  let index = source.indexOf("{", start),
    depth = 1;
  while (depth && ++index < source.length) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
  }
  return source.slice(start, index + 1);
}
async function probe(device, source, expression, uniform) {
  const width = 128,
    height = 64,
    size = width * height * 16;
  source += `
@group(3) @binding(0) var<storage,read_write> output:array<vec4<f32>>;
@compute @workgroup_size(8,8) fn qualification(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=128u||id.y>=64u){return;}
 let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(128.,64.);
 let dir=normalize(vec3<f32>(uv.x*2.-1.,uv.y,1.));
 let density=0.1+uv.x*0.8;
 output[id.y*128u+id.x]=${expression};
}`;
  const shader = device.createShaderModule({ code: source });
  const info = await shader.getCompilationInfo();
  const errors = info.messages.filter((x) => x.type === "error");
  if (errors.length) throw new Error(errors.map((x) => x.message).join("\n"));
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: shader, entryPoint: "qualification" },
  });
  const result = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const read = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const config = device.createBuffer({
    size: uniform.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(config, 0, uniform);
  const groups = [];
  for (let group = 0; group < 4; group++)
    groups.push(
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(group),
        entries:
          group === 0
            ? [{ binding: 0, resource: { buffer: config } }]
            : group === 3
              ? [{ binding: 0, resource: { buffer: result } }]
              : [],
      }),
    );
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  groups.forEach((g, i) => pass.setBindGroup(i, g));
  pass.dispatchWorkgroups(16, 8);
  pass.end();
  encoder.copyBufferToBuffer(result, 0, read, 0, size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const values = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  [result, read, config].forEach((b) => b.destroy());
  return values;
}
export async function nativeProbes(api) {
  const [sky, water, cloud, portedSky, portedEffects] = await Promise.all([
    ...["sky", "water_surface", "clouds"].map((name) =>
      fetch(`/tests/golden/w10/${name}.json`).then((r) => r.json()),
    ),
    fetch("/w10-runtime-sky.wgsl").then((r) =>
      r.ok
        ? r.text()
        : fetch("../src/runtime/environment/sky.wgsl").then((r) => r.text()),
    ),
    fetch("/w10-runtime-effects.wgsl").then((r) =>
      r.ok
        ? r.text()
        : fetch("../src/runtime/environment/effects.wgsl").then((r) =>
            r.text(),
          ),
    ),
  ]);
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  try {
    const cases = [];
    for (const model of [0, 1])
      for (const turbidity of [2, 8]) {
        const p = new Float32Array(128);
        p.set([0.3, 0.7, 0.2, 1], 52);
        const len = Math.hypot(0.3, 0.7, 0.2);
        for (let j = 0; j < 3; j++) p[52 + j] /= len;
        p.set([turbidity, 0.2, 0.00465, 1], 60);
        p[86] = model;
        const n = new Float32Array(12);
        n.set(p.subarray(52, 56));
        n[3] = turbidity;
        n.set([0.2, 0.00465, 1, 1], 4);
        new Uint32Array(n.buffer)[8] = model;
        const refSource =
          sky.source.slice(0, sky.source.indexOf("@group")) +
          "\n@group(0) @binding(0) var<uniform> params:SkyParams;";
        const native = await probe(
          device,
          refSource,
          "vec4<f32>(eval_sky(dir,params),1.)",
          n,
        );
        const actual = await probe(
          device,
          portedSky + portedEffects,
          "vec4<f32>(sky_color(dir),1.)",
          p,
        );
        const metrics = await api.compareImages(actual, native, {
          width: 128,
          height: 64,
          channels: 4,
          compareChannels: 3,
        });
        const control = await api.compareImages(
          new Float32Array(actual.length),
          native,
          { width: 128, height: 64, channels: 4, compareChannels: 3 },
        );
        cases.push({
          name: `sky-${model}-${turbidity}`,
          ...metrics,
          controlSsim: control.ssim,
        });
      }
    const env = new Float32Array(128);
    const len = Math.hypot(0.3, 0.7, 0.2);
    env.set([0.3 / len, 0.7 / len, 0.2 / len, 1], 52);
    env.set([0.5, 0.8, 0.3, 0.4], 80);
    env.set([0.6, 0.8, 1, 1.2], 116);
    const cloudStruct = cloud.source.slice(0, cloud.source.indexOf("@group"));
    let scattering = functionSource(cloud.source, "evaluate_scattering");
    scattering = scattering.replace(
      "normal: vec3<f32>)",
      "normal: vec3<f32>, irradiance: vec3<f32>, reflection: vec3<f32>)",
    );
    scattering = scattering
      .replace(/    let irradiance = [^;]+;\n/, "")
      .replace(/    let reflection = [^;]+;\n/, "");
    const cloudSource =
      cloudStruct +
      "\n@group(0) @binding(0) var<uniform> cloud_uniforms:CloudUniforms;" +
      functionSource(cloud.source, "henyey_greenstein_phase") +
      scattering;
    const nativeUniform = new Float32Array(44);
    nativeUniform.set([0.6, 0.8, 1, 1], 20);
    nativeUniform.set(env.subarray(52, 56), 24);
    nativeUniform.set([1.2, 0.8, 0.3, 0.4], 36);
    const nativeCloud = await probe(
      device,
      cloudSource,
      "vec4<f32>(evaluate_scattering(density,dir,vec3<f32>(0.,1.,0.),vec3<f32>(.6,.7,.8),vec3<f32>(.8,.82,.86)),1.)",
      nativeUniform,
    );
    const cloudActual = await probe(
      device,
      portedSky + portedEffects,
      "vec4<f32>(cloud_scattering(density,dir,vec3<f32>(.6,.7,.8),vec3<f32>(.8,.82,.86),1.),1.)",
      env,
    );
    const cm = await api.compareImages(cloudActual, nativeCloud, {
      width: 128,
      height: 64,
      channels: 4,
      compareChannels: 3,
    });
    const cc = await api.compareImages(
      new Float32Array(cloudActual.length),
      nativeCloud,
      { width: 128, height: 64, channels: 4, compareChannels: 3 },
    );
    cases.push({ name: "cloud-scattering", ...cm, controlSsim: cc.ssim });
    // The native water cross product points down. Orient its reference upward.
    const waterSource =
      functionSource(water.source, "simple_wave") +
      functionSource(water.source, "water_normal") +
      "\n@group(0) @binding(0) var<uniform> params:vec4<f32>;";
    const wp = new Float32Array([0.05, 3, 0.5, 2]);
    const nativeWater = await probe(
      device,
      waterSource,
      "vec4<f32>(-water_normal(uv*8.,params.w,params.x,params.y,params.z)*.5+.5,.5+simple_wave(uv*8.,params.w,params.x,params.y,params.z)*2.)",
      wp,
    );
    // Use env values so the auto layout retains the uniform for both probes.
    env.set(wp, 48);
    const webWater = await probe(
      device,
      portedSky + portedEffects,
      "vec4<f32>(wave_normal(uv*8.,env.p[0].w,env.p[0].x,env.p[0].y,env.p[0].z)*.5+.5,.5+simple_wave(uv*8.,env.p[0].w,env.p[0].x,env.p[0].y,env.p[0].z)*2.)",
      env,
    );
    const wm = await api.compareImages(webWater, nativeWater, {
      width: 128,
      height: 64,
      channels: 4,
      compareChannels: 4,
    });
    const wc = await api.compareImages(
      new Float32Array(webWater.length),
      nativeWater,
      { width: 128, height: 64, channels: 4, compareChannels: 4 },
    );
    cases.push({ name: "water-waves", ...wm, controlSsim: wc.ssim });
    return cases;
  } finally {
    device.destroy();
  }
}
