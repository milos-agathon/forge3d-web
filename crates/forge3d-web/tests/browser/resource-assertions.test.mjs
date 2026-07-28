import assert from "node:assert/strict";
import test from "node:test";

import { assertViewerResourcesReleased } from "./resource-assertions.mjs";

const released = {
  ownedListeners: 0,
  activeObservers: 0,
  activeRuntimes: 0,
  pendingAnimationFrame: false,
  activePointers: 0,
};

test("accepts a fully released viewer", () => {
  assert.doesNotThrow(() => assertViewerResourcesReleased(released));
});

for (const [name, value] of [
  ["ownedListeners", 1],
  ["activeObservers", 1],
  ["activeRuntimes", 1],
  ["pendingAnimationFrame", true],
  ["activePointers", 1],
]) {
  test(`negative control detects leaked ${name}`, () => {
    assert.throws(
      () => assertViewerResourcesReleased({ ...released, [name]: value }),
      /leaked/,
    );
  });
}
