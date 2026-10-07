import {
  checkMesh,
  meshError,
  meshLimit,
  meshNumber,
  cross,
  sub,
  unit,
  vertex,
  recomputeMeshNormals,
} from "./mesh.js";
import type { MeshInput, MeshBuffers } from "./mesh.js";
export function encodeStl(m: MeshInput, binary = true): Uint8Array {
  checkMesh(m);
  const count = m.indices.length / 3;
  meshLimit(84 + count * 50);
  if (!binary) {
    const lines = ["solid forge3d"];
    for (let t = 0; t < count; t++) {
      const p = [0, 1, 2].map((j) => vertex(m, m.indices[t * 3 + j]!)),
        n = unit(cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!)));
      lines.push(
        `facet normal ${n.join(" ")}`,
        "outer loop",
        ...p.map((v) => `vertex ${v.join(" ")}`),
        "endloop",
        "endfacet",
      );
    }
    lines.push("endsolid forge3d");
    return new TextEncoder().encode(lines.join("\n") + "\n");
  }
  const out = new Uint8Array(84 + count * 50),
    view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("Forge3D binary STL"));
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const p = [0, 1, 2].map((j) => vertex(m, m.indices[t * 3 + j]!)),
      n = unit(cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!))),
      data = [...n, ...p.flat()];
    for (let j = 0; j < 12; j++)
      view.setFloat32(84 + t * 50 + j * 4, data[j]!, true);
  }
  return out;
}
export function parseStl(data: Uint8Array): MeshBuffers {
  meshLimit(data.byteLength);
  const p: number[] = [],
    n: number[] = [],
    indices: number[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    binary =
      data.length >= 84 && 84 + view.getUint32(80, true) * 50 === data.length;
  if (binary) {
    const count = view.getUint32(80, true);
    meshLimit(count * 3 * 28);
    for (let t = 0; t < count; t++) {
      const off = 84 + t * 50,
        normal = [0, 1, 2].map((j) =>
          meshNumber(view.getFloat32(off + j * 4, true), "STL normal"),
        );
      for (let j = 0; j < 3; j++) {
        for (let a = 0; a < 3; a++)
          p.push(
            meshNumber(
              view.getFloat32(off + 12 + j * 12 + a * 4, true),
              "STL position",
            ),
          );
        n.push(...normal);
        indices.push(indices.length);
      }
    }
  } else {
    const text = new TextDecoder().decode(data);
    if (!/^\s*solid\b/.test(text) || !text.includes("endsolid"))
      meshError("invalid or truncated STL");
    let normal = [0, 0, 0],
      vertices = 0,
      facet = false;
    for (const line of text.split(/\r?\n/)) {
      const a = line.trim().split(/\s+/);
      if (a[0] === "facet") {
        if (facet || a[1] !== "normal" || a.length !== 5)
          meshError("invalid STL facet");
        normal = a.slice(2).map((x) => meshNumber(Number(x), "STL normal"));
        facet = true;
        vertices = 0;
      } else if (a[0] === "vertex") {
        if (!facet || a.length !== 4 || vertices >= 3)
          meshError("invalid STL vertex");
        p.push(...a.slice(1).map((x) => meshNumber(Number(x), "STL position")));
        n.push(...normal);
        indices.push(indices.length);
        vertices++;
      } else if (a[0] === "endfacet") {
        if (!facet || vertices !== 3) meshError("incomplete STL facet");
        facet = false;
      }
    }
    if (facet) meshError("truncated STL facet");
  }
  const mesh = {
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(),
    tangents: new Float32Array(),
  };
  checkMesh(mesh);
  return n.some((x) => x !== 0) ? mesh : recomputeMeshNormals(mesh);
}
