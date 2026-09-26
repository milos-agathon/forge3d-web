import { Forge3DError } from "./index.js";
import type {
  BrdfModel,
  BrdfRoute,
  MaterialCollectionSnapshot,
  MaterialInput,
  MaterialSnapshot,
  MaterialSlotSnapshot,
  TextureSetSnapshot,
} from "./index.js";
import {
  TextureSet,
  textureSetSnapshotGpuBytes,
  textureSetsEqual,
} from "./textures.js";

export const MAX_MATERIALS = 256;
export const PACKED_MATERIAL_BYTES = 64;
export const MATERIAL_UNIFORM_BYTES = 16;
export const DEFAULT_MATERIAL_SLOT = "default";

const CANONICAL_BRDF_MODELS: readonly BrdfModel[] = [
  "lambert",
  "phong",
  "blinn-phong",
  "oren-nayar",
  "cooktorrance-ggx",
  "cooktorrance-beckmann",
  "disney-principled",
  "ashikhmin-shirley",
  "ward",
  "toon",
  "minnaert",
  "subsurface",
  "hair",
];

const BRDF_ALIASES: ReadonlyMap<string, BrdfModel> = new Map([
  ["blinnphong", "blinn-phong"],
  ["orennayar", "oren-nayar"],
  ["cook-torrance-ggx", "cooktorrance-ggx"],
  ["cooktorranceggx", "cooktorrance-ggx"],
  ["ggx", "cooktorrance-ggx"],
  ["cook-torrance-beckmann", "cooktorrance-beckmann"],
  ["cooktorrancebeckmann", "cooktorrance-beckmann"],
  ["beckmann", "cooktorrance-beckmann"],
  ["disneyprincipled", "disney-principled"],
  ["disney", "disney-principled"],
  ["ashikhminshirley", "ashikhmin-shirley"],
  ["sss", "subsurface"],
  ["kajiyakay", "hair"],
  ["kajiya-kay", "hair"],
]);

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_BRDF_MODELS);

// Native `normalize_key` (1f4084a:src/render/params/common.rs): trim, lowercase
// and drop '-', '_', ' ' and '.' before matching `BrdfModel::from_str` keys.
function nativeBrdfKey(requested: string): string {
  return requested.trim().toLowerCase().replace(/[-_ .]/g, "");
}

const NATIVE_BRDF_KEYS: ReadonlyMap<string, BrdfModel> = new Map([
  ...CANONICAL_BRDF_MODELS.map(
    (model) => [nativeBrdfKey(model), model] as [string, BrdfModel],
  ),
  ["ggx", "cooktorrance-ggx"],
  ["beckmann", "cooktorrance-beckmann"],
  ["disney", "disney-principled"],
  ["sss", "subsurface"],
  ["kajiyakay", "hair"],
]);

function normalizeBrdfName(requested: string): string {
  return requested
    .split(/[_\s]+/)
    .filter((part) => part.length > 0)
    .join("-")
    .toLowerCase();
}

function baseRoute(model: BrdfModel): {
  implementation: BrdfRoute["implementation"];
  effectiveModel: BrdfModel;
  diagnostic?: string;
} {
  switch (model) {
    case "blinn-phong":
      return {
        implementation: "alias",
        effectiveModel: "phong",
        diagnostic: "blinn-phong is rendered by the normalized phong route",
      };
    case "subsurface":
      return {
        implementation: "approximation",
        effectiveModel: "disney-principled",
        diagnostic:
          "subsurface is approximated by disney-principled with the subsurface lobe",
      };
    case "hair":
      return {
        implementation: "approximation",
        effectiveModel: "ashikhmin-shirley",
        diagnostic: "hair is approximated by ashikhmin-shirley anisotropy",
      };
    default:
      return { implementation: "exact", effectiveModel: model };
  }
}

export function resolveBrdfModel(requested: string): BrdfRoute {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.brdf must be a nonempty string",
      { field: "material.brdf" },
    );
  }
  const normalized = normalizeBrdfName(requested);
  const model: BrdfModel | undefined = CANONICAL_SET.has(normalized)
    ? (normalized as BrdfModel)
    : (BRDF_ALIASES.get(normalized) ?? NATIVE_BRDF_KEYS.get(nativeBrdfKey(requested)));
  if (model === undefined) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `material.brdf unknown brdf model '${requested}'`,
      { field: "material.brdf" },
    );
  }
  const base = baseRoute(model);
  const inputAlias = normalized !== model;
  if (!inputAlias) {
    const route: BrdfRoute = {
      requested,
      model,
      effectiveModel: base.effectiveModel,
      implementation: base.implementation,
    };
    if (base.diagnostic !== undefined) {
      route.diagnostic = base.diagnostic;
    }
    return route;
  }
  if (base.implementation === "exact") {
    return {
      requested,
      model,
      effectiveModel: base.effectiveModel,
      implementation: "alias",
      diagnostic: `${normalized} is an alias for ${model}`,
    };
  }
  return {
    requested,
    model,
    effectiveModel: base.effectiveModel,
    implementation: base.implementation,
    diagnostic: `${base.diagnostic ?? ""}; input alias ${normalized} resolves to ${model}`,
  };
}

function defaultMaterial(): MaterialSnapshot {
  return {
    id: DEFAULT_MATERIAL_SLOT,
    brdf: "cooktorrance-ggx",
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    sheen: 0,
    clearcoat: 0,
    subsurface: 0,
    anisotropy: 0,
    route: resolveBrdfModel("cooktorrance-ggx"),
    textures: new TextureSet().snapshot(),
  };
}

function cloneRoute(route: BrdfRoute): BrdfRoute {
  const copy: BrdfRoute = {
    requested: route.requested,
    model: route.model,
    effectiveModel: route.effectiveModel,
    implementation: route.implementation,
  };
  if (route.diagnostic !== undefined) {
    copy.diagnostic = route.diagnostic;
  }
  return copy;
}

function cloneMaterial(material: MaterialSnapshot): MaterialSnapshot {
  return {
    id: material.id,
    brdf: material.brdf,
    baseColor: [...material.baseColor],
    metallic: material.metallic,
    roughness: material.roughness,
    sheen: material.sheen,
    clearcoat: material.clearcoat,
    subsurface: material.subsurface,
    anisotropy: material.anisotropy,
    route: cloneRoute(material.route),
    textures: TextureSet.from(material.textures).snapshot(),
  };
}

function unitInterval(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Forge3DError(
      "INVALID_INPUT",
      `${field} must be finite and in the 0..1 range`,
      { field },
    );
  }
  return value;
}

function optionalUnitInterval(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  return unitInterval(value, field);
}

function normalizeBaseColor(
  value: [number, number, number, number] | undefined,
): [number, number, number, number] {
  if (value === undefined) {
    return [1, 1, 1, 1];
  }
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.baseColor must be a 4-component array",
      { field: "material.baseColor" },
    );
  }
  return [
    unitInterval(value[0]!, "material.baseColor"),
    unitInterval(value[1]!, "material.baseColor"),
    unitInterval(value[2]!, "material.baseColor"),
    unitInterval(value[3]!, "material.baseColor"),
  ];
}

function normalizeMaterialInput(material: MaterialInput): MaterialSnapshot {
  const route = resolveBrdfModel(material.brdf ?? "cooktorrance-ggx");
  return {
    id: normalizeMaterialId(material.id),
    brdf: route.model,
    baseColor: normalizeBaseColor(material.baseColor),
    metallic: optionalUnitInterval(material.metallic, 0, "material.metallic"),
    roughness: optionalUnitInterval(
      material.roughness,
      0.5,
      "material.roughness",
    ),
    sheen: optionalUnitInterval(material.sheen, 0, "material.sheen"),
    clearcoat: optionalUnitInterval(
      material.clearcoat,
      0,
      "material.clearcoat",
    ),
    subsurface: optionalUnitInterval(
      material.subsurface,
      0,
      "material.subsurface",
    ),
    anisotropy: normalizeAnisotropy(material.anisotropy),
    route,
    textures: normalizeTextureInput(material.textures),
  };
}

function normalizeTextureInput(
  textures: MaterialInput["textures"],
): TextureSetSnapshot {
  if (textures === undefined) {
    return new TextureSet().snapshot();
  }
  if (textures instanceof TextureSet) {
    return textures.snapshot();
  }
  return new TextureSet(textures).snapshot();
}

function routesEqual(a: BrdfRoute, b: BrdfRoute): boolean {
  return (
    a.requested === b.requested &&
    a.model === b.model &&
    a.effectiveModel === b.effectiveModel &&
    a.implementation === b.implementation &&
    a.diagnostic === b.diagnostic
  );
}

function materialsEqual(a: MaterialSnapshot, b: MaterialSnapshot): boolean {
  return (
    a.id === b.id &&
    a.brdf === b.brdf &&
    a.baseColor.every((component, index) => component === b.baseColor[index]) &&
    a.metallic === b.metallic &&
    a.roughness === b.roughness &&
    a.sheen === b.sheen &&
    a.clearcoat === b.clearcoat &&
    a.subsurface === b.subsurface &&
    a.anisotropy === b.anisotropy &&
    routesEqual(a.route, b.route) &&
    textureSetsEqual(a.textures, b.textures)
  );
}

function validateSuppliedRoute(value: unknown): BrdfRoute {
  if (typeof value !== "object" || value === null) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route must be an object",
      { field: "material.route" },
    );
  }
  const route = value as Record<string, unknown>;
  if (typeof route.requested !== "string" || route.requested.length === 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route.requested must be a nonempty string",
      { field: "material.route" },
    );
  }
  if (
    typeof route.model !== "string" ||
    typeof route.effectiveModel !== "string"
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route model and effectiveModel must be strings",
      { field: "material.route" },
    );
  }
  if (
    route.implementation !== "exact" &&
    route.implementation !== "alias" &&
    route.implementation !== "approximation"
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route.implementation must be exact, alias, or approximation",
      { field: "material.route" },
    );
  }
  if (route.diagnostic !== undefined && typeof route.diagnostic !== "string") {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route.diagnostic must be a string when present",
      { field: "material.route" },
    );
  }
  const resolved = resolveBrdfModel(route.requested);
  if (
    route.model !== resolved.model ||
    route.effectiveModel !== resolved.effectiveModel ||
    route.implementation !== resolved.implementation ||
    (route.diagnostic as string | undefined) !== resolved.diagnostic
  ) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.route does not match the shared route table for the requested model",
      { field: "material.route" },
    );
  }
  return resolved;
}

function normalizeSnapshotMaterial(material: MaterialSnapshot): MaterialSnapshot {
  if (typeof material !== "object" || material === null) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "materials.materials material must be an object",
      { field: "materials.materials" },
    );
  }
  const route = validateSuppliedRoute(material.route);
  if (material.brdf !== route.model) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.brdf must equal material.route.model",
      { field: "material.brdf" },
    );
  }
  return {
    id: normalizeMaterialId(material.id),
    brdf: route.model,
    baseColor: normalizeBaseColor(material.baseColor),
    metallic: optionalUnitInterval(material.metallic, 0, "material.metallic"),
    roughness: optionalUnitInterval(
      material.roughness,
      0.5,
      "material.roughness",
    ),
    sheen: optionalUnitInterval(material.sheen, 0, "material.sheen"),
    clearcoat: optionalUnitInterval(
      material.clearcoat,
      0,
      "material.clearcoat",
    ),
    subsurface: optionalUnitInterval(
      material.subsurface,
      0,
      "material.subsurface",
    ),
    anisotropy: normalizeAnisotropy(material.anisotropy),
    route,
    textures: TextureSet.from(material.textures).snapshot(),
  };
}

function normalizeMaterialId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.id must be a nonempty string",
      { field: "material.id" },
    );
  }
  return id;
}

function normalizeAnisotropy(value: number | undefined): number {
  const anisotropy = value ?? 0;
  if (!Number.isFinite(anisotropy) || anisotropy < -1 || anisotropy > 1) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "material.anisotropy must be finite and in the -1..1 range",
      { field: "material.anisotropy" },
    );
  }
  return anisotropy;
}

interface StoredSlot {
  index: number;
  material: MaterialSnapshot;
}

export class MaterialCollection {
  readonly #maxMaterials: number;
  #revision = 0;
  #nextIndex = 1;
  readonly #slots = new Map<string, StoredSlot>();

  constructor(maxMaterials: number = MAX_MATERIALS) {
    if (
      !Number.isSafeInteger(maxMaterials) ||
      maxMaterials < 1 ||
      maxMaterials > MAX_MATERIALS
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials.maxMaterials must be an integer between 1 and 256",
        { field: "materials.maxMaterials" },
      );
    }
    this.#maxMaterials = maxMaterials;
    this.#slots.set(DEFAULT_MATERIAL_SLOT, {
      index: 0,
      material: defaultMaterial(),
    });
  }

  static from(snapshot: MaterialCollectionSnapshot): MaterialCollection {
    if (typeof snapshot !== "object" || snapshot === null) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials snapshot must be an object",
      );
    }
    if (
      !Number.isSafeInteger(snapshot.maxMaterials) ||
      snapshot.maxMaterials < 1 ||
      snapshot.maxMaterials > MAX_MATERIALS
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials.maxMaterials must be an integer between 1 and 256",
        { field: "materials.maxMaterials" },
      );
    }
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials.revision must be a nonnegative integer",
        { field: "materials.revision" },
      );
    }
    if (!Array.isArray(snapshot.materials)) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials.materials must be an array",
      );
    }
    const collection = new MaterialCollection(snapshot.maxMaterials);
    collection.#slots.clear();
    const seenIndices = new Set<number>();
    let hasDefault = false;
    for (const entry of snapshot.materials) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.slot !== "string" ||
        entry.slot.length === 0
      ) {
        throw new Forge3DError(
          "INVALID_INPUT",
          "materials.materials slot names must be nonempty",
        );
      }
      if (
        !Number.isSafeInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= snapshot.maxMaterials
      ) {
        throw new Forge3DError(
          "INVALID_INPUT",
          "materials.materials indices must be in the 0..maxMaterials range",
        );
      }
      if (collection.#slots.has(entry.slot) || seenIndices.has(entry.index)) {
        throw new Forge3DError(
          "INVALID_INPUT",
          "materials.materials slots and indices must be unique",
        );
      }
      if (entry.slot === DEFAULT_MATERIAL_SLOT) {
        if (entry.index !== 0) {
          throw new Forge3DError(
            "INVALID_INPUT",
            "the default material slot must sit at index 0",
          );
        }
        hasDefault = true;
      }
      const material = normalizeSnapshotMaterial(entry.material);
      collection.#slots.set(entry.slot, { index: entry.index, material });
      seenIndices.add(entry.index);
    }
    if (!hasDefault) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials must include a default slot at index 0",
      );
    }
    collection.#nextIndex =
      Math.max(0, ...snapshot.materials.map((entry) => entry.index)) + 1;
    collection.#revision = snapshot.revision;
    return collection;
  }

  get size(): number {
    return this.#slots.size;
  }

  get maxMaterials(): number {
    return this.#maxMaterials;
  }

  get revision(): number {
    return this.#revision;
  }

  set(slot: string, material: MaterialInput): void {
    if (typeof slot !== "string" || slot.length === 0) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "materials slot must be a nonempty string",
        { field: "materials.slot" },
      );
    }
    const normalized = normalizeMaterialInput(material);
    const existing = this.#slots.get(slot);
    if (existing === undefined) {
      if (this.#slots.size >= this.#maxMaterials) {
        throw new Forge3DError(
          "INVALID_INPUT",
          `materials cannot exceed the maximum of ${this.#maxMaterials} slots`,
          { field: "materials" },
        );
      }
      this.#slots.set(slot, {
        index: this.#nextIndex,
        material: normalized,
      });
      this.#nextIndex += 1;
    } else {
      this.#slots.set(slot, { index: existing.index, material: normalized });
    }
    this.#revision += 1;
  }

  remove(slot: string): boolean {
    if (slot === DEFAULT_MATERIAL_SLOT) {
      return false;
    }
    if (!this.#slots.delete(slot)) {
      return false;
    }
    this.#revision += 1;
    return true;
  }

  clear(): void {
    const defaultSlot = this.#slots.get(DEFAULT_MATERIAL_SLOT)!;
    const changed =
      this.#slots.size > 1 ||
      !materialsEqual(defaultSlot.material, defaultMaterial());
    if (!changed) {
      return;
    }
    this.#slots.clear();
    this.#slots.set(DEFAULT_MATERIAL_SLOT, {
      index: 0,
      material: defaultMaterial(),
    });
    this.#revision += 1;
  }

  get(slot: string): MaterialSnapshot | undefined {
    const stored = this.#slots.get(slot);
    if (stored === undefined) {
      return undefined;
    }
    return cloneMaterial(stored.material);
  }

  values(): MaterialSlotSnapshot[] {
    return [...this.#slots.entries()]
      .map(([slot, stored]) => ({
        slot,
        index: stored.index,
        material: cloneMaterial(stored.material),
      }))
      .sort((a, b) => a.index - b.index);
  }

  route(slot: string): BrdfRoute {
    const stored = this.#slots.get(slot);
    if (stored === undefined) {
      throw new Forge3DError(
        "INVALID_INPUT",
        `materials slot '${slot}' does not exist`,
        { field: "materials.slot" },
      );
    }
    return cloneRoute(stored.material.route);
  }

  snapshot(): MaterialCollectionSnapshot {
    return {
      revision: this.#revision,
      maxMaterials: this.#maxMaterials,
      materials: this.values(),
    };
  }

  copy(): MaterialCollection {
    return MaterialCollection.from(this.snapshot());
  }

  estimatedGpuBytes(): number {
    let total =
      this.#maxMaterials * PACKED_MATERIAL_BYTES + MATERIAL_UNIFORM_BYTES;
    for (const slot of this.values()) {
      total += textureSetSnapshotGpuBytes(slot.material.textures);
      if (!Number.isSafeInteger(total)) {
        throw new Forge3DError(
          "INVALID_INPUT",
          "material GPU estimate exceeds the safe integer range",
        );
      }
    }
    return total;
  }
}
