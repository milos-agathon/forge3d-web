import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as f from "../../src-ts/index.js";
const fixture = (name: string) =>
    new Uint8Array(
      readFileSync(new URL("../fixtures/w15/" + name, import.meta.url)),
    ),
  text = (name: string) => new TextDecoder().decode(fixture(name)),
  expected = JSON.parse(text("triangle-expected.json"));
function triangle(m: f.MeshBuffers) {
  for (const key of ["positions", "normals", "uvs", "indices"] as const)
    expect([...m[key]]).toEqual(expected[key]);
}
describe("W15 mesh IO", () => {
  it("disposal cancels external resolvers that ignore signals and resolver errors stay typed", async () => {
    const io = new f.MeshIo();
    let started!: () => void;
    const waiting = new Promise<void>((r) => (started = r)),
      pending = io.load(new Blob([fixture("triangle-external.gltf")]), {
        format: "gltf",
        resolveUri: () => {
          started();
          return new Promise(() => {});
        },
      });
    await waiting;
    io.dispose();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(
      f.decodeGltf(fixture("triangle-external.gltf"), {
        resolveUri: async () => {
          throw Error("remote failed");
        },
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(
      f.decodeGltf(fixture("triangle.gltf"), { maxBytes: NaN }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("modern RGBE literal scanlines span 128-byte boundaries without legacy ambiguity", async () => {
    for (const width of [8, 128, 129, 257]) {
      const image = {
        width,
        height: 2,
        data: Float32Array.from({ length: width * 2 * 4 }, (_, i) =>
          i % 4 === 3 ? 1 : [0.015625, 0.015625, 1][i % 4]!,
        ),
      };
      expect(await f.loadHdr(f.exportHdr(image))).toEqual(image);
    }
  });
  it("pins independent format fixtures", () => {
    const manifest = JSON.parse(text("assets.json"));
    for (const a of manifest.assets) {
      const b = fixture(a.name);
      expect(b.length).toBe(a.byteLength);
      expect(createHash("sha256").update(b).digest("hex")).toBe(a.sha256);
    }
  });
  it("OBJ negative indices, groups, materials, UVs and normal fidelity", () => {
    const imported = f.parseObj(text("triangle.obj"), {
      "triangle.mtl": text("triangle.mtl"),
    });
    triangle(imported.mesh);
    expect(imported.groups["fixture-group"]).toEqual([0]);
    expect(imported.objects["fixture-object"]).toEqual([0]);
    expect(imported.materialGroups.facade).toEqual([0]);
    expect(imported.materials[0]?.diffuseTexture).toBe("facade.png");
    const copy = f.parseObj(f.encodeObj(imported.mesh, imported), {
      "triangle.mtl": f.encodeMtl(imported.materials),
    });
    triangle(copy.mesh);
    expect(copy.materials).toEqual(imported.materials);
    expect(copy.groups).toEqual(imported.groups);
  });
  it("OBJ fans triangulate, and normals are generated if absent", () => {
    const m = f.parseObj(
      "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n",
    ).mesh;
    expect([...m.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(m.normals[2]).toBe(1);
    expect(m.uvs.length).toBe(0);
  });
  it("OBJ handles missing attributes and rejects corrupt references", () => {
    for (const suffix of ["f 0 1 2", "f 1 2 4", "f 1.2 2 3", "f 1/1 2/1 3/1"])
      expect(() => f.parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\n" + suffix)).toThrow(
        f.Forge3DError,
      );
  });
  it("binary and ASCII STL roundtrip geometry, facet count, and normals", () => {
    const m = f.parseStl(fixture("triangle.stl"));
    expect([...m.positions]).toEqual(expected.positions);
    expect([...m.indices]).toEqual(expected.indices);
    for (const binary of [true, false]) {
      const copy = f.parseStl(f.encodeStl(m, binary));
      expect(copy.positions).toEqual(m.positions);
      expect(copy.normals).toEqual(m.normals);
      expect(copy.indices.length).toBe(m.indices.length);
    }
  });
  it("STL refuses truncated/corrupt payloads and infinite positions", () => {
    for (const b of [
      fixture("triangle.stl").subarray(0, 100),
      new TextEncoder().encode(
        "solid x\nfacet normal 0 0 1\nvertex NaN 0 0\nendfacet\nendsolid x",
      ),
    ])
      expect(() => f.parseStl(b)).toThrow(f.Forge3DError);
  });
  for (const name of ["triangle.gltf", "triangle.glb"])
    it(`${name} independently encoded plain format`, async () => {
      const asset = await f.decodeGltf(fixture(name));
      expect(asset.primitives.length).toBe(1);
      triangle(asset.primitives[0]!.mesh);
      expect(asset.primitives[0]!.material).toBe(0);
      expect(asset.materials[0]).toHaveProperty("pbrMetallicRoughness");
    });
  it("GLB retains exact f32 normal/UV/tangent data and triangle indices", async () => {
    const m = f.attachMeshTangents(
        f.generatePrimitive("plane", { resolution: [2, 2] }),
      ),
      copy = (await f.decodeGltf(f.encodeGlb(m))).primitives[0]!.mesh;
    expect(copy).toEqual(m);
  });
  it("glTF external buffers use a resolver and aggregate budget", async () => {
    const uris: string[] = [];
    const o = {
      baseUrl: "https://example.test/data/model.gltf",
      resolveUri: async (uri: string) => {
        uris.push(uri);
        return fixture("triangle.bin");
      },
    };
    triangle(
      (await f.decodeGltf(fixture("triangle-external.gltf"), o)).primitives[0]!
        .mesh,
    );
    expect(uris).toEqual(["https://example.test/data/triangle.bin"]);
    await expect(
      f.decodeGltf(fixture("triangle-external.gltf"), {
        ...o,
        maxBytes: fixture("triangle-external.gltf").length + 10,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
    await expect(
      f.decodeGltf(fixture("triangle-external.gltf")),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("glTF supports normalized interleaved UV attributes and sparse position overrides", async () => {
    const doc = JSON.parse(text("triangle.gltf")),
      raw = fixture("triangle.bin"),
      bytes = new Uint8Array(128);
    bytes.set(raw);
    bytes.set([0, 255, 17, 17, 255, 0, 17, 17, 128, 128, 17, 17], 108);
    bytes[120] = 1;
    new DataView(bytes.buffer).setFloat32(124, 4, true);
    const values = new Uint8Array(140);
    values.set(bytes);
    new DataView(values.buffer).setFloat32(128, 0, true);
    new DataView(values.buffer).setFloat32(132, 0, true);
    doc.buffers = [{ byteLength: values.length, uri: "fixture.bin" }];
    doc.bufferViews.push(
      { buffer: 0, byteOffset: 108, byteLength: 12, byteStride: 4 },
      { buffer: 0, byteOffset: 120, byteLength: 1 },
      { buffer: 0, byteOffset: 124, byteLength: 12 },
    );
    doc.accessors[2] = {
      bufferView: 4,
      componentType: 5121,
      normalized: true,
      count: 3,
      type: "VEC2",
    };
    doc.accessors[0].sparse = {
      count: 1,
      indices: { bufferView: 5, componentType: 5121 },
      values: { bufferView: 6 },
    };
    const m = (
      await f.decodeGltf(new TextEncoder().encode(JSON.stringify(doc)), {
        resolveUri: async () => values,
      })
    ).primitives[0]!.mesh;
    expect(m.positions[3]).toBe(4);
    expect(m.uvs[0]).toBe(0);
    expect(m.uvs[1]).toBe(1);
    expect(m.uvs[4]).toBeCloseTo(128 / 255, 6);
  });
  it("glTF returns typed corruption/required-extension/Draco/mode failures", async () => {
    for (const edit of [
      (d: any) => (d.asset.version = "1.0"),
      (d: any) => (d.bufferViews[0].byteOffset = 999999),
      (d: any) => (d.accessors[0].count = 1e12),
      (d: any) => (d.accessors[0].type = "VEC2"),
      (d: any) => (d.meshes[0].primitives[0].attributes.NORMAL = 1e4),
    ]) {
      const doc = JSON.parse(text("triangle.gltf"));
      edit(doc);
      await expect(
        f.decodeGltf(new TextEncoder().encode(JSON.stringify(doc))),
      ).rejects.toBeInstanceOf(f.Forge3DError);
    }
    for (const edit of [
      (d: any) => (d.extensionsRequired = ["KHR_draco_mesh_compression"]),
      (d: any) => (d.meshes[0].primitives[0].mode = 1),
      (d: any) =>
        (d.meshes[0].primitives[0].extensions = {
          KHR_draco_mesh_compression: {},
        }),
    ]) {
      const doc = JSON.parse(text("triangle.gltf"));
      edit(doc);
      await expect(
        f.decodeGltf(new TextEncoder().encode(JSON.stringify(doc))),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    }
    const truncated = fixture("triangle.glb").subarray(0, 48);
    await expect(f.decodeGltf(truncated)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
  it("async Blob/ArrayBuffer/Response/stream sources and progress", async () => {
    const bytes = fixture("triangle.glb"),
      progress: number[] = [];
    for (const source of [
      new Blob([bytes]),
      bytes.buffer,
      new Response(bytes),
      new Blob([bytes]).stream(),
    ])
      triangle(
        await f.loadMesh(source, {
          format: "glb",
          onProgress: (p) => progress.push(p.loaded),
        }),
      );
    expect(progress).toContain(bytes.length);
  });
  it("URL loader resolves MTL relative to model and preserves metadata", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input) =>
          new Response(
            String(input).endsWith(".obj")
              ? fixture("triangle.obj")
              : fixture("triangle.mtl"),
          ),
      );
    try {
      const result = await f.loadObj("https://example.test/model/triangle.obj");
      triangle(result.mesh);
      expect(result.materials.length).toBe(1);
      expect(String(fetch.mock.calls[1]![0])).toBe(
        "https://example.test/model/triangle.mtl",
      );
    } finally {
      fetch.mockRestore();
    }
  });
  it("export returns Blobs and streams without filesystem assumptions", async () => {
    const m = (await f.decodeGltf(fixture("triangle.glb"))).primitives[0]!.mesh;
    for (const format of ["obj", "stl", "glb"] as const) {
      const blob = f.exportMesh(m, format);
      expect(blob.size).toBeGreaterThan(0);
      expect((await f.loadMesh(blob, { format })).indices.length).toBe(3);
    }
    const parts: Uint8Array[] = [];
    const r = await f.exportMeshToSink(m, "glb", {
      kind: "stream",
      stream: new WritableStream({
        write: (b) => {
          parts.push(b);
        },
      }),
    });
    expect(r.bytesWritten).toBe(parts[0]!.length);
    triangle((await f.decodeGltf(parts[0]!)).primitives[0]!.mesh);
  });
  it("cancel/budget/disposal settle pending reads and release owners", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      f.loadMesh(new Blob([fixture("triangle.glb")]), {
        format: "glb",
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(
      f.loadMesh(new Blob([fixture("triangle.glb")]), {
        format: "glb",
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
    const io = new f.MeshIo(),
      stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
      }),
      pending = io.load(stream, { format: "glb" });
    io.dispose();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(io.pendingReads).toBe(0);
    await expect(io.load(new Blob(), { format: "obj" })).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
  it("public HDR IO consumes W04 decoder and enforces shape", async () => {
    const image = {
        width: 2,
        height: 1,
        data: new Float32Array([0.5, 1, 2, 1, 0, 0, 0, 1]),
      },
      copy = await f.loadHdr(f.exportHdr(image));
    expect(copy).toEqual(image);
    expect(() =>
      f.exportHdr({ ...image, data: new Float32Array([NaN]) }),
    ).toThrow(f.Forge3DError);
    await expect(f.loadHdr(new Blob(["bad"]))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
