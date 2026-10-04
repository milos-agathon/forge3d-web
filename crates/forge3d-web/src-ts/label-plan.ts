import type {
  AcceptedLabel,
  LabelCandidate,
  LabelDiagnostic,
  LabelPlanData,
  LabelPlanOptions,
  LabelPoint,
  LabelRecord,
  LabelRejectionReason,
  KeepoutRegionInput,
  PriorityClassInput,
  RejectedLabel,
} from "./label-types.js";
import {
  labelCompare,
  labelDiagnostic,
  stableLabelJson,
} from "./label-diagnostics.js";
import {
  labelCoordinates,
  labelLinePoints,
  labelRect,
  labelRectsIntersect,
  lineLabelCandidates,
  pointLabelCandidates,
  polygonLabelCandidates,
} from "./label-candidates.js";
import { labelCase } from "./label-cases.js";
export const LABEL_REJECTION_REASONS: readonly LabelRejectionReason[] = [
  "collision",
  "outside_view",
  "missing_glyph",
  "priority_lost",
  "keepout_region",
  "terrain_occluded",
  "invalid_geometry",
  "unsupported_geometry_type",
  "empty_text",
];
export class KeepoutRegion implements KeepoutRegionInput {
  readonly region_id: string;
  readonly kind: string;
  readonly bounds: [number, number, number, number];
  readonly priority: number;
  constructor(input: KeepoutRegionInput) {
    if (
      !input.region_id ||
      !input.kind ||
      input.bounds.length !== 4 ||
      !input.bounds.every(Number.isFinite)
    )
      throw Error("Invalid label keepout");
    this.region_id = input.region_id;
    this.kind = input.kind;
    this.bounds = labelRect(input.bounds);
    this.priority = input.priority ?? 0;
  }
  toJSON(): Required<KeepoutRegionInput> {
    return {
      region_id: this.region_id,
      kind: this.kind,
      bounds: [...this.bounds],
      priority: this.priority,
    };
  }
}
export class PriorityClass implements PriorityClassInput {
  readonly name: string;
  readonly rank: number;
  readonly tie_break_policy: string;
  constructor(input: PriorityClassInput) {
    if (!input.name || !Number.isSafeInteger(input.rank))
      throw Error("Invalid label priority");
    this.name = input.name;
    this.rank = input.rank;
    this.tie_break_policy = input.tie_break_policy ?? "stable_ordering_key";
  }
  toJSON(): Required<PriorityClassInput> {
    return {
      name: this.name,
      rank: this.rank,
      tie_break_policy: this.tie_break_policy,
    };
  }
}
function sampleTerrain(
  record: LabelRecord,
  terrain: LabelPlanOptions["terrain"],
  id: string,
  coords?: LabelPoint,
): Record<string, unknown> {
  if (record.terrain_sample) return structuredClone(record.terrain_sample);
  if (record.terrain) return structuredClone(record.terrain);
  if (terrain && typeof terrain === "object") {
    const map = terrain as Record<string, unknown>,
      samples = map.samples as Record<string, unknown> | undefined,
      value = samples?.[id] ?? map[id];
    if (value && typeof value === "object")
      return structuredClone(value) as Record<string, unknown>;
  }
  if (
    coords &&
    (record.requires_terrain ||
      ["required", "sample", "terrain"].includes(record.terrain_mode ?? ""))
  ) {
    if (!terrain)
      return { source: "terrain_sampler", unavailable: true, visible: false };
    if ("sample" in terrain && typeof terrain.sample === "function") {
      const value = terrain.sample(...coords);
      return typeof value === "number"
        ? { elevation: value, source: "terrain_sampler", visible: true }
        : structuredClone(value);
    }
    return { source: "terrain_sampler", unavailable: true, visible: false };
  }
  return {};
}
export class LabelPlan {
  readonly #data: LabelPlanData;
  constructor(input: LabelPlanData) {
    if (input.payload_version !== 1)
      throw Error("Unsupported LabelPlan payload version");
    if (!Number.isSafeInteger(input.seed))
      throw Error("Invalid LabelPlan seed");
    const d = structuredClone(input);
    for (const r of d.rejected)
      if (!LABEL_REJECTION_REASONS.includes(r.reason))
        throw Error(`Unknown label rejection reason: ${r.reason}`);
    d.accepted.sort((a, b) => labelCompare(a.ordering_key, b.ordering_key));
    d.rejected.sort((a, b) => labelCompare(a.ordering_key, b.ordering_key));
    d.diagnostics.sort(
      (a, b) =>
        (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1) ||
        labelCompare(a.code, b.code) ||
        labelCompare(a.layer_id ?? "", b.layer_id ?? "") ||
        labelCompare(a.object_id ?? "", b.object_id ?? "") ||
        labelCompare(a.message, b.message) ||
        labelCompare(stableLabelJson(a.details), stableLabelJson(b.details)),
    );
    this.#data = d;
  }
  get accepted(): AcceptedLabel[] {
    return structuredClone(this.#data.accepted);
  }
  get rejected(): RejectedLabel[] {
    return structuredClone(this.#data.rejected);
  }
  get diagnostics(): LabelDiagnostic[] {
    return structuredClone(this.#data.diagnostics);
  }
  get bounds(): LabelPlanData["bounds"] {
    return structuredClone(this.#data.bounds);
  }
  get seed(): number {
    return this.#data.seed;
  }
  static compile(options: LabelPlanOptions): LabelPlan {
    const seed = options.seed ?? 0,
      viewport = Array.isArray(options.viewport)
        ? options.viewport
        : [options.viewport.width, options.viewport.height];
    if (
      !viewport.every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isSafeInteger(seed)
    )
      throw Error("Invalid label viewport or seed");
    const keepouts = (options.keepouts ?? []).map((k) =>
      new KeepoutRegion(k).toJSON(),
    );
    const priority: PriorityClassInput[] =
      options.priority_rules === "cartographic"
        ? ["annotations", "roads", "rivers", "peaks", "cities", "capitals"].map(
            (name, i) => ({ name, rank: (i + 1) * 10 }),
          )
        : (options.priority_rules ?? []).map((p) =>
            new PriorityClass(p).toJSON(),
          );
    const ranks = new Map(priority.map((p) => [p.name, p.rank]));
    const rawAtlas = options.glyph_atlas,
      atlas = rawAtlas
        ? new Set<string>(
            Array.isArray(rawAtlas)
              ? rawAtlas
              : (rawAtlas as { glyphs: readonly string[] }).glyphs,
          )
        : undefined;
    const entries: [string, LabelRecord][] = Array.isArray(options.labels)
      ? (options.labels as readonly LabelRecord[]).map((r, i) => [String(i), r])
      : Object.entries(options.labels as Record<string, LabelRecord>).map(
          ([id, r]) => [id, { id, ...r }],
        );
    if (entries.length > 100000) throw Error("Label count exceeds 100000");
    const records = entries.sort(
      ([ka, a], [kb, b]) =>
        labelCompare(String(a.id ?? ka), String(b.id ?? kb)) ||
        labelCompare(a.geometry?.type ?? "", b.geometry?.type ?? "") ||
        labelCompare(a.text, b.text),
    );
    const proposed: AcceptedLabel[] = [],
      rejected: RejectedLabel[] = [],
      diagnostics: LabelDiagnostic[] = [];
    const ids = new Set<string>();
    for (const [fallback, r] of records) {
      const id = String(r.id ?? fallback),
        source = r.source_id ?? id,
        text = r.text,
        key = `${id}:${source}:${stableLabelJson(r)}`;
      if (ids.has(id)) throw Error(`Duplicate label ID: ${id}`);
      ids.add(id);
      const reject = (
        reason: LabelRejectionReason,
        details: Record<string, unknown> = {},
        candidate?: LabelCandidate,
        refs: string[] = [],
      ) =>
        rejected.push({
          label_id: id,
          source_id: source,
          reason,
          candidate_id: candidate?.candidate_id ?? null,
          diagnostic_refs: refs,
          ordering_key: key,
          details,
        });
      if (!text.trim()) {
        reject("empty_text");
        continue;
      }
      if (
        /[\u0590-\u08ff\u0900-\u0dff\ufb50-\ufdff\ufe70-\ufeff]/u.test(text) &&
        !options.fontAtlas
      ) {
        const c = labelCase("plan-complex-unshaped");
        diagnostics.push(labelDiagnostic(c.code!, { feature: c.feature }, id));
        reject(c.reason!, { shaping: "complex_script" }, undefined, [c.code!]);
        continue;
      }
      const missing: string[] = atlas
        ? [...new Set(Array.from(text).filter((c) => !atlas.has(c)))].sort(
            labelCompare,
          )
        : options.fontAtlas
          ? Array.from(text).filter((c) => !options.fontAtlas!.covers(c))
          : [];
      if (missing.length) {
        const glyphs = [...new Set(missing)].sort(labelCompare);
        diagnostics.push(
          labelDiagnostic(
            "missing_glyphs",
            { count: glyphs.length, missing_glyphs: glyphs },
            id,
          ),
        );
        reject("missing_glyph", { missing_glyphs: glyphs }, undefined, [
          "missing_glyphs",
        ]);
        continue;
      }
      const type = r.geometry?.type ?? r.geometry_type ?? "Point",
        t = type.toLowerCase();
      let sample = sampleTerrain(r, options.terrain, id),
        candidate: LabelCandidate,
        candidates: LabelCandidate[],
        screen: [number, number, number, number],
        world: [number, number, number, number, number, number];
      if (r.curved_text || r.placement_preset === "curved") {
        const c = labelCase("plan-curved");
        diagnostics.push(labelDiagnostic(c.code!, { feature: c.feature }, id));
        reject(c.reason!, { placement: "curved_text" }, undefined, [c.code!]);
        continue;
      }
      if (
        t === "linestring" &&
        (r.requires_terrain ||
          ["required", "sample", "terrain"].includes(r.terrain_mode ?? ""))
      ) {
        const c = labelCase("plan-terrain-line");
        diagnostics.push(labelDiagnostic(c.code!, { feature: c.feature }, id));
        reject(
          c.reason!,
          { terrain_mode: r.terrain_mode ?? "required" },
          undefined,
          [c.code!],
        );
        continue;
      }
      const score =
        (ranks.get(r.priority_class ?? "default") ?? 0) * 1e6 +
        (r.priority ?? 0);
      if (!Number.isFinite(score)) throw Error("Label priority must be finite");
      if (t === "point") {
        let p = labelCoordinates(
          r.geometry?.coordinates ?? r.position ?? r.world_pos,
        );
        if (!p) {
          reject("invalid_geometry");
          continue;
        }
        sample = sampleTerrain(r, options.terrain, id, p);
        if (sample.visible !== false && sample.elevation !== undefined) {
          const z = Number(sample.elevation);
          if (!Number.isFinite(z))
            throw Error("Terrain label elevation must be finite");
          p = [p[0], p[1], z];
        }
        candidates = pointLabelCandidates(id, p, score, key, r, seed, sample);
        candidate = candidates[0]!;
        screen = [p[0], p[1], p[0], p[1]];
        world = [...p, ...p];
      } else if (t === "linestring") {
        if (
          r.repeat_distance === undefined &&
          !["road", "river", "line"].includes(r.placement_preset ?? "")
        ) {
          reject(labelCase("plan-flat-unconfigured").reason!, {
            geometry_type: type,
          });
          continue;
        }
        const points = labelLinePoints(r.geometry?.coordinates);
        candidates = points
          ? lineLabelCandidates(id, points, score, key, r, sample)
          : [];
        if (!points || !candidates.length) {
          reject("invalid_geometry");
          continue;
        }
        candidate = candidates[0]!;
        const xs = points.map((p) => p[0]),
          ys = points.map((p) => p[1]),
          z = candidate.anchor[2];
        screen = [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ];
        world = [screen[0], screen[1], z, screen[2], screen[3], z];
      } else if (t === "polygon") {
        const poly = polygonLabelCandidates(
          id,
          r.geometry?.coordinates,
          score,
          key,
          sample,
        );
        if (!poly) {
          reject("invalid_geometry");
          continue;
        }
        candidate = poly.selected;
        candidates = poly.candidates;
        screen = [...candidate.bounds];
        world = [...candidate.anchor, ...candidate.anchor];
      } else {
        reject("unsupported_geometry_type", { geometry_type: type });
        continue;
      }
      const [x, y] = candidate.anchor;
      if (x < 0 || y < 0 || x > viewport[0]! || y > viewport[1]!) {
        reject("outside_view", { viewport });
        continue;
      }
      if (sample.visible === false) {
        const refs = ["label_rejection_summary"];
        if (sample.unavailable === true) {
          diagnostics.push(
            labelDiagnostic(
              "placeholder_fallback",
              { feature: "terrain_sampler" },
              id,
            ),
          );
          refs.push("placeholder_fallback");
        }
        reject("terrain_occluded", { terrain_sample: sample }, candidate, refs);
        continue;
      }
      const keepout = keepouts.find((k) =>
        labelRectsIntersect(screen, k.bounds),
      );
      if (keepout) {
        reject(
          "keepout_region",
          {
            keepout_bounds: keepout.bounds,
            keepout_kind: keepout.kind,
            keepout_region_id: keepout.region_id,
          },
          candidate,
        );
        continue;
      }
      candidates.sort((a, b) => labelCompare(a.ordering_key, b.ordering_key));
      proposed.push({
        label_id: id,
        source_id: source,
        text,
        geometry_type: type,
        candidate,
        candidates,
        priority_class: r.priority_class ?? "default",
        screen_bounds: screen,
        world_bounds: world,
        typography: structuredClone(options.typography ?? r.typography ?? {}),
        glyphs: Array.from(text),
        ordering_key: key,
      });
    }
    const winners: AcceptedLabel[] = [];
    for (const label of proposed.sort(
      (a, b) =>
        b.candidate.score - a.candidate.score ||
        labelCompare(a.ordering_key, b.ordering_key),
    )) {
      const winner = winners.find((w) =>
        labelRectsIntersect(label.screen_bounds, w.screen_bounds),
      );
      if (!winner) {
        winners.push(label);
        continue;
      }
      rejected.push({
        label_id: label.label_id,
        source_id: label.source_id,
        reason:
          label.candidate.score < winner.candidate.score
            ? "priority_lost"
            : "collision",
        candidate_id: label.candidate.candidate_id,
        diagnostic_refs: ["label_rejection_summary"],
        ordering_key: label.ordering_key,
        details: {
          collides_with: winner.label_id,
          candidate_bounds: label.screen_bounds,
          winner_bounds: winner.screen_bounds,
          candidate_priority: label.candidate.score,
          candidate_priority_class: label.priority_class,
          winner_priority: winner.candidate.score,
          winner_priority_class: winner.priority_class,
        },
      });
    }
    if (rejected.length) {
      const counts: Record<string, number> = {};
      for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
      diagnostics.push(
        labelDiagnostic("label_rejection_summary", {
          rejection_counts: counts,
          total: rejected.length,
        }),
      );
    }
    const screen = winners.length
      ? ([
          Math.min(...winners.map((a) => a.screen_bounds[0])),
          Math.min(...winners.map((a) => a.screen_bounds[1])),
          Math.max(...winners.map((a) => a.screen_bounds[2])),
          Math.max(...winners.map((a) => a.screen_bounds[3])),
        ] as [number, number, number, number])
      : null;
    const world = winners.length
      ? (Array.from({ length: 6 }, (_, i) =>
          i < 3
            ? Math.min(...winners.map((a) => a.world_bounds[i]!))
            : Math.max(...winners.map((a) => a.world_bounds[i]!)),
        ) as [number, number, number, number, number, number])
      : null;
    return new LabelPlan({
      payload_version: 1,
      seed,
      accepted: winners,
      rejected,
      diagnostics,
      bounds: {
        screen,
        world,
        keepouts: keepouts.sort(
          (a, b) =>
            a.priority - b.priority ||
            labelCompare(a.kind, b.kind) ||
            labelCompare(a.region_id, b.region_id),
        ),
        priority_rules: priority.sort(
          (a, b) => a.rank - b.rank || labelCompare(a.name, b.name),
        ),
      },
    });
  }
  toJSON(): LabelPlanData {
    return structuredClone(this.#data);
  }
  serialize(): string {
    return stableLabelJson(this.#data);
  }
  static fromJSON(input: LabelPlanData | string): LabelPlan {
    return new LabelPlan(
      typeof input === "string" ? (JSON.parse(input) as LabelPlanData) : input,
    );
  }
  toRenderPayload(
    backend = "label_plan",
  ): LabelPlanData & { kind: string; backend: string; supported: boolean } {
    return this.#payload("label_plan_render_payload", backend, [
      "default",
      "label_plan",
      "software",
      "webgpu",
    ]);
  }
  toExportPayload(
    backend = "label_plan",
  ): LabelPlanData & { kind: string; backend: string; supported: boolean } {
    return this.#payload("label_plan_export_payload", backend, [
      "default",
      "json",
      "label_plan",
    ]);
  }
  #payload(kind: string, backend: string, supported: string[]) {
    const data = this.toJSON(),
      ok = supported.includes(backend);
    if (!ok)
      data.diagnostics.push(
        labelDiagnostic("placeholder_fallback", {
          feature: `${kind}:${backend}`,
        }),
      );
    return { ...data, kind, backend, supported: ok };
  }
}
