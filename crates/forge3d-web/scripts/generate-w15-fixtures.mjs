import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../tests/fixtures/w15/", import.meta.url));
mkdirSync(dir, { recursive: true });
const entries = [];
function save(name, data) {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  writeFileSync(dir + name, bytes);
  entries.push({
    name,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const positions = [0, 0, 0, 2, 0, 0, 0, 3, 0],
  normals = [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs = [0, 0, 1, 0, 0, 1],
  indices = [0, 1, 2],
  bin = Buffer.alloc(36 + 36 + 24 + 12);
let offset = 0;
for (const values of [positions, normals, uvs])
  for (const x of values) {
    bin.writeFloatLE(x, offset);
    offset += 4;
  }
for (const x of indices) {
  bin.writeUInt32LE(x, offset);
  offset += 4;
}
const document = {
  asset: { version: "2.0" },
  buffers: [
    {
      uri: "data:application/octet-stream;base64," + bin.toString("base64"),
      byteLength: bin.length,
    },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 36 },
    { buffer: 0, byteOffset: 72, byteLength: 24 },
    { buffer: 0, byteOffset: 96, byteLength: 12 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [2, 3, 0],
    },
    { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
    { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
    { bufferView: 3, componentType: 5125, count: 3, type: "SCALAR" },
  ],
  materials: [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.2, 0.1, 1],
        roughnessFactor: 0.35,
        metallicFactor: 0.6,
      },
    },
  ],
  meshes: [
    {
      name: "independent-triangle",
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
          indices: 3,
          material: 0,
        },
      ],
    },
  ],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
};
save("triangle.gltf", JSON.stringify(document));
const glbDoc = structuredClone(document);
delete glbDoc.buffers[0].uri;
const json = Buffer.from(JSON.stringify(glbDoc)),
  padded = Math.ceil(json.length / 4) * 4,
  glb = Buffer.alloc(28 + padded + bin.length, 0);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(padded, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
glb.fill(32, 20, 20 + padded);
json.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + padded);
glb.writeUInt32LE(0x004e4942, 24 + padded);
bin.copy(glb, 28 + padded);
save("triangle.glb", glb);
save(
  "triangle-external.gltf",
  JSON.stringify({
    ...document,
    buffers: [{ uri: "triangle.bin", byteLength: bin.length }],
  }),
);
save("triangle.bin", bin);
save(
  "triangle.obj",
  "mtllib triangle.mtl\no fixture-object\ng fixture-group\nv 0 0 0\nv 2 0 0\nv 0 3 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nusemtl facade\nf -3/1/1 -2/2/1 -1/3/1\n",
);
save(
  "triangle.mtl",
  "newmtl facade\nKd 0.8 0.2 0.1\nKa 0.1 0.1 0.1\nKs 0.3 0.3 0.3\nmap_Kd facade.png\n",
);
const stl = Buffer.alloc(134);
Buffer.from("independent fixture").copy(stl);
stl.writeUInt32LE(1, 80);
stl.writeFloatLE(1, 92);
for (let i = 0; i < positions.length; i++)
  stl.writeFloatLE(positions[i], 96 + i * 4);
save("triangle.stl", stl);
save(
  "triangle-expected.json",
  JSON.stringify({ positions, normals, uvs, indices }),
);
save(
  "buildings.geojson",
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "house",
        properties: {
          height: 4,
          building: "house",
          "building:material": "brick",
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 3],
              [0, 3],
              [0, 0],
            ],
          ],
        },
      },
      {
        type: "Feature",
        id: "office",
        properties: { height: 3, building: "office" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [6, 0],
              [8, 0],
              [8, 3],
              [6, 3],
              [6, 0],
            ],
          ],
        },
      },
    ],
  }),
);
const vertices = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 3, 0],
    [0, 3, 0],
    [0, 0, 4],
    [4, 0, 4],
    [4, 3, 4],
    [0, 3, 4],
  ],
  surfaces = [
    [[0, 3, 2, 1]],
    [[0, 1, 5, 4]],
    [[1, 2, 6, 5]],
    [[2, 3, 7, 6]],
    [[3, 0, 4, 7]],
    [[4, 5, 6, 7]],
  ];
save(
  "buildings.city.json",
  JSON.stringify({
    type: "CityJSON",
    version: "1.1",
    metadata: { referenceSystem: "urn:ogc:def:crs:EPSG::28992" },
    transform: { scale: [0.5, 0.5, 0.5], translate: [1000, 2000, 0] },
    vertices,
    CityObjects: {
      house: {
        type: "Building",
        attributes: { measuredHeight: 2, building: "house" },
        geometry: [
          { type: "MultiSurface", lod: "1", boundaries: surfaces },
          { type: "Solid", lod: "2.2", boundaries: [surfaces] },
        ],
      },
    },
  }),
);
save(
  "texture-diagnostics.json",
  JSON.stringify([
    {
      materialId: "facade",
      objectId: "building-1",
      albedoTexture: "missing_facade.ktx2",
      textureFormat: "ktx2",
      uvAvailable: false,
      assetAvailable: false,
      scalarFallback: true,
    },
  ]),
);
writeFileSync(
  dir + "assets.json",
  JSON.stringify(
    {
      id: "mesh-io-v1-assets",
      generator: "scripts/generate-w15-fixtures.mjs",
      assets: entries,
    },
    null,
    2,
  ) + "\n",
);
