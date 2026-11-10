// Overlay bytes are copied once at the API boundary; the viewer -> runtime
// hop shares that copy instead of cloning every 2048² layer a second time.

import { describe, expect, it } from "vitest";

import { ownedOverlayData } from "../../src-ts/overlay-ownership.js";

describe("ownedOverlayData", () => {
  it("copies caller bytes, so later caller writes cannot reach the SDK", () => {
    const caller = new Uint8Array([1, 2, 3, 4]);
    const owned = ownedOverlayData(caller);
    expect(owned).not.toBe(caller);
    caller[0] = 99;
    expect([...owned]).toEqual([1, 2, 3, 4]);
  });

  it("shares a copy the SDK already made instead of copying it again", () => {
    const owned = ownedOverlayData(new Uint8Array([5, 6, 7, 8]));
    expect(ownedOverlayData(owned)).toBe(owned);
  });

  it("copies a view of an owned buffer (only the owned array itself is shared)", () => {
    const owned = ownedOverlayData(new Uint8Array(8));
    const view = new Uint8Array(owned.buffer, 4, 4);
    expect(ownedOverlayData(view)).not.toBe(view);
  });
});
