import { Forge3DError } from "./index.js";
import type {
  Forge3DDType,
  Forge3DTypedArray,
  TypedArrayShape,
  TransferableTypedArray,
} from "./index.js";

const DTYPE_CONSTRUCTORS: Record<
  Forge3DDType,
  new (length: number) => Forge3DTypedArray
> = {
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

export class BorrowedWasmView<T extends Forge3DTypedArray> {
  readonly #resolve: () => T;
  readonly #descriptor: TypedArrayShape;
  #buffer: ArrayBufferLike;
  #generation = 0;
  #disposed = false;

  constructor(resolve: () => T, descriptor: TypedArrayShape) {
    if (typeof resolve !== "function") {
      throw new Forge3DError(
        "INVALID_INPUT",
        "resolve must be a function",
      );
    }
    this.#descriptor = validateDescriptor(descriptor);
    const initial = this.#checkedResolve(resolve);
    this.#resolve = resolve;
    this.#buffer = initial.buffer;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get generation(): number {
    return this.#generation;
  }

  get descriptor(): TypedArrayShape {
    return Object.freeze({
      dtype: this.#descriptor.dtype,
      shape: Object.freeze([...this.#descriptor.shape]),
    });
  }

  view(): T {
    this.#assertLive();
    const value = this.#checkedResolve(this.#resolve);
    if (value.buffer !== this.#buffer) {
      this.#buffer = value.buffer;
      this.#generation += 1;
    }
    return value;
  }

  copy(): T {
    const value = this.view();
    return value.slice() as T;
  }

  transfer(): TransferableTypedArray<T> {
    const value = this.copy();
    return { value, transfer: [value.buffer as ArrayBuffer] };
  }

  dispose(): void {
    this.#disposed = true;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Forge3DError("RUNTIME_DISPOSED", "View is disposed");
    }
  }

  #checkedResolve(resolve: () => T): T {
    const value = resolve();
    if (!ArrayBuffer.isView(value) || value instanceof DataView) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "resolve must return a typed array",
      );
    }
    const expected = DTYPE_CONSTRUCTORS[this.#descriptor.dtype];
    if (!(value instanceof expected)) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `resolved view dtype does not match ${this.#descriptor.dtype}`,
      );
    }
    if (value.length !== this.#elementCount) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `resolved view length ${value.length} does not match shape product ${this.#elementCount}`,
      );
    }
    return value;
  }

  get #elementCount(): number {
    let product = 1;
    for (const dimension of this.#descriptor.shape) {
      product *= dimension;
    }
    return product;
  }
}

function validateDescriptor(descriptor: TypedArrayShape): TypedArrayShape {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "descriptor must be an object",
    );
  }
  if (!(descriptor.dtype in DTYPE_CONSTRUCTORS)) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `unknown dtype ${String(descriptor.dtype)}`,
    );
  }
  const shape = descriptor.shape;
  if (!Array.isArray(shape) || shape.length === 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "shape must be a nonempty array of positive safe integers",
    );
  }
  let product = 1;
  for (const dimension of shape) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "shape dimensions must be positive safe integers",
      );
    }
    product *= dimension;
    if (!Number.isSafeInteger(product)) {
      throw new Forge3DError(
        "RESOURCE_LIMIT_EXCEEDED",
        "shape product exceeds safe integer limits",
      );
    }
  }
  return {
    dtype: descriptor.dtype,
    shape: Object.freeze([...shape]),
  };
}
