/** Enumerates owned graph buffers once, including shared views and cycles. */
export function collectTransfer(value: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item instanceof ArrayBuffer) buffers.add(item);
    else if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) buffers.add(item.buffer);
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      if (item instanceof Map) { for(const [key,value] of item){visit(key);visit(value);} }
      else if(item instanceof Set)item.forEach(visit);
      else if (Array.isArray(item)) item.forEach(visit);
      else if (Object.getPrototypeOf(item) === Object.prototype) Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return [...buffers];
}
