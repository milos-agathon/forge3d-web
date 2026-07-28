export type RuntimeDeviceLostHandler = (error: unknown) => void;

interface RuntimeInternalAccess {
  setDeviceLostHandler(handler: RuntimeDeviceLostHandler | undefined): void;
  simulateDeviceLossForTests(): void;
}

const runtimeInternals = new WeakMap<object, RuntimeInternalAccess>();

export function registerRuntimeInternals(
  runtime: object,
  access: RuntimeInternalAccess,
): void {
  runtimeInternals.set(runtime, access);
}

export function setRuntimeDeviceLostHandler(
  runtime: object,
  handler: RuntimeDeviceLostHandler | undefined,
): void {
  requiredRuntimeInternals(runtime).setDeviceLostHandler(handler);
}

export function simulateRuntimeDeviceLossForTests(runtime: object): void {
  requiredRuntimeInternals(runtime).simulateDeviceLossForTests();
}

function requiredRuntimeInternals(runtime: object): RuntimeInternalAccess {
  const access = runtimeInternals.get(runtime);
  if (access === undefined) {
    throw new Error("Forge3D runtime internals are unavailable");
  }
  return access;
}
