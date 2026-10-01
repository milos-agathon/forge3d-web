// W08 / DESIGN F5 — pure-TypeScript overlay and virtual-texture
// normalization mirroring `terrain_overlay` / `terrain_vt` in
// forge3d-core and the wasm input resolution in
// `src/inputs.rs::read_terrain_overlays` and
// `src/terrain_material_input.rs::VtJs::to_settings`. Error field names
// and message wording mirror the core `InvalidInput` texts verbatim so
// a page can pre-validate inputs with exactly the commit-time
// contract.

import type {
  NormalizedTerrainOverlayLayer,
  NormalizedTerrainOverlays,
  NormalizedTerrainVirtualTexture,
  NormalizedTerrainVtLayerFamily,
  OverlayBlendMode,
  TerrainMaterialImage,
  TerrainOverlaysInput,
  TerrainVirtualTextureInput,
  TerrainVtFamily,
  TerrainVtSupportReport,
} from "./index.js";
import { Forge3DError } from "./index.js";

const MAX_VISIBLE_LAYERS = 8;
const VISIBLE_OPACITY_EPSILON = 0.001;
const VALID_BLEND_MODES: readonly OverlayBlendMode[] = [
  "multiply",
  "normal",
  "overlay",
];
const VALID_VT_FAMILIES: readonly TerrainVtFamily[] = ["albedo", "mask", "normal"];

function invalidInput(field: string, message: string): Forge3DError {
  return new Forge3DError(
    "INVALID_INPUT",
    `Invalid input ${field}: ${message}`,
    { reason: "invalid-input", field },
  );
}

function invalidTerrain(field: string, message: string): Forge3DError {
  return new Forge3DError(
    "INVALID_INPUT",
    `Invalid terrain ${field}: ${message}`,
    { reason: "invalid-input", field },
  );
}

/** W08 (F5): the native `OverlaySettings::default()` — overlays are
 * disabled unless a block is committed. */
export function getTerrainOverlayDefaults(): NormalizedTerrainOverlays {
  return {
    enabled: false,
    globalOpacity: 1.0,
    resolutionScale: 1.0,
    layers: [],
  };
}

/** Mirror of wasm `read_image` + core `OverlayImage::new`. */
function normalizeImage(
  image: unknown,
  field: string,
): TerrainMaterialImage {
  if (typeof image !== "object" || image === null || Array.isArray(image)) {
    throw invalidTerrain(`${field}.image`, "missing image object");
  }
  const record = image as Partial<TerrainMaterialImage> & {
    rgba?: Uint8Array | Uint8ClampedArray;
  };
  const width = record.width;
  const height = record.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw invalidInput(
      `material.${field}.image`,
      "width and height must be positive integers",
    );
  }
  const data = record.data ?? record.rgba;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    throw invalidInput(
      `material.${field}.image`,
      "data must be a Uint8Array",
    );
  }
  const expected = width * height * 4;
  if (data.byteLength !== expected) {
    throw invalidInput(
      "overlay.image",
      `overlay image must be ${width}x${height} RGBA8 (${expected} bytes), got ${data.byteLength}`,
    );
  }
  // Native stores RGBA bytes as `Uint8Array`; `ImageData.data` arrives
  // clamped, so copy into a plain array.
  const bytes =
    data instanceof Uint8Array ? data : new Uint8Array(data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ));
  return { width, height, data: bytes };
}

function normalizeLayer(
  layer: import("./index.js").TerrainOverlayLayerInput,
  index: number,
): NormalizedTerrainOverlayLayer {
  const field = `overlays.layers[${index}]`;
  const input = layer as {
    name?: string;
    image: unknown;
    extent?: number[];
    crs?: string;
    crsBounds?: number[];
    opacity?: number;
    blendMode?: string;
    visible?: boolean;
    zOrder?: number;
  };
  const image = normalizeImage(input.image, field);
  const hasExtent = input.extent !== undefined;
  const hasCrs = input.crs !== undefined || input.crsBounds !== undefined;
  if (hasExtent && hasCrs) {
    throw invalidTerrain(
      field,
      "extent and crs/crsBounds are mutually exclusive",
    );
  }
  let extent: [number, number, number, number] | undefined;
  let crs: string | undefined;
  let crsBounds: [number, number, number, number] | undefined;
  if (hasExtent) {
    const value = input.extent;
    if (!Array.isArray(value) || value.length !== 4) {
      throw invalidTerrain(field, "extent must be (u_min, v_min, u_max, v_max)");
    }
    extent = [value[0]!, value[1]!, value[2]!, value[3]!];
  } else if (input.crs !== undefined) {
    if (input.crsBounds === undefined) {
      throw invalidTerrain(field, "crs requires crsBounds");
    }
    if (!Array.isArray(input.crsBounds) || input.crsBounds.length !== 4) {
      throw invalidTerrain(
        `${field}.crsBounds`,
        "must be [minx, miny, maxx, maxy]",
      );
    }
    crs = input.crs;
    crsBounds = [
      input.crsBounds[0]!,
      input.crsBounds[1]!,
      input.crsBounds[2]!,
      input.crsBounds[3]!,
    ];
  }

  const name = input.name ?? `layer${index}`;
  const opacity = input.opacity ?? 1.0;
  const blendMode = (input.blendMode ?? "normal") as OverlayBlendMode;
  const visible = input.visible ?? true;
  const zOrder = input.zOrder ?? 0;

  // Mirror `OverlayLayer::validate` in field order.
  if (name === "") {
    throw invalidInput("overlay.name", "name must be non-empty");
  }
  if (!(opacity >= 0 && opacity <= 1)) {
    throw invalidInput("overlay.opacity", "opacity must be in [0.0, 1.0]");
  }
  if (!VALID_BLEND_MODES.includes(blendMode)) {
    throw invalidInput(
      "overlay.blend_mode",
      `blend_mode must be one of ['multiply', 'normal', 'overlay'], got '${blendMode}'`,
    );
  }
  if (extent !== undefined && !(extent[0] < extent[2] && extent[1] < extent[3])) {
    throw invalidInput(
      "overlay.extent",
      "extent must have u_min < u_max and v_min < v_max",
    );
  }
  if (
    crsBounds !== undefined &&
    !(crsBounds[0] < crsBounds[2] && crsBounds[1] < crsBounds[3])
  ) {
    throw invalidInput(
      "overlay.extent",
      "extent must have u_min < u_max and v_min < v_max",
    );
  }
  const normalized: NormalizedTerrainOverlayLayer = {
    name,
    image,
    opacity,
    blendMode,
    visible,
    zOrder,
  };
  if (extent !== undefined) normalized.extent = extent;
  if (crs !== undefined) normalized.crs = crs;
  if (crsBounds !== undefined) normalized.crsBounds = crsBounds;
  return normalized;
}

/** W08 (F5): normalize + validate `terrain.overlays` exactly as the
 * wasm `read_terrain_overlays` + core `OverlaySettings::validate`
 * would. `enabled` defaults to true when the block is present. */
export function normalizeTerrainOverlays(
  input: TerrainOverlaysInput,
): NormalizedTerrainOverlays {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "Invalid terrain overlays input: must be an object",
      { reason: "invalid-input" },
    );
  }
  const layers = (input.layers ?? []).map((layer, index) =>
    normalizeLayer(layer, index),
  );
  const settings: NormalizedTerrainOverlays = {
    enabled: input.enabled ?? true,
    globalOpacity: input.globalOpacity ?? 1.0,
    resolutionScale: input.resolutionScale ?? 1.0,
    layers,
  };
  // Mirror `OverlaySettings::validate` in field order.
  if (!(settings.globalOpacity >= 0 && settings.globalOpacity <= 1)) {
    throw invalidInput(
      "overlay.global_opacity",
      "global_opacity must be in [0.0, 1.0]",
    );
  }
  if (!(settings.resolutionScale >= 0.1 && settings.resolutionScale <= 2.0)) {
    throw invalidInput(
      "overlay.resolution_scale",
      "resolution_scale must be in [0.1, 2.0]",
    );
  }
  const visible = terrainOverlayVisibleLayers(settings).length;
  if (visible > MAX_VISIBLE_LAYERS) {
    throw invalidInput(
      "overlay.visible_layers",
      `overlay supports at most ${MAX_VISIBLE_LAYERS} visible layers, got ${visible}`,
    );
  }
  return settings;
}

/** Native `is_effectively_visible`: `visible && opacity > 0.001`. */
export function isTerrainOverlayLayerVisible(
  layer: NormalizedTerrainOverlayLayer,
): boolean {
  return layer.visible && layer.opacity > VISIBLE_OPACITY_EPSILON;
}

/** Native `visible_layers()`: effectively-visible layers sorted by
 * `zOrder`, stable by input order (Array.prototype.sort is stable). */
export function terrainOverlayVisibleLayers(
  settings: NormalizedTerrainOverlays,
): NormalizedTerrainOverlayLayer[] {
  return settings.layers
    .filter(isTerrainOverlayLayerVisible)
    .sort((a, b) => a.zOrder - b.zOrder);
}

/** Decode a browser image source (`Blob`, `ImageData`, canvas image
 * sources) or a `TerrainMaterialImage`-shaped object into straight
 * RGBA8. Node/vitest callers pass `TerrainMaterialImage` or
 * `{width, height, data}` fixtures directly. */
export async function decodeOverlayImage(
  input:
    | TerrainMaterialImage
    | { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
    | { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array }
    | Blob
    | ImageData
    | CanvasImageSource,
): Promise<TerrainMaterialImage> {
  if (
    typeof input === "object" &&
    input !== null &&
    "width" in input &&
    "height" in input &&
    ("rgba" in input || "data" in input)
  ) {
    return normalizeImage(
      input as TerrainMaterialImage & {
        rgba?: Uint8Array | Uint8ClampedArray;
      },
      "overlay.image",
    );
  }
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(input as Blob | ImageData);
    try {
      if (typeof OffscreenCanvas === "function") {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "2D canvas context unavailable for overlay image decode",
            { reason: "overlay-decode-unavailable" },
          );
        }
        context.drawImage(bitmap, 0, 0);
        const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
        return {
          width: imageData.width,
          height: imageData.height,
          data: new Uint8Array(imageData.data),
        };
      }
      if (typeof document === "object" && document !== null) {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "2D canvas context unavailable for overlay image decode",
            { reason: "overlay-decode-unavailable" },
          );
        }
        context.drawImage(bitmap, 0, 0);
        const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
        return {
          width: imageData.width,
          height: imageData.height,
          data: new Uint8Array(imageData.data),
        };
      }
    } finally {
      bitmap.close();
    }
  }
  throw new Forge3DError(
    "UNSUPPORTED_FEATURE",
    "overlay image decode requires createImageBitmap and a 2D canvas",
    { reason: "overlay-decode-unavailable" },
  );
}

/** W08 (F5): normalize + validate `material.virtualTexture` exactly as
 * `VtJs::to_settings` + core `TerrainVtSettings::validate` would.
 * `enabled` defaults to true when the block is present; when `input`
 * is `undefined` the result is the disabled core default. */
export function normalizeTerrainVirtualTexture(
  input?: TerrainVirtualTextureInput,
): NormalizedTerrainVirtualTexture {
  if (input === undefined) {
    return {
      enabled: false,
      atlasSize: 4096,
      residencyBudgetMb: 256.0,
      maxMipLevels: 8,
      useFeedback: true,
      layers: [],
    };
  }
  const layers = (input.layers ?? []).map((layer) => {
    const family = layer.family ?? "albedo";
    const resolved: NormalizedTerrainVtLayerFamily = {
      family,
      virtualSizePx: layer.virtualSizePx ?? [4096, 4096],
      tileSize: layer.tileSize ?? 248,
      tileBorder: layer.tileBorder ?? 4,
      fallback: layer.fallback ?? [0.5, 0.5, 0.5, 1.0],
    };
    validateVtLayer(resolved);
    return resolved;
  });
  const settings: NormalizedTerrainVirtualTexture = {
    enabled: input.enabled ?? true,
    atlasSize: input.atlasSize ?? 4096,
    residencyBudgetMb: input.residencyBudgetMb ?? 256.0,
    maxMipLevels: input.maxMipLevels ?? 8,
    useFeedback: input.useFeedback ?? true,
    layers,
  };
  // Mirror `TerrainVtSettings::validate` in field order.
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.family)) {
      throw invalidInput("vt.layers", "duplicate family in layers");
    }
    seen.add(layer.family);
    validateVtLayer(layer);
  }
  if (settings.atlasSize < 256) {
    throw invalidInput("vt.atlas_size", "atlas_size must be >= 256");
  }
  if (!(settings.residencyBudgetMb > 0)) {
    throw invalidInput(
      "vt.residency_budget_mb",
      "residency_budget_mb must be > 0",
    );
  }
  if (settings.maxMipLevels < 1) {
    throw invalidInput("vt.max_mip_levels", "max_mip_levels must be >= 1");
  }
  for (const layer of layers) {
    const slotSize = layer.tileSize + 2 * layer.tileBorder;
    if (settings.atlasSize % slotSize !== 0) {
      throw invalidInput(
        "vt.atlas_size",
        `atlas_size (${settings.atlasSize}) must be divisible by slot_size (${slotSize}) for family '${layer.family}'`,
      );
    }
  }
  return settings;
}

function validateVtLayer(layer: NormalizedTerrainVtLayerFamily): void {
  if (!VALID_VT_FAMILIES.includes(layer.family)) {
    throw invalidInput(
      "vt.family",
      "family must be one of ['albedo', 'mask', 'normal']",
    );
  }
  if (layer.tileSize < 16) {
    throw invalidInput("vt.tile_size", "tile_size must be >= 16");
  }
  if (
    layer.virtualSizePx[0] < layer.tileSize ||
    layer.virtualSizePx[1] < layer.tileSize
  ) {
    throw invalidInput(
      "vt.virtual_size_px",
      "virtual_size_px must be >= tile_size in both dimensions",
    );
  }
}

const VT_SUPPORTED_FAMILY = "albedo";
const VT_LAYER_ID = "terrain.vt";
const VT_LAYER_TYPE = "terrain.virtual_texture";

/** Pure-TS mirror of core `validate_terrain_vt_support` (1f4084a shape):
 * identical output to the WASM free function for the same input — the
 * browser parity test compares them verbatim. */
export function validateTerrainVtSupportTs(
  input?: TerrainVirtualTextureInput,
): TerrainVtSupportReport {
  const settings = normalizeTerrainVirtualTexture(input);
  const diagnostics = settings.layers
    .filter((layer) => layer.family !== VT_SUPPORTED_FAMILY)
    .map((layer) => ({
      code: "vt_unsupported_family",
      severity: "error",
      message:
        "Requested terrain virtual-texturing family is not paged by the native runtime.",
      remediation:
        "Use the albedo VT family or wait for native normal/mask runtime support.",
      supportLevel: "unsupported",
      layerId: VT_LAYER_ID,
      objectId: `vt.${layer.family}`,
      details: {
        family: layer.family,
        supported_family: VT_SUPPORTED_FAMILY,
      },
    }));
  diagnostics.sort((a, b) =>
    a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0,
  );

  const families = settings.layers.map((layer) => layer.family);
  families.sort();

  const supportedFeatures: Record<string, string> = {
    [`vt.${VT_SUPPORTED_FAMILY}`]: "supported",
  };
  const unsupportedFeatures: Record<string, string> = {};
  for (const layer of settings.layers) {
    if (layer.family !== VT_SUPPORTED_FAMILY) {
      unsupportedFeatures[`vt.${layer.family}`] = "unsupported";
    }
  }

  return {
    status: diagnostics.length === 0 ? "ok" : "error",
    diagnostics,
    layerSummaries: [
      {
        layerId: VT_LAYER_ID,
        layerType: VT_LAYER_TYPE,
        supportLevel: diagnostics.length === 0 ? "supported" : "unsupported",
        diagnosticCodes: diagnostics.map((d) => d.code),
        enabled: settings.enabled,
        families,
        nativeSupportedFamily: VT_SUPPORTED_FAMILY,
      },
    ],
    supportedFeatures,
    unsupportedFeatures,
  };
}
