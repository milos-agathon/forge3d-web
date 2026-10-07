import {
  meshError,
  meshLimit,
  meshNumber,
  checkMesh,
  recomputeMeshNormals,
} from "./mesh.js";
import type { MeshBuffers, MeshInput } from "./mesh.js";
export interface ObjMaterial {
  name: string;
  diffuseColor: [number, number, number];
  specularColor: [number, number, number];
  ambientColor: [number, number, number];
  diffuseTexture: string | null;
  opacity: number;
  shininess: number;
}
export interface ObjImport {
  mesh: MeshBuffers;
  materials: ObjMaterial[];
  materialGroups: Record<string, number[]>;
  groups: Record<string, number[]>;
  objects: Record<string, number[]>;
  materialLibraries: string[];
}
const dictionary = (): Record<string, number[]> =>
  Object.create(null) as Record<string, number[]>;
function numbers(tokens: string[], count: number): number[] {
  if (tokens.length < count) meshError("truncated OBJ/MTL record");
  return tokens.slice(0, count).map((t) => meshNumber(Number(t), "OBJ number"));
}
export function parseMtl(text: string): ObjMaterial[] {
  const result: ObjMaterial[] = [];
  let current: ObjMaterial | undefined;
  for (const line of text.split(/\r?\n/)) {
    const [tag, ...args] = line.trim().split(/\s+/);
    if (tag === "newmtl") {
      current = {
        name: args.join(" "),
        diffuseColor: [0, 0, 0],
        specularColor: [0, 0, 0],
        ambientColor: [0, 0, 0],
        diffuseTexture: null,
        opacity: 1,
        shininess: 0,
      };
      result.push(current);
    } else if (current) {
      if (tag === "Kd")
        current.diffuseColor = numbers(args, 3) as [number, number, number];
      else if (tag === "Ks")
        current.specularColor = numbers(args, 3) as [number, number, number];
      else if (tag === "Ka")
        current.ambientColor = numbers(args, 3) as [number, number, number];
      else if (tag === "map_Kd") current.diffuseTexture = args.join(" ");
      else if (tag === "d") current.opacity = numbers(args, 1)[0]!;
      else if (tag === "Tr") current.opacity = 1 - numbers(args, 1)[0]!;
      else if (tag === "Ns") current.shininess = numbers(args, 1)[0]!;
    }
  }
  return result;
}
export function parseObj(
  text: string,
  mtlTexts: Readonly<Record<string, string>> = {},
): ObjImport {
  const rawP: number[][] = [],
    rawN: number[][] = [],
    rawUv: number[][] = [],
    p: number[] = [],
    n: number[] = [],
    uv: number[] = [],
    idx: number[] = [],
    lookup = new Map<string, number>(),
    materialGroups = dictionary(),
    groups = dictionary(),
    objects = dictionary(),
    materialLibraries: string[] = [];
  let material = "",
    group = "",
    object = "",
    hasNormals = true,
    hasUv = true;
  function fix(token: string | undefined, size: number): number {
    if (token === undefined || token === "") return -1;
    const x = Number(token);
    if (!Number.isInteger(x) || x === 0)
      meshError("OBJ indices must be nonzero integers");
    const id = x > 0 ? x - 1 : size + x;
    if (id < 0 || id >= size) meshError("OBJ index out of bounds");
    return id;
  }
  for (const line of text.split(/\r?\n/)) {
    const [tag, ...args] = line
      .replace(/\s*#.*$/, "")
      .trim()
      .split(/\s+/);
    if (tag === "v") rawP.push(numbers(args, 3));
    else if (tag === "vn") rawN.push(numbers(args, 3));
    else if (tag === "vt") rawUv.push(numbers(args, 2));
    else if (tag === "usemtl") material = args.join(" ");
    else if (tag === "g") group = args.join(" ");
    else if (tag === "o") object = args.join(" ");
    else if (tag === "mtllib") materialLibraries.push(...args);
    else if (tag === "f") {
      if (args.length < 3) meshError("OBJ face needs three vertices");
      const face = args.map((t) => {
        const parts = t.split("/");
        if (parts.length > 3) meshError("invalid OBJ triplet");
        const vi = fix(parts[0], rawP.length),
          ti = fix(parts[1], rawUv.length),
          ni = fix(parts[2], rawN.length);
        if (vi < 0) meshError("face position is missing");
        const key = `${vi}/${ti}/${ni}`;
        const cached = lookup.get(key);
        if (cached !== undefined) return cached;
        const id = p.length / 3;
        lookup.set(key, id);
        p.push(...rawP[vi]!);
        if (ni >= 0) n.push(...rawN[ni]!);
        else {
          n.push(0, 0, 0);
          hasNormals = false;
        }
        if (ti >= 0) uv.push(...rawUv[ti]!);
        else {
          uv.push(0, 0);
          hasUv = false;
        }
        return id;
      });
      for (let j = 1; j < face.length - 1; j++) {
        const tri = idx.length / 3;
        idx.push(face[0]!, face[j]!, face[j + 1]!);
        for (const [dict, key] of [
          [materialGroups, material],
          [groups, group],
          [objects, object],
        ] as const) {
          if (key) (dict[key] ??= []).push(tri);
        }
      }
    }
    meshLimit(
      (rawP.length * 3 +
        rawN.length * 3 +
        rawUv.length * 2 +
        p.length +
        n.length +
        uv.length +
        idx.length) *
        4,
    );
  }
  let mesh: MeshBuffers = {
    positions: new Float32Array(p),
    indices: new Uint32Array(idx),
    normals: new Float32Array(n),
    uvs: new Float32Array(hasUv ? uv : []),
    tangents: new Float32Array(),
  };
  checkMesh(mesh);
  if (!hasNormals) mesh = recomputeMeshNormals(mesh);
  return {
    mesh,
    materials: materialLibraries.flatMap((name) =>
      mtlTexts[name] !== undefined ? parseMtl(mtlTexts[name]!) : [],
    ),
    materialGroups,
    groups,
    objects,
    materialLibraries,
  };
}
export function encodeObj(
  input: MeshInput,
  metadata?: Pick<
    ObjImport,
    "groups" | "objects" | "materialGroups" | "materialLibraries"
  >,
): string {
  checkMesh(input);
  const m = input,
    lines = ["# Forge3D triangle mesh"],
    nv = m.positions.length / 3,
    hasUv = m.uvs?.length === nv * 2,
    hasN = m.normals?.length === nv * 3;
  if (metadata)
    for (const library of metadata.materialLibraries)
      lines.push(`mtllib ${library.replace(/[\r\n]/g, "")}`);
  for (let i = 0; i < m.positions.length; i += 3)
    lines.push(
      `v ${m.positions[i]} ${m.positions[i + 1]} ${m.positions[i + 2]}`,
    );
  if (hasUv)
    for (let i = 0; i < m.uvs!.length; i += 2)
      lines.push(`vt ${m.uvs![i]} ${m.uvs![i + 1]}`);
  if (hasN)
    for (let i = 0; i < m.normals!.length; i += 3)
      lines.push(
        `vn ${m.normals![i]} ${m.normals![i + 1]} ${m.normals![i + 2]}`,
      );
  const starts = new Map<number, string[]>();
  if (metadata)
    for (const [tag, dict] of [
      ["g", metadata.groups],
      ["o", metadata.objects],
      ["usemtl", metadata.materialGroups],
    ] as const)
      for (const [name, tris] of Object.entries(dict))
        for (const t of tris)
          (starts.get(t) ?? (starts.set(t, []), starts.get(t)!)).push(
            `${tag} ${name.replace(/[\r\n]/g, "")}`,
          );
  for (let t = 0; t < m.indices.length; t += 3) {
    lines.push(...(starts.get(t / 3) ?? []));
    lines.push(
      "f " +
        [m.indices[t]! + 1, m.indices[t + 1]! + 1, m.indices[t + 2]! + 1]
          .map((i) =>
            hasUv
              ? hasN
                ? `${i}/${i}/${i}`
                : `${i}/${i}`
              : hasN
                ? `${i}//${i}`
                : `${i}`,
          )
          .join(" "),
    );
  }
  return lines.join("\n") + "\n";
}
export function encodeMtl(materials: readonly ObjMaterial[]): string {
  return materials
    .map(
      (m) =>
        `newmtl ${m.name.replace(/[\r\n]/g, "")}\nKd ${m.diffuseColor.join(" ")}\nKs ${m.specularColor.join(" ")}\nKa ${m.ambientColor.join(" ")}\nd ${m.opacity}\nNs ${m.shininess}\n${m.diffuseTexture ? `map_Kd ${m.diffuseTexture.replace(/[\r\n]/g, "")}\n` : ""}`,
    )
    .join("\n");
}
