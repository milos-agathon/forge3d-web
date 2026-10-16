import { Forge3DError } from "./index.js";
import type {
  ScenePassInput,
  SceneRenderBarrier,
  SceneRenderPlan,
} from "./index.js";

const PASS_KINDS = new Set(["render", "compute", "copy"]);

interface NormalizedPass {
  name: string;
  reads: string[];
  writes: string[];
  dependsOn: string[];
}

export function compileScenePasses(
  passes: readonly ScenePassInput[],
): SceneRenderPlan {
  const normalized = normalizePasses(passes);
  const indexByName = new Map<string, number>();
  normalized.forEach((pass, index) => indexByName.set(pass.name, index));

  const edges = new Set<string>();
  normalized.forEach((pass, index) => {
    for (const dependency of pass.dependsOn) {
      const dependencyIndex = indexByName.get(dependency);
      if (dependencyIndex === undefined) {
        throw invalid(`pass ${pass.name} depends on unknown pass ${dependency}`);
      }
      edges.add(`${dependencyIndex}:${index}`);
    }
  });

  for (const resource of collectResources(normalized)) {
    let lastWriter: number | undefined;
    const readers: number[] = [];
    normalized.forEach((pass, index) => {
      if (pass.reads.includes(resource)) {
        if (lastWriter !== undefined) {
          edges.add(`${lastWriter}:${index}`);
        }
        readers.push(index);
      }
      if (pass.writes.includes(resource)) {
        if (lastWriter !== undefined) {
          edges.add(`${lastWriter}:${index}`);
        }
        for (const reader of readers) {
          edges.add(`${reader}:${index}`);
        }
        lastWriter = index;
        readers.length = 0;
      }
    });
  }

  const order = topologicalOrder(normalized.length, edges);
  const position = new Array<number>(normalized.length);
  order.forEach((passIndex, slot) => {
    position[passIndex] = slot;
  });

  const barriers: SceneRenderBarrier[] = [];
  const resourceLifetimes: Record<string, [number, number]> = {};
  for (const resource of collectResources(normalized)) {
    const accesses: Array<{ index: number; access: "read" | "write" }> = [];
    normalized.forEach((pass, index) => {
      if (pass.reads.includes(resource)) {
        accesses.push({ index, access: "read" });
      }
      if (pass.writes.includes(resource)) {
        accesses.push({ index, access: "write" });
      }
    });
    accesses.sort((left, right) => position[left.index]! - position[right.index]!);
    if (accesses.length > 0) {
      resourceLifetimes[resource] = [
        position[accesses[0]!.index]!,
        position[accesses[accesses.length - 1]!.index]!,
      ];
    }
    for (let i = 1; i < accesses.length; i += 1) {
      const previous = accesses[i - 1]!;
      const next = accesses[i]!;
      if (previous.access !== next.access) {
        barriers.push({
          resource,
          beforePass: normalized[next.index]!.name,
          from: previous.access,
          to: next.access,
        });
      }
    }
  }
  barriers.sort(
    (left, right) =>
      position[indexByName.get(left.beforePass)!]! -
        position[indexByName.get(right.beforePass)!]! ||
      (left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0),
  );

  return {
    passes: order.map((index) => normalized[index]!.name),
    barriers,
    resourceLifetimes,
  };
}

function normalizePasses(
  passes: readonly ScenePassInput[],
): NormalizedPass[] {
  const names = new Set<string>();
  return passes.map((pass) => {
    if (typeof pass.name !== "string" || pass.name.length === 0) {
      throw invalid("pass name must be a nonempty string");
    }
    if (names.has(pass.name)) {
      throw invalid(`duplicate pass name ${pass.name}`);
    }
    names.add(pass.name);
    if (!PASS_KINDS.has(pass.kind)) {
      throw invalid(`pass ${pass.name} has unknown kind ${String(pass.kind)}`);
    }
    const reads = [...(pass.reads ?? [])];
    const writes = [...(pass.writes ?? [])];
    const seen = new Set<string>();
    for (const resource of [...reads, ...writes]) {
      if (typeof resource !== "string" || resource.length === 0) {
        throw invalid(`pass ${pass.name} references an empty resource name`);
      }
      if (!seen.add(resource)) {
        throw invalid(
          `pass ${pass.name} lists resource ${resource} more than once or in both reads and writes`,
        );
      }
    }
    const dependsOn = [...(pass.dependsOn ?? [])];
    for (const dependency of dependsOn) {
      if (typeof dependency !== "string" || dependency.length === 0) {
        throw invalid(`pass ${pass.name} depends on an empty pass name`);
      }
    }
    return { name: pass.name, reads, writes, dependsOn };
  });
}

function collectResources(passes: readonly NormalizedPass[]): string[] {
  const resources = new Set<string>();
  for (const pass of passes) {
    for (const resource of [...pass.reads, ...pass.writes]) {
      resources.add(resource);
    }
  }
  return [...resources].sort();
}

function topologicalOrder(passCount: number, edges: Set<string>): number[] {
  const inDegree = new Array<number>(passCount).fill(0);
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const [from, to] = edge.split(":").map(Number) as [number, number];
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
    inDegree[to]! += 1;
  }
  const ready = new Set<number>();
  for (let i = 0; i < passCount; i += 1) {
    if (inDegree[i] === 0) {
      ready.add(i);
    }
  }
  const order: number[] = [];
  while (ready.size > 0) {
    const next = Math.min(...ready);
    ready.delete(next);
    order.push(next);
    for (const target of adjacency.get(next) ?? []) {
      inDegree[target]! -= 1;
      if (inDegree[target] === 0) {
        ready.add(target);
      }
    }
  }
  if (order.length !== passCount) {
    throw invalid("pass dependency cycle detected");
  }
  return order;
}

function invalid(message: string): Forge3DError {
  return new Forge3DError("INVALID_INPUT", message);
}
