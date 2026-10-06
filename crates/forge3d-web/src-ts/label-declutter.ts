import type { LabelRect } from "./label-types.js";
import { labelRect, labelRectsIntersect } from "./label-candidates.js";
export interface LabelDeclutterCandidate {
  labelId: number;
  position: [number, number];
  bounds: LabelRect;
  priority: number;
  cost?: number;
  selected?: boolean;
}
export interface LabelDeclutterConfig {
  algorithm?: "greedy" | "annealing";
  maxIterations?: number;
  initialTemperature?: number;
  coolingRate?: number;
  overlapWeight?: number;
  priorityWeight?: number;
  distanceWeight?: number;
  seed?: number;
  margin?: number;
}
export interface LabelDeclutterResult {
  visibleLabels: number[];
  positions: [number, [number, number]][];
  totalEnergy: number;
  iterations: number;
}
/** Browser spatial equivalent of native collision/RTree queries. Huge boxes
 * occupy the broad list instead of creating an unbounded number of grid cells. */
export class LabelCollisionIndex {
  readonly #cells = new Map<string, Set<number>>();
  readonly #bounds = new Map<number, LabelRect>();
  readonly #broad = new Set<number>();
  readonly cellSize: number;
  constructor(cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0)
      throw Error("Invalid collision cell size");
    this.cellSize = cellSize;
  }
  #keys(rect: LabelRect): string[] | undefined {
    const x0 = Math.floor(rect[0] / this.cellSize),
      x1 = Math.floor(rect[2] / this.cellSize),
      y0 = Math.floor(rect[1] / this.cellSize),
      y1 = Math.floor(rect[3] / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return;
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
    return keys;
  }
  insert(id: number, bounds: LabelRect): void {
    if (!Number.isSafeInteger(id) || !bounds.every(Number.isFinite))
      throw Error("Invalid collision bounds");
    if (this.#bounds.has(id)) throw Error("Duplicate collision ID");
    const r = labelRect(bounds);
    this.#bounds.set(id, r);
    const keys = this.#keys(r);
    if (!keys) {
      this.#broad.add(id);
      return;
    }
    for (const key of keys) {
      let cell = this.#cells.get(key);
      if (!cell) {
        cell = new Set();
        this.#cells.set(key, cell);
      }
      cell.add(id);
    }
  }
  query(bounds: LabelRect, margin = 0): number[] {
    if (
      !Number.isFinite(margin) ||
      margin < 0 ||
      !bounds.every(Number.isFinite)
    )
      throw Error("Invalid collision query");
    const b = labelRect(bounds),
      r: LabelRect = [
        b[0] - margin,
        b[1] - margin,
        b[2] + margin,
        b[3] + margin,
      ],
      keys = this.#keys(r),
      ids = new Set(this.#broad);
    if (keys)
      for (const key of keys)
        for (const id of this.#cells.get(key) ?? []) ids.add(id);
    else for (const id of this.#bounds.keys()) ids.add(id);
    return [...ids]
      .filter((id) => labelRectsIntersect(r, this.#bounds.get(id)!))
      .sort((a, b) => a - b);
  }
  clear(): void {
    this.#bounds.clear();
    this.#cells.clear();
    this.#broad.clear();
  }
  memoryReport(): { entries: number; cells: number; estimatedBytes: number } {
    return {
      entries: this.#bounds.size,
      cells: this.#cells.size,
      estimatedBytes:
        this.#bounds.size * 48 +
        [...this.#cells.values()].reduce((n, c) => n + c.size * 8, 0),
    };
  }
}
/** Native energy, LCG and cooling schedule, evaluated as f32. Seeded choices
 * use native 64-bit indices, preserving the monolithic reference's behavior. */
export function declutterLabels(
  input: readonly LabelDeclutterCandidate[],
  options: LabelDeclutterConfig = {},
): LabelDeclutterResult {
  const cfg = {
    algorithm: options.algorithm ?? "greedy",
    maxIterations: options.maxIterations ?? 1000,
    initialTemperature: options.initialTemperature ?? 100,
    coolingRate: options.coolingRate ?? 0.95,
    overlapWeight: options.overlapWeight ?? 10,
    priorityWeight: options.priorityWeight ?? 1,
    distanceWeight: options.distanceWeight ?? 0.5,
    seed: options.seed ?? 42,
    margin: options.margin ?? 2,
  };
  if (
    input.length > 10000 ||
    !Number.isSafeInteger(cfg.maxIterations) ||
    cfg.maxIterations < 1 ||
    cfg.maxIterations > 10000 ||
    !Number.isSafeInteger(cfg.seed) ||
    cfg.seed < 0 ||
    !["greedy", "annealing"].includes(cfg.algorithm) ||
    ![
      cfg.initialTemperature,
      cfg.coolingRate,
      cfg.overlapWeight,
      cfg.priorityWeight,
      cfg.distanceWeight,
      cfg.margin,
    ].every(Number.isFinite) ||
    cfg.initialTemperature <= 0 ||
    cfg.coolingRate <= 0 ||
    cfg.coolingRate >= 1 ||
    cfg.margin < 0
  )
    throw Error("Invalid declutter configuration");
  const candidates = input.map((c) => ({
    ...c,
    position: [...c.position] as [number, number],
    bounds: labelRect(c.bounds),
    cost: c.cost ?? 0,
    selected: false,
  }));
  if (
    candidates.some(
      (c) =>
        !Number.isSafeInteger(c.labelId) ||
        ![c.priority, c.cost, ...c.position, ...c.bounds].every(
          Number.isFinite,
        ),
    )
  )
    throw Error("Invalid declutter candidate");
  const f = Math.fround;
  for (const c of candidates) {
    c.bounds = c.bounds.map(f) as LabelRect;
    c.priority = f(c.priority);
    c.cost = f(c.cost);
  }
  const energy = () => {
    const selected = candidates.filter((c) => c.selected);
    let e = 0;
    for (let i = 0; i < selected.length; i++)
      for (let j = i + 1; j < selected.length; j++) {
        const a = selected[i]!.bounds,
          b = selected[j]!.bounds,
          x = f(Math.max(0, f(Math.min(a[2], b[2]) - Math.max(a[0], b[0])))),
          y = f(Math.max(0, f(Math.min(a[3], b[3]) - Math.max(a[1], b[1]))));
        e = f(e + f(f(x * y) * cfg.overlapWeight));
      }
    for (const c of selected) e = f(e - f(c.priority * cfg.priorityWeight));
    for (const c of selected) e = f(e + f(c.cost * cfg.distanceWeight));
    return e;
  };
  const index = new LabelCollisionIndex();
  for (const c of [...candidates].sort((a, b) => b.priority - a.priority)) {
    if (!index.query(c.bounds, cfg.margin).length) {
      c.selected = true;
      index.insert(c.labelId, c.bounds);
    }
  }
  let best = candidates.map((c) => c.selected),
    currentEnergy = energy(),
    bestEnergy = currentEnergy,
    iterations = cfg.algorithm === "greedy" ? 1 : candidates.length ? 1 : 0;
  if (cfg.algorithm === "annealing" && candidates.length) {
    let state = BigInt(cfg.seed),
      temperature = f(cfg.initialTemperature);
    const random = () =>
      (state = BigInt.asUintN(64, state * 6364136223846793005n + 1n));
    for (let i = 0; i < cfg.maxIterations; i++) {
      const pos = Number(random() % BigInt(candidates.length)),
        c = candidates[pos]!;
      c.selected = !c.selected;
      const next = energy(),
        delta = f(next - currentEnergy),
        accept =
          delta < 0 ||
          f(f(Number(random())) / f(Number(18446744073709551615n))) <
            f(Math.exp(f(-delta / temperature)));
      if (accept) {
        currentEnergy = next;
        if (next < bestEnergy) {
          bestEnergy = next;
          best = candidates.map((c) => c.selected);
        }
      } else c.selected = !c.selected;
      temperature = f(temperature * f(cfg.coolingRate));
      if (temperature < 0.001) break;
    }
    candidates.forEach((c, i) => (c.selected = best[i]!));
    iterations = cfg.maxIterations;
  }
  const selected = (
    cfg.algorithm === "greedy"
      ? [...candidates].sort((a, b) => b.priority - a.priority)
      : candidates
  ).filter((c) => c.selected);
  return {
    visibleLabels: selected.map((c) => c.labelId),
    positions: selected.map((c) => [c.labelId, c.position]),
    totalEnergy: bestEnergy,
    iterations,
  };
}
