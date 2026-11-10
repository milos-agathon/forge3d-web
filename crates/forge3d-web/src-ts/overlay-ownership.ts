// Overlay image bytes the SDK copied itself. Nothing mutates them after the
// copy, so a later normalization pass (viewer -> runtime, or a runtime
// recommit) can share them instead of copying 16 MiB per 2048² layer again.
const owned = new WeakSet<Uint8Array>();

/** `data` itself when the SDK already owns it, otherwise an owned copy. */
export function ownedOverlayData(data: Uint8Array): Uint8Array {
  if (owned.has(data)) {
    return data;
  }
  const copy = data.slice();
  owned.add(copy);
  return copy;
}
