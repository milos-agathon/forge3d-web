import { Forge3DError } from "./index.js";
import type {
  CustomNodeInput,
  GroundPlaneNodeInput,
  OverlayNodeInput,
  SceneNodeId,
  SceneNodeInput,
  SceneNodeSnapshot,
  ScenePassInput,
  SceneRenderPlan,
  SceneSnapshot,
  SceneTransform,
  TerrainHeightmapInput,
  TerrainNodeInput,
  TextMeshNodeInput,
} from "./index.js";
import { compileScenePasses } from "./render-graph.js";

const IMPLICIT_PASS_KINDS = [
  "terrain",
  "ground-plane",
  "text-mesh",
  "overlay",
] as const;

const IDENTITY_TRANSFORM: SceneTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

interface StoredNode {
  id: SceneNodeId;
  parent: SceneNodeId | null;
  children: SceneNodeId[];
  node: SceneNodeInput;
  transform: SceneTransform;
  visible: boolean;
}

export class Forge3DScene {
  readonly #nodes = new Map<SceneNodeId, StoredNode>();
  readonly #roots: SceneNodeId[] = [];
  readonly #passes: ScenePassInput[] = [];
  #nextId = 0;
  #revision = 0;
  #disposed = false;

  private constructor() {}

  static create(): Forge3DScene {
    return new Forge3DScene();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get revision(): number {
    return this.#revision;
  }

  addNode(node: SceneNodeInput, parent?: SceneNodeId): SceneNodeId {
    this.#assertOperational();
    const stored = normalizeNodeInput(node);
    let parentNode: StoredNode | undefined;
    if (parent !== undefined) {
      parentNode = this.#nodes.get(parent);
      if (parentNode === undefined) {
        throw invalid("parent does not exist");
      }
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const entry: StoredNode = { ...stored, id, parent: parent ?? null };
    if (parentNode !== undefined) {
      parentNode.children.push(id);
    } else {
      this.#roots.push(id);
    }
    this.#nodes.set(id, entry);
    this.#revision += 1;
    return id;
  }

  addTerrain(
    terrain: TerrainHeightmapInput,
    options?: Omit<TerrainNodeInput, "kind" | "terrain">,
  ): SceneNodeId {
    return this.addNode({
      name: "terrain",
      ...(options ?? {}),
      kind: "terrain",
      terrain,
    });
  }

  addGroundPlane(input: Omit<GroundPlaneNodeInput, "kind">): SceneNodeId {
    return this.addNode({ ...input, kind: "ground-plane" });
  }

  addTextMesh(input: Omit<TextMeshNodeInput, "kind">): SceneNodeId {
    return this.addNode({ ...input, kind: "text-mesh" });
  }

  addOverlay(input: Omit<OverlayNodeInput, "kind">): SceneNodeId {
    return this.addNode({ ...input, kind: "overlay" });
  }

  setParent(child: SceneNodeId, parent?: SceneNodeId): void {
    this.#assertOperational();
    const childNode = this.#nodes.get(child);
    if (childNode === undefined) {
      throw invalid("child does not exist");
    }
    const nextParent = parent ?? null;
    if (nextParent !== null) {
      if (nextParent === child) {
        throw invalid("node cannot parent itself");
      }
      const parentNode = this.#nodes.get(nextParent);
      if (parentNode === undefined) {
        throw invalid("parent does not exist");
      }
      let cursor: SceneNodeId | null = nextParent;
      while (cursor !== null) {
        if (cursor === child) {
          throw invalid("reparenting would create an ancestor cycle");
        }
        cursor = this.#nodes.get(cursor)?.parent ?? null;
      }
    }
    if (childNode.parent === nextParent) {
      return;
    }
    if (childNode.parent !== null) {
      const oldParent = this.#nodes.get(childNode.parent);
      if (oldParent !== undefined) {
        oldParent.children = oldParent.children.filter((id) => id !== child);
      }
    } else {
      const index = this.#roots.indexOf(child);
      if (index >= 0) {
        this.#roots.splice(index, 1);
      }
    }
    childNode.parent = nextParent;
    if (nextParent !== null) {
      const parentNode = this.#nodes.get(nextParent)!;
      if (!parentNode.children.includes(child)) {
        parentNode.children.push(child);
      }
    } else if (!this.#roots.includes(child)) {
      this.#roots.push(child);
    }
    this.#revision += 1;
  }

  setTransform(id: SceneNodeId, transform: Partial<SceneTransform>): void {
    this.#assertOperational();
    const node = this.#nodes.get(id);
    if (node === undefined) {
      throw invalid("node does not exist");
    }
    const merged: SceneTransform = {
      translation:
        transform.translation !== undefined
          ? cloneTuple3(validateVec3(transform.translation, "translation"))
          : node.transform.translation,
      rotation:
        transform.rotation !== undefined
          ? validateRotation(transform.rotation)
          : node.transform.rotation,
      scale:
        transform.scale !== undefined
          ? validatePositiveVec3(transform.scale, "scale")
          : node.transform.scale,
    };
    node.transform = merged;
    this.#revision += 1;
  }

  setVisible(id: SceneNodeId, visible: boolean): void {
    this.#assertOperational();
    const node = this.#nodes.get(id);
    if (node === undefined) {
      throw invalid("node does not exist");
    }
    if (typeof visible !== "boolean") {
      throw invalid("visible must be a boolean");
    }
    if (node.visible === visible) {
      return;
    }
    node.visible = visible;
    this.#revision += 1;
  }

  removeNode(id: SceneNodeId): SceneNodeId[] {
    this.#assertOperational();
    const node = this.#nodes.get(id);
    if (node === undefined) {
      throw invalid("node does not exist");
    }
    const removed: SceneNodeId[] = [];
    this.#collectSubtree(id, removed);
    if (node.parent !== null) {
      const parent = this.#nodes.get(node.parent);
      if (parent !== undefined) {
        parent.children = parent.children.filter((child) => child !== id);
      }
    } else {
      const index = this.#roots.indexOf(id);
      if (index >= 0) {
        this.#roots.splice(index, 1);
      }
    }
    for (const removedId of removed) {
      this.#nodes.delete(removedId);
    }
    this.#revision += 1;
    return removed;
  }

  getNode(id: SceneNodeId): SceneNodeSnapshot | undefined {
    const node = this.#nodes.get(id);
    if (node === undefined) {
      return undefined;
    }
    return snapshotNode(node);
  }

  getNodes(): SceneNodeSnapshot[] {
    const snapshots: SceneNodeSnapshot[] = [];
    const visit = (id: SceneNodeId, parentVisible: boolean): void => {
      const node = this.#nodes.get(id);
      if (node === undefined) {
        return;
      }
      const visible = parentVisible && node.visible;
      if (visible) {
        snapshots.push(snapshotNode(node));
        for (const child of node.children) {
          visit(child, true);
        }
      }
    };
    for (const root of this.#roots) {
      visit(root, true);
    }
    return snapshots;
  }

  addPass(pass: ScenePassInput): void {
    this.#assertOperational();
    if (typeof pass.name !== "string" || pass.name.length === 0) {
      throw invalid("pass name must be a nonempty string");
    }
    if (this.#passes.some((existing) => existing.name === pass.name)) {
      throw invalid(`duplicate pass name ${pass.name}`);
    }
    this.#passes.push(cloneValue(pass) as ScenePassInput);
    this.#revision += 1;
  }

  removePass(name: string): boolean {
    this.#assertOperational();
    const index = this.#passes.findIndex((pass) => pass.name === name);
    if (index < 0) {
      return false;
    }
    this.#passes.splice(index, 1);
    this.#revision += 1;
    return true;
  }

  getRenderPlan(): SceneRenderPlan {
    const visible = this.getNodes();
    const implicit: ScenePassInput[] = [];
    let previous: string | undefined;
    for (const kind of IMPLICIT_PASS_KINDS) {
      if (!visible.some((snapshot) => snapshot.node.kind === kind)) {
        continue;
      }
      const pass: ScenePassInput = {
        name: kind,
        kind: "render",
        writes: ["color"],
      };
      if (previous !== undefined) {
        pass.dependsOn = [previous];
      }
      implicit.push(pass);
      previous = kind;
    }
    return compileScenePasses([...implicit, ...this.#passes]);
  }

  snapshot(): SceneSnapshot {
    const nodes: SceneNodeSnapshot[] = [];
    const visit = (id: SceneNodeId): void => {
      const node = this.#nodes.get(id);
      if (node === undefined) {
        return;
      }
      nodes.push(snapshotNode(node));
      for (const child of node.children) {
        visit(child);
      }
    };
    for (const root of this.#roots) {
      visit(root);
    }
    return {
      revision: this.#revision,
      nodes,
      passes: cloneValue(this.#passes) as ScenePassInput[],
    };
  }

  copy(): Forge3DScene {
    const copy = new Forge3DScene();
    copy.#nextId = this.#nextId;
    copy.#revision = this.#revision;
    copy.#roots.push(...this.#roots);
    for (const [id, node] of this.#nodes) {
      copy.#nodes.set(id, {
        id: node.id,
        parent: node.parent,
        children: [...node.children],
        node: cloneNodeInput(node.node),
        transform: cloneTransform(node.transform),
        visible: node.visible,
      });
    }
    copy.#passes.push(
      ...(cloneValue(this.#passes) as ScenePassInput[]),
    );
    return copy;
  }

  estimatedGpuBytes(): number {
    let total = 0;
    for (const node of this.#nodes.values()) {
      total = checkedAdd(total, nodeByteEstimate(node.node));
    }
    return total;
  }

  dispose(): void {
    this.#disposed = true;
  }

  #assertOperational(): void {
    if (this.#disposed) {
      throw new Forge3DError("RUNTIME_DISPOSED", "Scene is disposed");
    }
  }

  #collectSubtree(id: SceneNodeId, out: SceneNodeId[]): void {
    const node = this.#nodes.get(id);
    if (node === undefined) {
      return;
    }
    for (const child of node.children) {
      this.#collectSubtree(child, out);
    }
    out.push(id);
  }
}

export function estimateSceneTriangles(
  nodes: readonly SceneNodeSnapshot[],
): number {
  let triangles = 0;
  for (const snapshot of nodes) {
    const node = snapshot.node;
    switch (node.kind) {
      case "terrain":
        triangles = checkedAdd(
          triangles,
          checkedMultiply(
            checkedMultiply(node.terrain.width - 1, node.terrain.height - 1),
            2,
          ),
        );
        break;
      case "ground-plane":
      case "overlay":
        triangles = checkedAdd(triangles, 2);
        break;
      case "text-mesh":
        triangles = checkedAdd(triangles, checkedMultiply(node.text.length, 2));
        break;
      default:
        break;
    }
  }
  return triangles;
}

function normalizeNodeInput(node: SceneNodeInput): Omit<StoredNode, "id" | "parent"> {
  if (typeof node !== "object" || node === null) {
    throw invalid("node must be an object");
  }
  const base = node as SceneNodeInput & { name?: unknown };
  if (typeof base.name !== "string" || base.name.length === 0) {
    throw invalid("name must be a nonempty string");
  }
  const transform = normalizeTransform(node.transform);
  const visible = node.visible ?? true;
  if (
    node.materialSlot !== undefined &&
    (typeof node.materialSlot !== "string" || node.materialSlot.length === 0)
  ) {
    throw invalid("materialSlot must be a nonempty string");
  }
  if (typeof visible !== "boolean") {
    throw invalid("visible must be a boolean");
  }
  const cloned = cloneNodeInput(node);
  validateByKind(node);
  return { children: [], node: cloned, transform, visible };
}

function normalizeTransform(
  transform: Partial<SceneTransform> | undefined,
): SceneTransform {
  const resolved = cloneTransform(IDENTITY_TRANSFORM);
  if (transform === undefined) {
    return resolved;
  }
  if (transform.translation !== undefined) {
    resolved.translation = cloneTuple3(
      validateVec3(transform.translation, "translation"),
    );
  }
  if (transform.rotation !== undefined) {
    resolved.rotation = validateRotation(transform.rotation);
  }
  if (transform.scale !== undefined) {
    resolved.scale = validatePositiveVec3(transform.scale, "scale");
  }
  return resolved;
}

function validateByKind(node: SceneNodeInput): void {
  switch (node.kind) {
    case "group":
      break;
    case "terrain":
      validateTerrain(node.terrain);
      break;
    case "ground-plane":
      validatePositivePair(node.size, "size");
      validateRgba(node.color, "color");
      if (node.height !== undefined && !Number.isFinite(node.height)) {
        throw invalid("height must be finite");
      }
      break;
    case "text-mesh":
      if (typeof node.text !== "string" || node.text.length === 0) {
        throw invalid("text must be a nonempty string");
      }
      if (!Number.isFinite(node.size) || node.size <= 0) {
        throw invalid("size must be finite and positive");
      }
      validateRgba(node.color, "color");
      break;
    case "overlay": {
      const bounds = node.bounds;
      if (!Array.isArray(bounds) || bounds.length !== 4) {
        throw invalid("bounds must be a 4-component vector");
      }
      for (const component of bounds) {
        if (!Number.isFinite(component)) {
          throw invalid("bounds must be finite");
        }
      }
      if (bounds[2]! <= 0 || bounds[3]! <= 0) {
        throw invalid("overlay width and height must be positive");
      }
      validateRgba(node.color, "color");
      if (node.zIndex !== undefined && !Number.isFinite(node.zIndex)) {
        throw invalid("zIndex must be finite");
      }
      break;
    }
    case "custom":
      if (typeof node.layerType !== "string" || node.layerType.length === 0) {
        throw invalid("layerType must be a nonempty string");
      }
      break;
    default:
      throw invalid(`unknown node kind ${String((node as { kind?: unknown }).kind)}`);
  }
}

function validateTerrain(terrain: TerrainHeightmapInput): void {
  if (
    !Number.isSafeInteger(terrain.width) ||
    terrain.width <= 0 ||
    !Number.isSafeInteger(terrain.height) ||
    terrain.height <= 0
  ) {
    throw invalid("terrain width and height must be positive safe integers");
  }
  if (!(terrain.heights instanceof Float32Array)) {
    throw invalid("terrain heights must be a Float32Array");
  }
  const expected = checkedMultiply(terrain.width, terrain.height);
  if (terrain.heights.length !== expected) {
    throw invalid(
      `terrain heights length ${terrain.heights.length} does not match ${expected} samples`,
    );
  }
  for (const value of terrain.heights) {
    if (!Number.isFinite(value)) {
      throw invalid("terrain heights must be finite");
    }
  }
}

function validateVec3(
  value: [number, number, number],
  field: string,
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw invalid(`${field} must be a 3-component vector`);
  }
  for (const component of value) {
    if (!Number.isFinite(component)) {
      throw invalid(`${field} components must be finite`);
    }
  }
  return value;
}

function validatePositiveVec3(
  value: [number, number, number],
  field: string,
): [number, number, number] {
  const checked = validateVec3(value, field);
  for (const component of checked) {
    if (component <= 0) {
      throw invalid(`${field} components must be positive`);
    }
  }
  return cloneTuple3(checked);
}

function validateRotation(
  value: [number, number, number, number],
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw invalid("rotation must be a 4-component quaternion");
  }
  let squared = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) {
      throw invalid("rotation components must be finite");
    }
    squared += component * component;
  }
  const length = Math.sqrt(squared);
  if (length <= 1e-6 || Math.abs(length - 1) > 1e-3) {
    throw invalid("rotation must be a normalized nonzero quaternion");
  }
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

function validatePositivePair(value: [number, number], field: string): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalid(`${field} must be a 2-component vector`);
  }
  for (const component of value) {
    if (!Number.isFinite(component) || component <= 0) {
      throw invalid(`${field} components must be finite and positive`);
    }
  }
}

function validateRgba(value: [number, number, number, number], field: string): void {
  if (!Array.isArray(value) || value.length !== 4) {
    throw invalid(`${field} must be a 4-component color`);
  }
  for (const component of value) {
    if (!Number.isFinite(component) || component < 0 || component > 1) {
      throw invalid(`${field} components must be in the 0..1 range`);
    }
  }
}

function nodeByteEstimate(node: SceneNodeInput): number {
  switch (node.kind) {
    case "terrain": {
      const cells = checkedMultiply(node.terrain.width - 1, node.terrain.height - 1);
      return checkedAdd(
        checkedAdd(
          node.terrain.heights.byteLength,
          checkedMultiply(checkedMultiply(node.terrain.width, node.terrain.height), 20),
        ),
        checkedMultiply(cells, 24),
      );
    }
    case "ground-plane":
      return 6 * 7 * 4;
    case "text-mesh":
      return checkedMultiply(node.text.length, 6 * 7 * 4);
    case "overlay":
      return 6 * 6 * 4;
    default:
      return 0;
  }
}

function snapshotNode(node: StoredNode): SceneNodeSnapshot {
  return {
    id: node.id,
    parent: node.parent,
    children: [...node.children],
    node: cloneNodeInput(node.node),
    transform: cloneTransform(node.transform),
    visible: node.visible,
  };
}

function cloneTransform(transform: SceneTransform): SceneTransform {
  return {
    translation: [...transform.translation],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function cloneTuple3(value: [number, number, number]): [number, number, number] {
  return [value[0]!, value[1]!, value[2]!];
}

function cloneNodeInput(node: SceneNodeInput): SceneNodeInput {
  if (node.kind === "custom" && node.payload !== undefined) {
    const { payload, ...rest } = node;
    const cloned = cloneValue(rest) as SceneNodeInput;
    (cloned as CustomNodeInput).payload = clonePayload(payload);
    return cloned;
  }
  return cloneValue(node) as SceneNodeInput;
}

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value instanceof Float32Array) {
    return new Float32Array(value) as T;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }
  if (value instanceof DataView) {
    return new DataView(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    ) as T;
  }
  if (ArrayBuffer.isView(value)) {
    return (value as unknown as { slice(): T }).slice();
  }
  if (typeof value === "object" && value !== null) {
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing as T;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const entry of value) {
        copy.push(cloneValue(entry, seen));
      }
      return copy as T;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneValue(entry, seen);
    }
    return copy as T;
  }
  return value;
}

export function clonePayload<T>(value: T): T {
  const cloner = (
    globalThis as typeof globalThis & {
      structuredClone?: (input: unknown) => unknown;
    }
  ).structuredClone;
  if (typeof cloner === "function") {
    try {
      return cloner(value) as T;
    } catch {
      return cloneValue(value);
    }
  }
  return cloneValue(value);
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      "scene byte estimate exceeds safe integer limits",
    );
  }
  return value;
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Forge3DError(
      "RESOURCE_LIMIT_EXCEEDED",
      "scene byte estimate exceeds safe integer limits",
    );
  }
  return value;
}

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}
