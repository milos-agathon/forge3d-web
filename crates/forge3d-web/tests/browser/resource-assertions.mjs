const COUNTERS = [
  "ownedListeners",
  "activeObservers",
  "activeRuntimes",
];

export function assertViewerResourcesReleased(diagnostics) {
  for (const counter of COUNTERS) {
    if (diagnostics[counter] !== 0) {
      throw new Error(`${counter} leaked: expected 0, got ${diagnostics[counter]}`);
    }
  }
  if (diagnostics.pendingAnimationFrame) {
    throw new Error("pendingAnimationFrame leaked");
  }
  if (diagnostics.activePointers !== 0) {
    throw new Error(`activePointers leaked: ${diagnostics.activePointers}`);
  }
}
