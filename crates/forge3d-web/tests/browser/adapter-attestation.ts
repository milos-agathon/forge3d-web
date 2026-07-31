export interface AdapterAttestationBinding {
  runId: number;
  jobId: number;
  assetId: string;
  commit: string;
  packageSha256: string;
}

export interface AdapterAttestationRecord extends AdapterAttestationBinding {
  schemaVersion: 1;
  secureContext: boolean;
  navigatorGpu: boolean;
  adapterInfoAvailable: boolean;
  adapterInfo: Record<string, string | number | boolean>;
  isFallbackAdapter: boolean | null;
  deviceAdapterInfo: Record<string, string | number | boolean> | null;
  limits: Record<string, number>;
  deviceCreated: boolean;
  surfaceCreated: boolean;
  surfacePresented: boolean;
  presentedFrameLumaSamples: [number, number];
  presentedFrameLumaDelta: number;
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
      isFallbackAdapter?: boolean;
    }
  ).info;
  const adapterInfoAvailable = rawInfo !== undefined && rawInfo !== null;
  const directFallback = (
    adapter as GPUAdapter & { isFallbackAdapter?: boolean }
  ).isFallbackAdapter;
  const isFallbackAdapter =
    typeof directFallback === "boolean"
      ? directFallback
      : adapterInfoAvailable && typeof rawInfo.isFallbackAdapter === "boolean"
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
    const presentedFrameLumaSamples: [number, number] = [
      await presentAndReadLuma({
        canvas,
        context,
        device,
        readback,
        bytesPerRow,
        clearValue: 0.05,
      }),
      await presentAndReadLuma({
        canvas,
        context,
        device,
        readback,
        bytesPerRow,
        clearValue: 0.9,
      }),
    ];
    const presentedFrameLumaDelta = Math.abs(
      presentedFrameLumaSamples[1] - presentedFrameLumaSamples[0],
    );
    return {
      schemaVersion: 1,
      ...binding,
      secureContext: globalThis.isSecureContext === true,
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
      presentedFrameLumaSamples,
      presentedFrameLumaDelta,
      lumaChanged: presentedFrameLumaDelta >= 0.25,
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
    secureContext: globalThis.isSecureContext === true,
    navigatorGpu,
    adapterInfoAvailable: false,
    adapterInfo: {},
    isFallbackAdapter: null,
    deviceAdapterInfo: null,
    limits: {},
    deviceCreated: false,
    surfaceCreated: false,
    surfacePresented: false,
    presentedFrameLumaSamples: [0, 0],
    presentedFrameLumaDelta: 0,
    lumaChanged: false,
    effectiveLaunchArguments: [...effectiveLaunchArguments],
  };
}

async function presentAndReadLuma({
  canvas,
  context,
  device,
  readback,
  bytesPerRow,
  clearValue,
}: {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  device: GPUDevice;
  readback: GPUBuffer;
  bytesPerRow: number;
  clearValue: number;
}): Promise<number> {
  const texture = context.getCurrentTexture();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        clearValue: {
          r: clearValue,
          g: clearValue,
          b: clearValue,
          a: 1,
        },
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
  const luma =
    (0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]) / 255;
  readback.unmap();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return luma;
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
