// Test instrumentation measures allocations independently of the tracer ledger.
export function trackGpuBuffers(device) {
  const original = Object.getOwnPropertyDescriptor(device, "createBuffer"),
    create = device.createBuffer.bind(device);
  const live = new Map();
  let created = 0,
    destroyed = 0,
    peakBytes = 0;
  Object.defineProperty(device, "createBuffer", {
    configurable: true,
    value(descriptor) {
      const buffer = create(descriptor),
        destroy = buffer.destroy.bind(buffer);
      live.set(buffer, descriptor.size);
      created++;
      peakBytes = Math.max(
        peakBytes,
        [...live.values()].reduce((a, b) => a + b, 0),
      );
      Object.defineProperty(buffer, "destroy", {
        configurable: true,
        value() {
          if (live.delete(buffer)) destroyed++;
          destroy();
        },
      });
      return buffer;
    },
  });
  return {
    get count() {
      return live.size;
    },
    get bytes() {
      return [...live.values()].reduce((a, b) => a + b, 0);
    },
    get created() {
      return created;
    },
    get destroyed() {
      return destroyed;
    },
    get peakBytes() {
      return peakBytes;
    },
    restore() {
      if (original) Object.defineProperty(device, "createBuffer", original);
      else delete device.createBuffer;
    },
  };
}
