export interface AdapterAttestationBinding {
  runId: number;
  jobId: number;
  assetId: string;
  commit: string;
  packageSha256: string;
}

export interface AdapterAttestationRecord extends AdapterAttestationBinding {
  schemaVersion: 1;
  navigatorGpu: boolean;
  adapterInfoAvailable: boolean;
  adapterInfo: Record<string, string | number | boolean>;
  isFallbackAdapter: boolean | null;
  deviceAdapterInfo: Record<string, string | number | boolean> | null;
  limits: Record<string, number>;
  deviceCreated: boolean;
  surfaceCreated: boolean;
  surfacePresented: boolean;
  presentedFrameLuma: number;
  lumaChanged: boolean;
  effectiveLaunchArguments: string[];
}

export async function captureAdapterAttestation(
  canvas: HTMLCanvasElement,
  binding: AdapterAttestationBinding,
  effectiveLaunchArguments: string[],
): Promise<AdapterAttestationRecord> {
  const gpu = navigator.gpu;
  if (!gpu) {
    return unavailableRecord(binding, effectiveLaunchArguments);
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    return unavailableRecord(binding, effectiveLaunchArguments, true);
  }

  const rawInfo = (
    adapter as GPUAdapter & {
      info?: Record<string, string | number | boolean>;
    }
  ).info;
  const adapterInfoAvailable = rawInfo !== undefined && rawInfo !== null;
  const isFallbackAdapter =
    adapterInfoAvailable && typeof rawInfo.isFallbackAdapter === "boolean"
      ? rawInfo.isFallbackAdapter
      : null;
  const device = await adapter.requestDevice();
  const deviceAdapterInfo =
    (
      device as GPUDevice & {
        adapterInfo?: Record<string, string | number | boolean>;
      }
    ).adapterInfo ?? null;
  const limits = Object.fromEntries(
    [
      "maxTextureDimension1D",
      "maxTextureDimension2D",
      "maxTextureDimension3D",
      "maxBufferSize",
      "maxStorageBufferBindingSize",
      "maxUniformBufferBindingSize",
      "maxBindGroups",
    ].map((name) => [
      name,
      Number((adapter.limits as unknown as Record<string, number>)[name] ?? 0),
    ]),
  );

  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    device.destroy();
    throw new Error("SURFACE_CREATE_FAILED: canvas WebGPU context is unavailable");
  }
  canvas.width = 2;
  canvas.height = 2;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    usage: 0x10 | 0x01,
    alphaMode: "opaque",
  });
  const bytesPerRow = 256;
  const readback = device.createBuffer({
    size: bytesPerRow * canvas.height,
    usage: 0x0008 | 0x0001,
  });
  try {
    const texture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0.75, g: 0.25, b: 0.5, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow },
      { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(0x0001);
    const pixel = new Uint8Array(readback.getMappedRange(), 0, 4);
    const presentedFrameLuma =
      (0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]) / 255;
    readback.unmap();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return {
      schemaVersion: 1,
      ...binding,
      navigatorGpu: true,
      adapterInfoAvailable,
      adapterInfo: sanitizeInfo(rawInfo),
      isFallbackAdapter,
      deviceAdapterInfo: deviceAdapterInfo
        ? sanitizeInfo(deviceAdapterInfo)
        : null,
      limits,
      deviceCreated: true,
      surfaceCreated: true,
      surfacePresented: true,
      presentedFrameLuma,
      lumaChanged: presentedFrameLuma > 0.05,
      effectiveLaunchArguments: [...effectiveLaunchArguments],
    };
  } finally {
    readback.destroy();
    context.unconfigure();
    device.destroy();
  }
}

function unavailableRecord(
  binding: AdapterAttestationBinding,
  effectiveLaunchArguments: string[],
  navigatorGpu = false,
): AdapterAttestationRecord {
  return {
    schemaVersion: 1,
    ...binding,
    navigatorGpu,
    adapterInfoAvailable: false,
    adapterInfo: {},
    isFallbackAdapter: null,
    deviceAdapterInfo: null,
    limits: {},
    deviceCreated: false,
    surfaceCreated: false,
    surfacePresented: false,
    presentedFrameLuma: 0,
    lumaChanged: false,
    effectiveLaunchArguments: [...effectiveLaunchArguments],
  };
}

function sanitizeInfo(
  info: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!info) {
    return {};
  }
  const result: Record<string, string | number | boolean> = {};
  for (const key of [
    "vendor",
    "architecture",
    "device",
    "description",
    "subgroupMinSize",
    "subgroupMaxSize",
    "isFallbackAdapter",
  ]) {
    const value = info[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}
