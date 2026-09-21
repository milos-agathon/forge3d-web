import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import { BorrowedWasmView } from "../../src-ts/ownership.js";

function expectCode(factory: () => unknown, code: string): void {
  try {
    factory();
  } catch (error) {
    expect(error).toBeInstanceOf(Forge3DError);
    expect((error as Forge3DError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("BorrowedWasmView", () => {
  it("validates descriptor dtype, shape, and resolved length", () => {
    const backing = new Float32Array(4);
    const view = new BorrowedWasmView(() => backing, {
      dtype: "f32",
      shape: [2, 2],
    });
    expect(view.view()).toBe(backing);
    expect(view.generation).toBe(0);
    expect(view.disposed).toBe(false);

    expectCode(
      () =>
        new BorrowedWasmView(() => new Uint8Array(4), {
          dtype: "f32",
          shape: [4],
        }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new BorrowedWasmView(() => new Float32Array(3), {
          dtype: "f32",
          shape: [2, 2],
        }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new BorrowedWasmView(() => new Float32Array(4), {
          dtype: "f32",
          shape: [0, 4],
        }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new BorrowedWasmView(() => new Float32Array(4), {
          dtype: "f32",
          shape: [1.5],
        }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new BorrowedWasmView(() => new Float32Array(4), {
          dtype: "f32",
          shape: [],
        }),
      "INVALID_INPUT",
    );
    expectCode(
      () =>
        new BorrowedWasmView(() => new Float32Array(4), {
          dtype: "x9" as never,
          shape: [4],
        }),
      "INVALID_INPUT",
    );
  });

  it("tracks memory regrowth through generation increments", () => {
    let memory = new ArrayBuffer(16);
    let view = new Float32Array(memory);
    const borrowed = new BorrowedWasmView(() => view, {
      dtype: "f32",
      shape: [4],
    });

    expect(borrowed.view().buffer).toBe(memory);
    expect(borrowed.generation).toBe(0);
    borrowed.view();
    expect(borrowed.generation).toBe(0);

    const grown = new ArrayBuffer(16);
    new Uint8Array(grown).set(new Uint8Array(memory));
    memory = grown;
    view = new Float32Array(memory);
    view[0] = 7;

    const next = borrowed.view();
    expect(next.buffer).toBe(memory);
    expect(borrowed.generation).toBe(1);
    expect(next[0]).toBe(7);
    borrowed.view();
    expect(borrowed.generation).toBe(1);
  });

  it("copies only the view range into owned arrays", () => {
    const buffer = new ArrayBuffer(32);
    const backing = new Float32Array(buffer, 8, 4);
    backing.set([1, 2, 3, 4]);
    const view = new BorrowedWasmView(() => backing, {
      dtype: "f32",
      shape: [2, 2],
    });

    const copied = view.copy();
    expect(Array.from(copied)).toEqual([1, 2, 3, 4]);
    expect(copied.buffer).not.toBe(buffer);
    expect(copied.byteOffset).toBe(0);
    copied[0] = 99;
    expect(backing[0]).toBe(1);
  });

  it("transfer exposes a new owned buffer without detaching wasm memory", () => {
    const memory = new ArrayBuffer(16);
    const backing = new Float32Array(memory);
    backing.set([5, 6, 7, 8]);
    const view = new BorrowedWasmView(() => backing, {
      dtype: "f32",
      shape: [4],
    });

    const { value, transfer } = view.transfer();
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(value.buffer);
    expect(transfer[0]).not.toBe(memory);
    expect(Array.from(value)).toEqual([5, 6, 7, 8]);
    expect(backing.buffer).toBe(memory);
    expect(backing[0]).toBe(5);
    expect(view.view()[0]).toBe(5);
  });

  it("returns frozen defensive descriptors", () => {
    const shape = [2, 2];
    const view = new BorrowedWasmView(() => new Float32Array(4), {
      dtype: "f32",
      shape,
    });
    shape[0] = 99;
    const descriptor = view.descriptor;
    expect(descriptor.shape).toEqual([2, 2]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.shape)).toBe(true);
    expect(view.descriptor).not.toBe(descriptor);
    expect(view.descriptor.shape).toEqual([2, 2]);
  });

  it("throws RUNTIME_DISPOSED after dispose except retained getters", () => {
    const view = new BorrowedWasmView(() => new Float32Array(4), {
      dtype: "f32",
      shape: [4],
    });
    view.dispose();
    view.dispose();
    expect(view.disposed).toBe(true);
    expect(view.descriptor.dtype).toBe("f32");
    expect(view.generation).toBe(0);
    expectCode(() => view.view(), "RUNTIME_DISPOSED");
    expectCode(() => view.copy(), "RUNTIME_DISPOSED");
    expectCode(() => view.transfer(), "RUNTIME_DISPOSED");
  });
});
