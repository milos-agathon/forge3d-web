import type { CameraInput, SceneNodeId, SceneNodeInput } from "./index.js";
import type { Forge3DScene } from "./scene.js";
import { LabelFeatureSource } from "./label-features.js";
import type { LabelFeature, LabelFeatureOptions } from "./label-features.js";
import type { LabelPlan } from "./label-plan.js";
import { declutterLabels } from "./label-declutter.js";
import { Camera } from "./camera.js";
import { FontAtlas, TypographySettings } from "./typography.js";
import type {
  LabelDiagnostic,
  LabelLayerSnapshot,
  LabelOperationResult,
  LabelPoint,
  LabelRect,
  LabelStyleInput,
  TypographyInput,
  KeepoutRegionInput,
} from "./label-types.js";
import { labelDiagnostic } from "./label-diagnostics.js";
import { labelCase } from "./label-cases.js";
import {
  interpolateLabelLine,
  labelCoordinates,
  labelLineLength,
  labelLinePoints,
  labelRectsIntersect,
} from "./label-candidates.js";
import { labelStrokeMesh, shapedTextMesh, lineTextMesh } from "./label-mesh.js";
export class LabelFlags {
  underline = false;
  smallCaps = false;
  leader = false;
  constructor(input: Partial<LabelFlags> = {}) {
    Object.assign(this, input);
  }
}
export class LabelStyle {
  readonly value: Required<LabelStyleInput>;
  flags: LabelFlags;
  declare fontSize: number;
  declare color: [number, number, number, number];
  declare haloColor: [number, number, number, number];
  declare haloWidth: number;
  declare priority: number;
  declare minDepth: number;
  declare maxDepth: number;
  declare depthFade: number;
  declare minZoom: number;
  declare maxZoom: number;
  declare rotation: number;
  declare offset: [number, number];
  declare horizonFadeAngle: number;

  constructor(input: LabelStyleInput & { flags?: Partial<LabelFlags> } = {}) {
    this.value = {
      fontSize: input.fontSize ?? 14,
      minDepth: input.minDepth ?? 0,
      maxDepth: input.maxDepth ?? 1,
      depthFade: input.depthFade ?? 0,
      horizonFadeAngle: input.horizonFadeAngle ?? 5,
      color: [...(input.color ?? [0.1, 0.1, 0.1, 1])],
      haloColor: [...(input.haloColor ?? [1, 1, 1, 0.8])],
      haloWidth: input.haloWidth ?? 1.5,
      priority: input.priority ?? 0,
      offset: [...(input.offset ?? [0, 0])],
      minZoom: input.minZoom ?? 0,
      maxZoom: input.maxZoom ?? 3.4028235e38,
      depthTest: input.depthTest ?? false,
      horizonCull: input.horizonCull ?? true,
      underline: input.underline ?? false,
      smallCaps: input.smallCaps ?? false,
      leader: input.leader ?? false,
      rotation: input.rotation ?? 0,
      repeatDistance: input.repeatDistance ?? 0,
      placement: input.placement ?? "center",
    };
    const v = this.value;
    if (
      ![
        v.fontSize,
        v.minDepth,
        v.maxDepth,
        v.depthFade,
        v.horizonFadeAngle,
        v.haloWidth,
        v.priority,
        ...v.offset,
        v.minZoom,
        v.maxZoom,
        v.rotation,
        v.repeatDistance,
        ...v.color,
        ...v.haloColor,
      ].every(Number.isFinite) ||
      v.fontSize <= 0 ||
      v.fontSize > 4096 ||
      v.minDepth > v.maxDepth ||
      v.depthFade < 0 ||
      v.depthFade > 1 ||
      v.horizonFadeAngle < 0 ||
      v.haloWidth < 0 ||
      v.repeatDistance < 0 ||
      v.minZoom > v.maxZoom ||
      [...v.color, ...v.haloColor].some((n) => n < 0 || n > 1)
    )
      throw Error("Invalid label style");
    if (
      v.color.length !== 4 ||
      v.haloColor.length !== 4 ||
      v.offset.length !== 2 ||
      !Number.isInteger(v.priority) ||
      !["center", "along"].includes(v.placement)
    )
      throw Error("Invalid label style fields");
    this.flags = new LabelFlags({
      underline: v.underline,
      smallCaps: v.smallCaps,
      leader: v.leader,
      ...input.flags,
    });
    for (const key of [
      "fontSize",
      "color",
      "haloColor",
      "haloWidth",
      "priority",
      "minDepth",
      "maxDepth",
      "depthFade",
      "minZoom",
      "maxZoom",
      "rotation",
      "offset",
      "horizonFadeAngle",
    ] as const)
      Object.defineProperty(this, key, {
        enumerable: true,
        get: () => this.value[key],
        set: (next: unknown) => {
          const checked = new LabelStyle({ ...this.value, [key]: next });
          Object.assign(this.value, checked.value);
        },
      });
  }
  toString(): string {
    return `LabelStyle(size=${this.fontSize}, priority=${this.priority})`;
  }
  toJSON(): Required<LabelStyleInput> {
    return structuredClone({
      ...this.value,
      underline: this.flags.underline,
      smallCaps: this.flags.smallCaps,
      leader: this.flags.leader,
    });
  }
}
export interface LabelRenderOptions {
  viewport: { width: number; height: number };
  camera?: Camera | CameraInput;
  zoom?: number;
  keepouts?: readonly KeepoutRegionInput[];
  maxVertexBytes?: number;
  terrain?: {
    query(
      x: number,
      z: number,
    ): { height?: number; elevation?: number } | undefined;
  };
}
export interface LabelPlacementReport {
  accepted: number[];
  rejected: { id: number; reason: string }[];
  diagnostics: LabelDiagnostic[];
  glyphCount: number;
  vertexBytes: number;
  nodes: SceneNodeInput[];
}
type StoredLabel = LabelLayerSnapshot["labels"][number];
export class LabelLayer {
  readonly #atlas: FontAtlas;
  readonly #ownsAtlas: boolean;
  #labels = new Map<number, StoredLabel>();
  #next = 1;
  #enabled = true;
  #disposed = false;
  #revision = 0;
  #typography: TypographyInput = {};
  #algorithm: "greedy" | "annealing" = "greedy";
  #seed = 0;
  #iterations = 100;
  readonly #attachments = new Map<Forge3DScene, SceneNodeId[]>();
  readonly #changeListeners = new Set<() => void>();
  #pickBounds: { id: number; bounds: LabelRect }[] = [];
  constructor(atlas: FontAtlas, ownsAtlas = false) {
    this.#atlas = atlas;
    this.#ownsAtlas = ownsAtlas;
  }
  static fromFeatures(
    features: Iterable<LabelFeature>,
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    return LabelFeatureSource.fromFeatures(features, options);
  }
  static fromStyleLayer(
    features: Iterable<LabelFeature>,
    style: Parameters<typeof LabelFeatureSource.fromStyleLayer>[1],
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    return LabelFeatureSource.fromStyleLayer(features, style, options);
  }
  static fromRows(
    rows: Parameters<typeof LabelFeatureSource.fromRows>[0],
    options: LabelFeatureOptions = {},
  ): LabelFeatureSource {
    return LabelFeatureSource.fromRows(rows, options);
  }
  static async create(): Promise<LabelLayer> {
    return new LabelLayer(await FontAtlas.create(), true);
  }
  addChangeListener(listener: () => void): () => void {
    this.#assert();
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }
  #changed(): void {
    this.#revision++;
    for (const listener of this.#changeListeners) listener();
  }
  get revision(): number {
    return this.#revision;
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  get size(): number {
    return this.#labels.size;
  }
  addLabel(
    text: string,
    position: LabelPoint,
    style: LabelStyleInput = {},
  ): LabelOperationResult {
    this.#assert();
    if (!text.length)
      return this.#failure(
        "placeholder_fallback",
        { feature: "empty label text" },
        "pending",
      );
    const point = labelCoordinates(position);
    if (!point) throw Error("Label position must contain finite coordinates");
    const missing = this.#atlas.validateText(text);
    if (missing.length)
      return {
        ok: false,
        id: null,
        diagnostics: missing.map((d) =>
          labelDiagnostic("missing_glyphs", d.details),
        ),
      };
    if (this.#labels.size >= 10000 || this.#next >= Number.MAX_SAFE_INTEGER)
      throw Error("Label count or ID budget exceeded");
    const value = new LabelStyle(style).toJSON(),
      id = this.#next++;
    this.#labels.set(id, { id, text, position: point, style: value });
    this.#changed();
    return { ok: true, id, diagnostics: [] };
  }
  addPlan(
    plan: LabelPlan,
    style: LabelStyleInput = {},
  ): { ids: Record<string, number[]>; diagnostics: LabelDiagnostic[] } {
    this.#assert();
    const ids: Record<string, number[]> = Object.create(null),
      diagnostics = plan.diagnostics;
    for (const label of plan.accepted) {
      const candidates =
        label.geometry_type === "LineString"
          ? label.candidates
          : [label.candidate];
      ids[label.label_id] = [];
      for (const candidate of candidates) {
        const priority = style.priority ?? Math.round(candidate.score),
          anchor = labelCoordinates(candidate.details.anchor);
        const result =
          candidate.candidate_type === "leader_line" && anchor
            ? this.addCallout(label.text, anchor, {
                ...style,
                priority,
                offset: [
                  candidate.anchor[0] - anchor[0],
                  candidate.anchor[1] - anchor[1],
                ],
              })
            : this.addLabel(label.text, candidate.anchor, {
                ...style,
                priority,
              });
        if (result.id !== null) ids[label.label_id]!.push(result.id);
        diagnostics.push(...result.diagnostics);
      }
    }
    return { ids, diagnostics };
  }
  pick(x: number, y: number): number | null {
    this.#assert();
    if (!this.#enabled) return null;
    if (!Number.isFinite(x + y)) throw Error("Pick coordinates must be finite");
    return (
      [...this.#pickBounds]
        .reverse()
        .find(
          (p) =>
            x >= p.bounds[0] &&
            x <= p.bounds[2] &&
            y >= p.bounds[1] &&
            y <= p.bounds[3],
        )?.id ?? null
    );
  }
  addLabels(
    labels: readonly {
      text: string;
      position: LabelPoint;
      style?: LabelStyleInput;
    }[],
  ): { ids: (number | null)[]; diagnostics: LabelDiagnostic[] } {
    const ids: (number | null)[] = [],
      diagnostics: LabelDiagnostic[] = [];
    labels.forEach((l, i) => {
      const r = this.addLabel(l.text, l.position, l.style);
      ids.push(r.id);
      diagnostics.push(
        ...r.diagnostics.map((d) => ({ ...d, object_id: String(i) })),
      );
    });
    return { ids, diagnostics };
  }
  addLineLabel(
    text: string,
    path: LabelPoint[],
    style: LabelStyleInput = {},
    terrainMode?: string,
  ): LabelOperationResult {
    this.#assert();
    if (terrainMode && !["none", "flat"].includes(terrainMode)) {
      const c = labelCase("viewer-terrain-line");
      return this.#failure(c.code!, { feature: c.feature }, "pending");
    }
    if (!text.length)
      return this.#failure(
        "placeholder_fallback",
        { feature: "empty line label text" },
        "pending",
      );
    const missing = this.#atlas.validateText(text);
    if (missing.length)
      return {
        ok: false,
        id: null,
        diagnostics: missing.map((d) =>
          labelDiagnostic("missing_glyphs", d.details),
        ),
      };
    const points = labelLinePoints(path);
    if (!points || !labelLineLength(points))
      return this.#failure(
        "placeholder_fallback",
        { feature: "invalid line label path" },
        "pending",
      );
    const center = interpolateLabelLine(
        points,
        labelLineLength(points) / 2,
      ).point,
      result = this.addLabel(text, center, {
        ...style,
        placement: style.placement ?? "center",
      });
    if (result.id !== null) this.#labels.get(result.id)!.path = points;
    return result;
  }
  addCurvedLabel(_text: string, _path: LabelPoint[]): LabelOperationResult {
    this.#assert();
    const c = labelCase("viewer-curved");
    return this.#failure(c.code!, { feature: c.feature }, "pending");
  }
  addCallout(
    text: string,
    position: LabelPoint,
    style: LabelStyleInput = {},
  ): LabelOperationResult {
    this.#assert();
    if (!text.length)
      return this.#failure(
        "placeholder_fallback",
        { feature: "empty callout text" },
        "pending",
      );
    const r = this.addLabel(text, position, {
      ...style,
      leader: true,
      offset: style.offset ?? [24, -24],
    });
    if (r.id !== null) this.#labels.get(r.id)!.callout = true;
    return r;
  }
  updateLabel(
    id: number,
    patch: { text?: string; position?: LabelPoint; style?: LabelStyleInput },
  ): boolean {
    this.#assert();
    const old = this.#labels.get(id);
    if (!old) return false;
    const text = patch.text ?? old.text;
    if (!text.length || !this.#atlas.covers(text))
      throw Error("Updated label has empty text or missing glyphs");
    const position = patch.position
      ? labelCoordinates(patch.position)
      : old.position;
    if (!position) throw Error("Invalid label position");
    this.#labels.set(id, {
      ...old,
      text,
      position,
      style: new LabelStyle({ ...old.style, ...patch.style }).toJSON(),
    });
    this.#changed();
    return true;
  }
  removeLabel(id: number): LabelOperationResult {
    this.#assert();
    if (!this.#labels.delete(id))
      return this.#failure(
        "placeholder_fallback",
        { feature: "remove unknown label" },
        String(id),
      );
    this.#pickBounds = this.#pickBounds.filter((p) => p.id !== id);
    this.#changed();
    return { ok: true, id, diagnostics: [] };
  }
  clearLabels(): void {
    this.#assert();
    this.#labels.clear();
    this.#changed();
    for (const [scene, ids] of this.#attachments) {
      if (!scene.disposed) for (const id of ids) scene.removeNode(id);
    }
    this.#attachments.clear();
    this.#pickBounds = [];
  }
  setLabelsEnabled(enabled: boolean): void {
    this.#assert();
    if (typeof enabled !== "boolean") throw Error("enabled must be boolean");
    this.#enabled = enabled;
    this.#changed();
  }
  setTypography(input: TypographyInput): void {
    this.#assert();
    new TypographySettings(input);
    this.#typography = structuredClone(input);
    this.#changed();
  }
  setDeclutterAlgorithm(
    algorithm: "greedy" | "annealing",
    options: { seed?: number; maxIterations?: number } = {},
  ): void {
    this.#assert();
    if (
      !["greedy", "annealing"].includes(algorithm) ||
      !Number.isSafeInteger(options.seed ?? 0) ||
      (options.seed ?? 0) < 0 ||
      !Number.isSafeInteger(options.maxIterations ?? 100) ||
      (options.maxIterations ?? 100) < 1 ||
      (options.maxIterations ?? 100) > 10000
    )
      throw Error("Invalid declutter policy");
    this.#algorithm = algorithm;
    this.#seed = options.seed ?? 0;
    this.#iterations = options.maxIterations ?? 100;
    this.#changed();
  }
  snapshot(): LabelLayerSnapshot {
    this.#assert();
    return {
      version: 1,
      enabled: this.#enabled,
      nextId: this.#next,
      typography: structuredClone(this.#typography),
      declutter: {
        algorithm: this.#algorithm,
        seed: this.#seed,
        maxIterations: this.#iterations,
      },
      labels: structuredClone([...this.#labels.values()]),
    };
  }
  static fromJSON(
    atlas: FontAtlas,
    input: LabelLayerSnapshot | string,
  ): LabelLayer {
    const d =
      typeof input === "string"
        ? (JSON.parse(input) as LabelLayerSnapshot)
        : input;
    if (d.version !== 1 || !Number.isSafeInteger(d.nextId) || d.nextId < 1)
      throw Error("Invalid LabelLayer snapshot");
    const layer = new LabelLayer(atlas);
    for (const label of d.labels) {
      if (
        !Number.isSafeInteger(label.id) ||
        label.id < 1 ||
        label.id >= d.nextId ||
        layer.#labels.has(label.id)
      )
        throw Error("Invalid or duplicate label ID");
      if (
        !atlas.covers(label.text) ||
        !label.text.length ||
        !labelCoordinates(label.position)
      )
        throw Error("Invalid label snapshot contents");
      new LabelStyle(label.style);
      layer.#labels.set(label.id, structuredClone(label));
    }
    if (typeof d.enabled !== "boolean" || !Array.isArray(d.labels))
      throw Error("Invalid label snapshot state");
    layer.#enabled = d.enabled;
    layer.#next = d.nextId;
    if (d.typography) layer.setTypography(d.typography);
    if (d.declutter)
      layer.setDeclutterAlgorithm(d.declutter.algorithm, {
        seed: d.declutter.seed,
        maxIterations: d.declutter.maxIterations,
      });
    return layer;
  }
  render(options: LabelRenderOptions): LabelPlacementReport {
    this.#assert();
    const { width, height } = options.viewport;
    if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
      throw Error("Invalid label viewport");
    const camera =
      options.camera instanceof Camera
        ? options.camera
        : options.camera
          ? new Camera(options.camera)
          : undefined;
    const result: LabelPlacementReport = {
      accepted: [],
      rejected: [],
      diagnostics: [],
      glyphCount: 0,
      vertexBytes: 0,
      nodes: [],
    };
    const pickBounds: { id: number; bounds: LabelRect }[] = [];
    if (!this.#enabled) {
      this.#pickBounds = [];
      return result;
    }
    const budget = options.maxVertexBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw Error("Invalid label mesh budget");
    type Placement = {
      label: StoredLabel;
      text: string;
      style: Required<LabelStyleInput>;
      x: number;
      y: number;
      angle: number;
      rect: LabelRect;
      screen: { x: number; y: number; depth: number };
      mesh: Float32Array;
      glyphCount: number;
      advance: number;
    };
    const placements: Placement[] = [],
      eligible = new Set<number>();
    let candidateBytes = 0;
    const meshNode = (
      id: number,
      text: string,
      mesh: Float32Array,
      color: [number, number, number, number],
      depth: number,
      world: boolean,
    ): SceneNodeInput => {
      const vertices = new Float32Array(mesh);
      if (world && camera)
        for (let i = 0; i < vertices.length; i += 3) {
          const p = camera.screenToWorld(
            vertices[i]!,
            vertices[i + 1]!,
            depth,
            options.viewport,
          );
          vertices.set(p, i);
        }
      result.vertexBytes += (vertices.length / 3) * (world ? 72 : 28);
      if (result.vertexBytes > budget)
        throw Error("Label mesh byte budget exceeded");
      return world
        ? {
            kind: "text-mesh",
            name: `label-${id}`,
            text,
            size: 1,
            color,
            vertices,
          }
        : {
            kind: "overlay",
            name: `label-${id}`,
            bounds: [0, 0, width, height],
            color,
            vertices,
            zIndex: 1000,
          };
    };
    const sorted = [...this.#labels.values()].sort(
      (a, b) =>
        (b.style.priority ?? 0) - (a.style.priority ?? 0) || a.id - b.id,
    );
    for (const label of sorted) {
      const style = new LabelStyle(label.style).value,
        zoom = options.zoom ?? 1;
      if (zoom < style.minZoom || zoom > style.maxZoom) {
        result.rejected.push({ id: label.id, reason: "outside_zoom" });
        continue;
      }
      if (style.depthTest && !camera)
        throw Error("Depth-tested labels require a camera");
      const text = style.smallCaps ? label.text.toUpperCase() : label.text,
        shape = this.#atlas.shape(text, {
          ...this.#typography,
          fontSize: style.fontSize,
          ...(label.path ? { multiline: false } : {}),
        });
      if (shape.diagnostics.length) {
        result.diagnostics.push(...shape.diagnostics);
        result.rejected.push({ id: label.id, reason: "missing_glyph" });
        continue;
      }
      let point = label.position;
      if (options.terrain) {
        const sample = options.terrain.query(point[0], point[2]);
        if (!sample) {
          result.rejected.push({ id: label.id, reason: "terrain_occluded" });
          continue;
        }
        point = [
          point[0],
          sample.height ?? sample.elevation ?? point[1],
          point[2],
        ];
      }
      const projected = camera?.worldToScreen(point, options.viewport),
        screen = camera
          ? projected
          : { x: point[0], y: point[1], depth: point[2] };
      if (
        !screen ||
        (style.horizonCull && (screen.depth < 0 || screen.depth > 1) && camera)
      ) {
        result.rejected.push({ id: label.id, reason: "outside_view" });
        continue;
      }
      if (camera) {
        if (screen.depth < style.minDepth || screen.depth > style.maxDepth) {
          result.rejected.push({ id: label.id, reason: "outside_depth" });
          continue;
        }
        const eye = camera.toJSON().position,
          dx = point[0] - eye[0],
          dy = point[1] - eye[1],
          dz = point[2] - eye[2],
          horizon = Math.abs(
            (Math.atan(dy / Math.max(0.001, Math.hypot(dx, dz))) * 180) /
              Math.PI,
          ),
          alpha =
            style.horizonCull && style.horizonFadeAngle > 0
              ? Math.min(1, horizon / style.horizonFadeAngle)
              : 1;
        style.color[3] *= alpha * (1 - style.depthFade * screen.depth);
        style.haloColor[3] *= alpha * (1 - style.depthFade * screen.depth);
        if (alpha === 0) {
          result.rejected.push({ id: label.id, reason: "horizon_culled" });
          continue;
        }
      }
      const path = label.path?.map((p) => {
        const q = camera?.worldToScreen(p, options.viewport);
        return camera
          ? q
            ? ([q.x, q.y, q.depth] as LabelPoint)
            : undefined
          : ([...p] as LabelPoint);
      });
      if (path?.some((p) => !p)) {
        result.rejected.push({ id: label.id, reason: "outside_view" });
        continue;
      }
      // Placement length is screen arclength, independent of projected depth.
      const points = (path as LabelPoint[] | undefined)?.map(
          (p): LabelPoint => [p[0], p[1], 0],
        ),
        length = points ? labelLineLength(points) : 0,
        advance = shape.glyphs.reduce((sum, g) => sum + g.xAdvance, 0),
        repeat = style.repeatDistance;
      if (points && advance > length * 0.9) {
        result.rejected.push({ id: label.id, reason: "line_too_short" });
        continue;
      }
      const distances =
        points && repeat > 0
          ? Array.from(
              { length: Math.min(10000, Math.floor(length / repeat) + 1) },
              (_, i) => i * repeat,
            ).filter((d) => d >= advance / 2 && d <= length - advance / 2)
          : [length / 2];
      const block = points ? undefined : shapedTextMesh(shape);
      let hasInk = false,
        onScreen = false,
        unblocked = false;
      for (const distance of distances) {
        const location = points
          ? interpolateLabelLine(points, distance)
          : {
              point: [screen.x, screen.y, screen.depth] as LabelPoint,
              angle: style.rotation,
            };
        const x = location.point[0] + style.offset[0],
          y = location.point[1] + style.offset[1],
          rawAngle = points ? location.angle : style.rotation,
          angle = points
            ? rawAngle > Math.PI / 2
              ? rawAngle - Math.PI
              : rawAngle < -Math.PI / 2
                ? rawAngle + Math.PI
                : rawAngle
            : rawAngle;
        const mesh = points
          ? lineTextMesh(shape, points, distance)
          : new Float32Array(block!);
        if (!mesh.length) continue;
        hasInk = true;
        const c = Math.cos(angle),
          sin = Math.sin(angle);
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let i = 0; i < mesh.length; i += 3) {
          const a = mesh[i]!,
            b = -mesh[i + 1]!;
          const px = points ? a + style.offset[0] : x + c * a - sin * b;
          const py = points ? -b + style.offset[1] : y + sin * a + c * b;
          mesh[i] = px;
          mesh[i + 1] = py;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
        }
        candidateBytes += mesh.byteLength;
        if (candidateBytes > budget)
          throw Error("Label candidate mesh byte budget exceeded");
        const rect: LabelRect = [
          x0 - style.haloWidth,
          y0 - style.haloWidth,
          x1 + style.haloWidth,
          y1 + style.haloWidth,
        ];
        if (rect[2] < 0 || rect[0] > width || rect[3] < 0 || rect[1] > height)
          continue;
        onScreen = true;
        if (options.keepouts?.some((k) => labelRectsIntersect(rect, k.bounds)))
          continue;
        unblocked = true;
        eligible.add(label.id);
        if (placements.length >= 10000)
          throw Error("Label placement budget exceeded");
        placements.push({
          label,
          text,
          style,
          x,
          y,
          angle,
          rect,
          screen: screen!,
          mesh,
          glyphCount: shape.glyphs.length,
          advance: shape.width,
        });
      }
      if (!unblocked)
        result.rejected.push({
          id: label.id,
          reason: !hasInk
            ? "empty_glyphs"
            : !onScreen
              ? distances.length
                ? "outside_view"
                : "line_too_short"
              : "keepout_region",
        });
    }
    // Each repeated instance has its own collision ID. The solver optimizes the
    // complete candidate set, using the native f32 energy and seeded annealing.
    const solved = declutterLabels(
      placements.map((p, i) => ({
        labelId: i,
        position: [p.x, p.y],
        bounds: p.rect,
        priority: p.style.priority,
      })),
      {
        algorithm: this.#algorithm,
        seed: this.#seed,
        maxIterations: this.#iterations,
      },
    );
    const visible = new Set(solved.visibleLabels),
      accepted = new Set<number>();
    for (const [index, p] of placements.entries()) {
      if (!visible.has(index)) continue;
      const { label, text, style, screen, x, y, angle } = p,
        c = Math.cos(angle),
        s = Math.sin(angle),
        mesh = new Float32Array(p.mesh);
      const world = style.depthTest && camera !== undefined;
      if (style.leader || label.callout) {
        const leader = labelStrokeMesh(
          [
            [screen.x, screen.y],
            [x, y],
          ],
          1.5,
        );
        if (leader.length)
          result.nodes.push(
            meshNode(label.id, text, leader, style.color, screen.depth, world),
          );
      }
      if (style.haloWidth > 0)
        for (const [dx, dy] of [
          [-style.haloWidth, 0],
          [style.haloWidth, 0],
          [0, -style.haloWidth],
          [0, style.haloWidth],
        ]) {
          const halo = new Float32Array(mesh);
          for (let i = 0; i < halo.length; i += 3) {
            halo[i] = halo[i]! + dx!;
            halo[i + 1] = halo[i + 1]! + dy!;
          }
          result.nodes.push(
            meshNode(
              label.id,
              text,
              halo,
              style.haloColor,
              screen.depth,
              world,
            ),
          );
        }
      result.nodes.push(
        meshNode(label.id, text, mesh, style.color, screen.depth, world),
      );
      if (style.underline) {
        const underline = labelStrokeMesh(
          [
            [x - 2 * s, y + 2 * c],
            [x + p.advance * c - 2 * s, y + p.advance * s + 2 * c],
          ],
          Math.max(1, style.fontSize / 16),
        );
        if (underline.length)
          result.nodes.push(
            meshNode(
              label.id,
              text,
              underline,
              style.color,
              screen.depth,
              world,
            ),
          );
      }
      result.glyphCount += p.glyphCount;
      accepted.add(label.id);
      pickBounds.push({ id: label.id, bounds: p.rect });
    }
    for (const label of sorted) {
      if (accepted.has(label.id)) result.accepted.push(label.id);
      else if (eligible.has(label.id))
        result.rejected.push({ id: label.id, reason: "collision" });
    }
    this.#pickBounds = pickBounds;
    return result;
  }
  attach(
    scene: Forge3DScene,
    options: LabelRenderOptions,
  ): LabelPlacementReport {
    const report = this.render(options),
      old = this.#attachments.get(scene) ?? [],
      ids: SceneNodeId[] = [];
    try {
      for (const node of report.nodes) ids.push(scene.addNode(node));
    } catch (error) {
      for (const id of ids) scene.removeNode(id);
      throw error;
    }
    for (const id of old) scene.removeNode(id);
    this.#attachments.set(scene, ids);
    return report;
  }
  detach(scene: Forge3DScene): void {
    const ids = this.#attachments.get(scene) ?? [];
    if (!scene.disposed) for (const id of ids) scene.removeNode(id);
    this.#attachments.delete(scene);
  }
  memoryReport(): {
    labels: number;
    cpuBytes: number;
    ownedFontBytes: number;
    disposed: boolean;
  } {
    return {
      labels: this.#labels.size,
      cpuBytes: this.#disposed ? 0 : JSON.stringify(this.snapshot()).length * 2,
      ownedFontBytes: this.#ownsAtlas
        ? this.#atlas.memoryReport().fontBytes
        : 0,
      disposed: this.#disposed,
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.clearLabels();
    if (this.#ownsAtlas) this.#atlas.dispose();
    this.#disposed = true;
    this.#changeListeners.clear();
  }
  #failure(
    code: string,
    details: Record<string, unknown>,
    id: string,
  ): LabelOperationResult {
    return {
      ok: false,
      id: null,
      diagnostics: [labelDiagnostic(code, details, id)],
    };
  }
  #assert(): void {
    if (this.#disposed) throw Error("LabelLayer is disposed");
  }
}
export { LabelLayer as LabelManager };
