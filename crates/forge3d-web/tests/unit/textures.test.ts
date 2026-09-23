import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  KHR_SUPERCOMPRESSION_BASISLZ,
  createDefaultContainer,
  write,
} from "ktx-parse";
import { describe, expect, it } from "vitest";

import {
  Forge3DError,
  Ktx2Loader,
  TextureSet,
  extractGltfMaterialChannels,
  generateMeshTangents,
  type TextureImageInput,
  type TextureImageSnapshot,
  type TextureSetSnapshot,
} from "../../src-ts/index.js";

function imageInput(
  overrides: Partial<TextureImageInput> = {},
): TextureImageInput {
  return {
    width: 2,
    height: 2,
    format: "rgba8unorm",
    colorSpace: "linear",
    data: new Uint8Array(16).fill(255),
    ...overrides,
  };
}

describe("TextureSet", () => {
  it("defaults to an empty set with a default sampler", () => {
    const set = new TextureSet();
    const snapshot = set.snapshot();
    expect(snapshot.baseColor).toBeUndefined();
    expect(snapshot.normal).toBeUndefined();
    expect(snapshot.metallicRoughness).toBeUndefined();
    expect(snapshot.occlusion).toBeUndefined();
    expect(snapshot.emissive).toBeUndefined();
    expect(snapshot.sampler).toEqual({
      wrapU: "repeat",
      wrapV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 1,
    });
    expect(set.estimatedGpuBytes()).toBe(0);
  });

  it("normalizes and defensively copies supplied images", () => {
    const data = new Uint8Array(16);
    data[0] = 7;
    const set = new TextureSet({
      baseColor: imageInput({
        format: "rgba8unorm-srgb",
        colorSpace: "srgb",
        data,
      }),
      sampler: { wrapU: "clamp-to-edge", maxAnisotropy: 4 },
    });
    data[0] = 99;
    const snapshot = set.snapshot();
    expect(snapshot.baseColor?.levels[0]?.data[0]).toBe(7);
    expect(snapshot.baseColor?.compressed).toBe(false);
    expect(snapshot.baseColor?.sourceFormat).toBe("raw");
    expect(snapshot.baseColor?.effectiveQuality).toBe("native");
    expect(snapshot.sampler.wrapU).toBe("clamp-to-edge");
    expect(snapshot.sampler.wrapV).toBe("repeat");
    expect(snapshot.sampler.maxAnisotropy).toBe(4);
    expect(set.get("base-color")?.levels[0]?.data[0]).toBe(7);
    snapshot.baseColor!.levels[0]!.data[0] = 55;
    expect(set.get("base-color")?.levels[0]?.data[0]).toBe(7);
  });

  it("round-trips through snapshot and copy", () => {
    const set = new TextureSet({
      baseColor: imageInput({
        format: "rgba8unorm-srgb",
        colorSpace: "srgb",
        mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4).fill(3) }],
      }),
      normal: imageInput({ data: new Uint8Array(16).fill(128) }),
      sampler: { magFilter: "nearest" },
    });
    const restored = TextureSet.from(set.snapshot());
    expect(restored.snapshot()).toEqual(set.snapshot());
    expect(restored.copy().snapshot()).toEqual(set.snapshot());
    expect(set.estimatedGpuBytes()).toBe(16 + 4 + 16);
  });

  it("accepts a TextureSet instance as material input shape", () => {
    const source = new TextureSet({ baseColor: imageInput() });
    const copy = source.copy();
    expect(copy.snapshot()).toEqual(source.snapshot());
  });

  it("generates mipmaps down to 1x1 for rgba8", () => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let index = 0; index < 16; index += 1) {
      data[index * 4] = 100;
      data[index * 4 + 3] = 255;
    }
    const set = new TextureSet({
      normal: imageInput({
        width: 4,
        height: 4,
        data: new Uint8Array(4 * 4 * 4).map((_, i) =>
          i % 4 === 2 || i % 4 === 3 ? 255 : 128,
        ),
        generateMipmaps: true,
      }),
      occlusion: imageInput({
        width: 4,
        height: 4,
        data,
        generateMipmaps: true,
      }),
    });
    const occlusion = set.get("occlusion")!;
    expect(occlusion.levels.map((l) => [l.width, l.height])).toEqual([
      [4, 4],
      [2, 2],
      [1, 1],
    ]);
    expect(occlusion.levels[2]!.data[0]).toBe(100);
    expect(occlusion.levels[2]!.data[3]).toBe(255);
    const normal = set.get("normal")!;
    expect(normal.levels.at(-1)?.data[0]).toBe(128);
  });

  it("averages sRGB mips in linear space", () => {
    const black = [0, 0, 0, 255];
    const white = [255, 255, 255, 255];
    const data = new Uint8Array([...black, ...white, ...black, ...white]);
    const set = new TextureSet({
      baseColor: imageInput({
        format: "rgba8unorm-srgb",
        colorSpace: "srgb",
        data,
        generateMipmaps: true,
      }),
    });
    const mip = set.get("base-color")!.levels[1]!;
    const expected = Math.round(
      255 * (1.055 * Math.pow(0.5, 1 / 2.4) - 0.055),
    );
    expect(mip.data[0]).toBe(expected);
    expect(mip.data[0]).toBe(188);
  });

  it("rejects malformed inputs", () => {
    const cases: [string, TextureSetInputish][] = [
      ["zero width", { baseColor: imageInput({ width: 0 }) }],
      ["oversized", { baseColor: imageInput({ width: 16385 }) }],
      [
        "short payload",
        { baseColor: imageInput({ data: new Uint8Array(15) }) },
      ],
      [
        "bad format",
        { baseColor: imageInput({ format: "rg8unorm" as never }) },
      ],
      [
        "normal srgb",
        {
          normal: imageInput({
            format: "rgba8unorm-srgb",
            colorSpace: "srgb",
          }),
        },
      ],
      [
        "normal linear colorSpace but srgb format",
        {
          normal: imageInput({
            format: "rgba8unorm-srgb",
            colorSpace: "linear",
          }),
        },
      ],
      [
        "base-color srgb colorSpace with linear format",
        {
          baseColor: imageInput({
            format: "rgba8unorm",
            colorSpace: "srgb",
          }),
        },
      ],
      [
        "base-color linear colorSpace with srgb format",
        {
          baseColor: imageInput({
            format: "rgba8unorm-srgb",
            colorSpace: "linear",
          }),
        },
      ],
      [
        "bad mip size",
        {
          baseColor: imageInput({
            mipmaps: [
              { width: 2, height: 2, data: new Uint8Array(16) },
            ],
          }),
        },
      ],
      [
        "bad mip payload",
        {
          baseColor: imageInput({
            mipmaps: [{ width: 1, height: 1, data: new Uint8Array(8) }],
          }),
        },
      ],
      [
        "compressed generateMipmaps",
        {
          baseColor: imageInput({
            format: "bc1-rgba-unorm-srgb",
            colorSpace: "srgb",
            width: 4,
            height: 4,
            data: new Uint8Array(8),
            generateMipmaps: true,
          }),
        },
      ],
      [
        "compressed wrong payload",
        {
          baseColor: imageInput({
            format: "bc3-rgba-unorm-srgb",
            colorSpace: "srgb",
            width: 4,
            height: 4,
            data: new Uint8Array(8),
          }),
        },
      ],
      [
        "bad wrap",
        { sampler: { wrapU: "repeat-x" as never } },
      ],
      [
        "bad filter",
        { sampler: { magFilter: "cubic" as never } },
      ],
      ["bad anisotropy", { sampler: { maxAnisotropy: 3 as never } }],
    ];
    for (const [label, input] of cases) {
      expect(() => new TextureSet(input), label).toThrowError(Forge3DError);
    }
  });

  it("accepts exact compressed block sizes", () => {
    const set = new TextureSet({
      metallicRoughness: imageInput({
        format: "bc7-rgba-unorm",
        width: 4,
        height: 4,
        data: new Uint8Array(16),
      }),
    });
    expect(set.get("metallic-roughness")?.compressed).toBe(true);
  });

  it("rejects tampered snapshots", () => {
    const set = new TextureSet({ baseColor: imageInput() });
    const snapshot = set.snapshot();
    const tampered: TextureSetSnapshot = {
      ...snapshot,
      baseColor: { ...snapshot.baseColor!, compressed: true },
    };
    expect(() => TextureSet.from(tampered)).toThrowError(Forge3DError);
  });

  it("rejects unknown semantics on get", () => {
    const set = new TextureSet();
    expect(() => set.get("sheen" as never)).toThrowError(Forge3DError);
  });

  it("rejects anisotropy above 1 without all-linear filters", () => {
    for (const filter of ["magFilter", "minFilter", "mipmapFilter"] as const) {
      const sampler = {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        [filter]: "nearest",
        maxAnisotropy: 4,
      } as const;
      expect(() => new TextureSet({ sampler }), filter).toThrowError(
        Forge3DError,
      );
    }
    const set = new TextureSet({
      sampler: {
        magFilter: "nearest",
        minFilter: "nearest",
        mipmapFilter: "nearest",
        maxAnisotropy: 1,
      },
    });
    expect(set.snapshot().sampler.magFilter).toBe("nearest");
    const linear = new TextureSet({ sampler: { maxAnisotropy: 16 } });
    expect(linear.snapshot().sampler.maxAnisotropy).toBe(16);
  });

  it("averages the complete source footprint for odd dimensions", () => {
    const data = new Uint8Array(3 * 3 * 4);
    for (let index = 0; index < 9; index += 1) {
      data[index * 4] = index * 30;
      data[index * 4 + 1] = 64;
      data[index * 4 + 2] = 32;
      data[index * 4 + 3] = 255;
    }
    const set = new TextureSet({
      occlusion: imageInput({
        width: 3,
        height: 3,
        data,
        generateMipmaps: true,
      }),
    });
    const mip = set.get("occlusion")!.levels[1]!;
    expect([mip.width, mip.height]).toEqual([1, 1]);
    // All nine texels contribute: 1080 / 9 = 120 (a 2x2 footprint gives 60).
    expect(mip.data[0]).toBe(120);
    expect(mip.data[3]).toBe(255);
  });

  it("encodes cancelling normals as the +Z fallback", () => {
    const px = (r: number, g: number, b: number) => [r, g, b, 255];
    const data = new Uint8Array([
      ...px(255, 0, 255), ...px(0, 255, 0), ...px(0, 255, 0), ...px(255, 0, 255),
    ]);
    const set = new TextureSet({
      normal: imageInput({ data, generateMipmaps: true }),
    });
    const mip = set.get("normal")!.levels[1]!;
    expect([...mip.data]).toEqual([128, 128, 255, 255]);
  });

  it("rejects provenance claims on plain texture input", () => {
    for (const sourceFormat of ["ktx2", "basis"] as const) {
      expect(
        () => new TextureSet({ baseColor: imageInput({ sourceFormat }) }),
        sourceFormat,
      ).toThrowError(Forge3DError);
    }
    for (const effectiveQuality of ["transcoded", "rgba8-fallback"] as const) {
      expect(
        () => new TextureSet({ baseColor: imageInput({ effectiveQuality }) }),
        effectiveQuality,
      ).toThrowError(Forge3DError);
    }
    const honest = new TextureSet({
      baseColor: imageInput({ sourceFormat: "raw", effectiveQuality: "native" }),
    });
    expect(honest.get("base-color")?.effectiveQuality).toBe("native");
  });

  it("rejects lying snapshot provenance and level-0 dimension mismatches", () => {
    const rgba: TextureImageSnapshot = {
      width: 2,
      height: 2,
      format: "rgba8unorm-srgb",
      colorSpace: "srgb",
      levels: [{ width: 2, height: 2, data: new Uint8Array(16) }],
      compressed: false,
      sourceFormat: "raw",
      effectiveQuality: "native",
    };
    const bc7 = (quality: TextureImageSnapshot["effectiveQuality"]) =>
      ({
        width: 4,
        height: 4,
        format: "bc7-rgba-unorm-srgb",
        colorSpace: "srgb",
        levels: [{ width: 4, height: 4, data: new Uint8Array(16) }],
        compressed: true,
        sourceFormat: "basis",
        effectiveQuality: quality,
      }) satisfies TextureImageSnapshot;
    const lies: TextureImageSnapshot[] = [
      { ...rgba, effectiveQuality: "transcoded" },
      { ...rgba, effectiveQuality: "rgba8-fallback" },
      { ...rgba, sourceFormat: "ktx2", effectiveQuality: "transcoded" },
      { ...rgba, sourceFormat: "ktx2", effectiveQuality: "rgba8-fallback" },
      { ...rgba, sourceFormat: "basis", effectiveQuality: "native" },
      { ...rgba, sourceFormat: "basis", effectiveQuality: "transcoded" },
      bc7("native"),
      bc7("rgba8-fallback"),
      {
        ...rgba,
        levels: [{ width: 1, height: 2, data: new Uint8Array(8) }],
      },
      {
        ...rgba,
        levels: [{ width: 2, height: 1, data: new Uint8Array(8) }],
      },
    ];
    const sampler = {
      wrapU: "repeat",
      wrapV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 1,
    } as const;
    for (const [index, image] of lies.entries()) {
      expect(
        () => TextureSet.from({ baseColor: image, sampler }),
        `lie ${index}`,
      ).toThrowError(Forge3DError);
    }
    const honest = TextureSet.from({
      baseColor: rgba,
      normal: {
        width: 4,
        height: 4,
        format: "bc7-rgba-unorm",
        colorSpace: "linear",
        levels: [{ width: 4, height: 4, data: new Uint8Array(16) }],
        compressed: true,
        sourceFormat: "basis",
        effectiveQuality: "transcoded",
      },
      occlusion: {
        width: 2,
        height: 2,
        format: "rgba8unorm",
        colorSpace: "linear",
        levels: [{ width: 2, height: 2, data: new Uint8Array(16) }],
        compressed: false,
        sourceFormat: "basis",
        effectiveQuality: "rgba8-fallback",
      },
      sampler,
    });
    expect(honest.get("normal")?.effectiveQuality).toBe("transcoded");
    expect(honest.get("occlusion")?.effectiveQuality).toBe("rgba8-fallback");
  });
});

type TextureSetInputish = ConstructorParameters<typeof TextureSet>[0];

describe("generateMeshTangents", () => {
  function plane(): {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
  } {
    return {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      ]),
      normals: new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
  }

  it("produces +X tangents with +1 handedness for a flat quad", () => {
    const { tangents } = generateMeshTangents(plane());
    for (let vertex = 0; vertex < 4; vertex += 1) {
      expect(tangents[vertex * 4]).toBeCloseTo(1, 5);
      expect(tangents[vertex * 4 + 1]).toBeCloseTo(0, 5);
      expect(tangents[vertex * 4 + 2]).toBeCloseTo(0, 5);
      expect(tangents[vertex * 4 + 3]).toBe(1);
    }
  });

  it("flips handedness for mirrored UVs", () => {
    const mesh = plane();
    mesh.uvs = new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]);
    const { tangents } = generateMeshTangents(mesh);
    expect(tangents[3]).toBe(-1);
  });

  it("falls back to a finite perpendicular for degenerate UVs", () => {
    const mesh = plane();
    mesh.uvs = new Float32Array(8);
    const { tangents } = generateMeshTangents(mesh);
    for (let vertex = 0; vertex < 4; vertex += 1) {
      const length = Math.hypot(
        tangents[vertex * 4]!,
        tangents[vertex * 4 + 1]!,
        tangents[vertex * 4 + 2]!,
      );
      expect(Number.isFinite(tangents[vertex * 4]!)).toBe(true);
      expect(length).toBeCloseTo(1, 5);
    }
  });

  it("orthonormalizes tangents against skew normals", () => {
    const mesh = plane();
    mesh.normals = new Float32Array([
      0.1, 0, 1, 0.1, 0, 1, 0.1, 0, 1, 0.1, 0, 1,
    ]);
    const { tangents } = generateMeshTangents(mesh);
    for (let vertex = 0; vertex < 4; vertex += 1) {
      const dot =
        tangents[vertex * 4]! * 0.1 + tangents[vertex * 4 + 2]! * 1;
      const normalLength = Math.hypot(0.1, 0, 1);
      expect(Math.abs(dot) / normalLength).toBeLessThan(1e-5);
    }
  });

  it("weights shared-vertex tangents by geometric area", () => {
    // Triangle A (area 0.5) contributes +X; triangle B (area 2) contributes
    // +Y. Shared vertex 0 must lean +Y: (1,0,0)*0.5 + (0,2,0)*2 = (0.5,4,0).
    const { tangents } = generateMeshTangents({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 0, 2, 0,
      ]),
      normals: new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, -1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 3, 4]),
    });
    const length = Math.hypot(0.5, 4);
    expect(tangents[0]).toBeCloseTo(0.5 / length, 5);
    expect(tangents[1]).toBeCloseTo(4 / length, 5);
    expect(tangents[2]).toBeCloseTo(0, 5);
    expect(tangents[3 * 4]).toBeCloseTo(0, 5);
    expect(tangents[3 * 4 + 1]).toBeCloseTo(1, 5);
  });

  it("rejects non-finite positions, normals, and uvs", () => {
    const mesh = plane();
    const positions = Float32Array.from(mesh.positions);
    positions[0] = Number.NaN;
    expect(() =>
      generateMeshTangents({ ...mesh, positions }),
    ).toThrowError(Forge3DError);
    const normals = Float32Array.from(mesh.normals);
    normals[3] = Number.POSITIVE_INFINITY;
    expect(() =>
      generateMeshTangents({ ...mesh, normals }),
    ).toThrowError(Forge3DError);
    const uvs = Float32Array.from(mesh.uvs);
    uvs[2] = Number.NEGATIVE_INFINITY;
    expect(() =>
      generateMeshTangents({ ...mesh, uvs }),
    ).toThrowError(Forge3DError);
  });

  it("rejects malformed inputs", () => {
    const mesh = plane();
    expect(() =>
      generateMeshTangents({ ...mesh, normals: new Float32Array(6) }),
    ).toThrowError(Forge3DError);
    expect(() =>
      generateMeshTangents({ ...mesh, uvs: new Float32Array(6) }),
    ).toThrowError(Forge3DError);
    expect(() =>
      generateMeshTangents({
        ...mesh,
        indices: new Uint32Array([0, 1, 9]),
      }),
    ).toThrowError(Forge3DError);
    expect(() =>
      generateMeshTangents({ ...mesh, indices: new Uint32Array([0, 1]) }),
    ).toThrowError(Forge3DError);
    expect(() =>
      generateMeshTangents({
        ...mesh,
        positions: new Float32Array(4),
      }),
    ).toThrowError(Forge3DError);
  });
});

describe("extractGltfMaterialChannels", () => {
  it("splits occlusion/roughness/metallic channels independently", () => {
    const data = new Uint8Array([
      10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 64, 100, 110, 120, 32,
    ]);
    const channels = extractGltfMaterialChannels(data, 2, 2);
    expect([...channels.occlusion]).toEqual([10, 40, 70, 100]);
    expect([...channels.roughness]).toEqual([20, 50, 80, 110]);
    expect([...channels.metallic]).toEqual([30, 60, 90, 120]);
    channels.occlusion[0] = 0;
    expect(data[0]).toBe(10);
  });

  it("rejects wrong payload sizes", () => {
    expect(() =>
      extractGltfMaterialChannels(new Uint8Array(15), 2, 2),
    ).toThrowError(Forge3DError);
    expect(() =>
      extractGltfMaterialChannels(new Uint8Array(16), 0, 2),
    ).toThrowError(Forge3DError);
  });

  it("rejects oversized and unsafe dimensions before reading data", () => {
    for (const [width, height] of [
      [16385, 1],
      [1, 16385],
      [16384, 16384],
      [Number.MAX_SAFE_INTEGER, 1],
      [2.5, 2],
      [-1, 2],
    ] as const) {
      expect(
        () => extractGltfMaterialChannels(new Uint8Array(16), width, height),
        `${width}x${height}`,
      ).toThrowError(Forge3DError);
    }
  });
});

function ktx2Fixture(
  vkFormat: number,
  payload: Uint8Array,
  width = 2,
  height = 2,
): Uint8Array {
  const container = createDefaultContainer();
  container.vkFormat = vkFormat;
  container.pixelWidth = width;
  container.pixelHeight = height;
  container.pixelDepth = 0;
  container.layerCount = 0;
  container.faceCount = 1;
  container.levelCount = 1;
  container.levels = [
    { levelData: payload, uncompressedByteLength: payload.byteLength },
  ];
  return write(container);
}

const ALL_CAPS = { bc: true, etc2: true, astc: true };

describe("Ktx2Loader", () => {
  it("loads a direct rgba8unorm container", async () => {
    const loader = new Ktx2Loader();
    const image = await loader.load(
      ktx2Fixture(37, new Uint8Array(16).fill(200)),
      { semantic: "metallic-roughness", capabilities: ALL_CAPS },
    );
    expect(image.format).toBe("rgba8unorm");
    expect(image.colorSpace).toBe("linear");
    expect(image.compressed).toBe(false);
    expect(image.sourceFormat).toBe("ktx2");
    expect(image.effectiveQuality).toBe("native");
    expect(image.levels[0]?.data[0]).toBe(200);
    const report = loader.getLastReport();
    expect(report?.effectiveFormat).toBe("rgba8unorm");
    expect(report?.effectiveQuality).toBe("native");
  });

  it("loads a direct sRGB container for base color", async () => {
    const loader = new Ktx2Loader();
    const image = await loader.load(
      ktx2Fixture(43, new Uint8Array(16).fill(128)),
      { semantic: "base-color", capabilities: ALL_CAPS },
    );
    expect(image.format).toBe("rgba8unorm-srgb");
    expect(image.colorSpace).toBe("srgb");
  });

  it("loads compressed formats when the capability is present", async () => {
    const loader = new Ktx2Loader();
    const image = await loader.load(
      ktx2Fixture(131, new Uint8Array(8), 4, 4),
      { semantic: "normal", capabilities: ALL_CAPS },
    );
    expect(image.format).toBe("bc1-rgba-unorm");
    expect(image.compressed).toBe(true);
  });

  it("rejects compressed formats without the device feature", async () => {
    const loader = new Ktx2Loader();
    await expect(
      loader.load(ktx2Fixture(131, new Uint8Array(8), 4, 4), {
        semantic: "normal",
        capabilities: { bc: false, etc2: true, astc: true },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    const report = loader.getLastReport();
    expect(report?.effectiveFormat).toBe("unsupported");
    expect(report?.effectiveQuality).toBe("unsupported");
    expect(report?.reason).toContain("texture-compression-bc");
  });

  it("enforces the semantic color contract", async () => {
    const loader = new Ktx2Loader();
    await expect(
      loader.load(ktx2Fixture(43, new Uint8Array(16)), {
        semantic: "normal",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toThrowError(Forge3DError);
  });

  it("rejects corrupt containers", async () => {
    const loader = new Ktx2Loader();
    await expect(
      loader.load(new Uint8Array([1, 2, 3, 4]), {
        semantic: "base-color",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const truncated = ktx2Fixture(37, new Uint8Array(16)).slice(0, 40);
    await expect(
      loader.load(truncated, {
        semantic: "base-color",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toThrowError(Forge3DError);
  });

  it("rejects payloads exceeding maxBytes", async () => {
    const loader = new Ktx2Loader();
    await expect(
      loader.load(ktx2Fixture(37, new Uint8Array(16)), {
        semantic: "base-color",
        capabilities: ALL_CAPS,
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
  });

  it("honours the abort signal", async () => {
    const loader = new Ktx2Loader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loader.load(ktx2Fixture(37, new Uint8Array(16)), {
        semantic: "base-color",
        capabilities: ALL_CAPS,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("routes basis containers through the injected adapter", async () => {
    const basisContainer = (transferFunction: number) => {
      const container = createDefaultContainer();
      container.vkFormat = 0;
      container.pixelWidth = 2;
      container.pixelHeight = 2;
      container.pixelDepth = 0;
      container.layerCount = 0;
      container.faceCount = 1;
      container.levelCount = 1;
      container.supercompressionScheme = KHR_SUPERCOMPRESSION_BASISLZ;
      container.dataFormatDescriptor[0]!.transferFunction = transferFunction;
      container.levels = [
        { levelData: new Uint8Array(8).fill(9), uncompressedByteLength: 0 },
      ];
      return write(container);
    };
    const bytes = basisContainer(KHR_DF_TRANSFER_SRGB);
    const bytesLinear = basisContainer(KHR_DF_TRANSFER_LINEAR);

    const calls: { target: string; colorSpace: string }[] = [];
    const loader = new Ktx2Loader({
      basisTranscoder: {
        transcode(data, target, colorSpace) {
          calls.push({ target, colorSpace });
          const snapshot: TextureImageSnapshot = {
            width: 2,
            height: 2,
            format: target,
            colorSpace,
            levels: [
              {
                width: 2,
                height: 2,
                data:
                  target === "rgba8unorm" || target === "rgba8unorm-srgb"
                    ? new Uint8Array(16).fill(1)
                    : new Uint8Array(16).fill(2),
              },
            ],
            compressed: target !== "rgba8unorm" && target !== "rgba8unorm-srgb",
            sourceFormat: "basis",
            effectiveQuality:
              target === "rgba8unorm" || target === "rgba8unorm-srgb"
                ? "rgba8-fallback"
                : "transcoded",
          };
          return Promise.resolve(snapshot);
        },
      },
    });

    const compressed = await loader.load(bytes, {
      semantic: "base-color",
      capabilities: ALL_CAPS,
    });
    expect(compressed.format).toBe("astc-4x4-unorm-srgb");
    expect(compressed.effectiveQuality).toBe("transcoded");
    expect(compressed.sourceFormat).toBe("basis");
    expect(calls[0]).toEqual({
      target: "astc-4x4-unorm-srgb",
      colorSpace: "srgb",
    });
    expect(loader.getLastReport()?.requestedFormat).toBe("basis");

    const fallback = await loader.load(bytesLinear, {
      semantic: "occlusion",
      capabilities: { bc: false, etc2: false, astc: false },
    });
    expect(fallback.format).toBe("rgba8unorm");
    expect(fallback.effectiveQuality).toBe("rgba8-fallback");
    expect(calls[1]).toEqual({ target: "rgba8unorm", colorSpace: "linear" });
    expect(loader.getLastReport()?.effectiveQuality).toBe("rgba8-fallback");
  });

  function basisFixture(
    width: number,
    height: number,
    transferFunction = KHR_DF_TRANSFER_SRGB,
  ): Uint8Array {
    const container = createDefaultContainer();
    container.vkFormat = 0;
    container.pixelWidth = width;
    container.pixelHeight = height;
    container.pixelDepth = 0;
    container.layerCount = 0;
    container.faceCount = 1;
    container.levelCount = 1;
    container.supercompressionScheme = KHR_SUPERCOMPRESSION_BASISLZ;
    container.dataFormatDescriptor[0]!.transferFunction = transferFunction;
    container.levels = [
      { levelData: new Uint8Array(8), uncompressedByteLength: 0 },
    ];
    return write(container);
  }

  it("rejects basis transcode budgets before invoking the adapter", async () => {
    let called = 0;
    const loader = new Ktx2Loader({
      basisTranscoder: {
        transcode() {
          called += 1;
          return Promise.reject(new Error("adapter must not run"));
        },
      },
    });
    await expect(
      loader.load(basisFixture(16384, 16384), {
        semantic: "base-color",
        capabilities: ALL_CAPS,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
    expect(called).toBe(0);
  });

  it("rejects basis adapter output exceeding maxBytes or wrong shape", async () => {
    const oversized = new Ktx2Loader({
      basisTranscoder: {
        transcode(_data, target, colorSpace) {
          return Promise.resolve({
            width: 2,
            height: 2,
            format: target,
            colorSpace,
            levels: [
              { width: 2, height: 2, data: new Uint8Array(16) },
              { width: 1, height: 1, data: new Uint8Array(4) },
            ],
            compressed: false,
            sourceFormat: "basis",
            effectiveQuality: "rgba8-fallback",
          });
        },
      },
    });
    await expect(
      oversized.load(basisFixture(2, 2, KHR_DF_TRANSFER_LINEAR), {
        semantic: "occlusion",
        capabilities: { bc: false, etc2: false, astc: false },
        maxBytes: 18,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });

    let calls = 0;
    const wrongDims = new Ktx2Loader({
      basisTranscoder: {
        transcode(_data, target, colorSpace) {
          calls += 1;
          return Promise.resolve({
            width: 4,
            height: 4,
            format: target,
            colorSpace,
            levels: [
              { width: 4, height: 4, data: new Uint8Array(16) },
            ],
            compressed: target !== "rgba8unorm" && target !== "rgba8unorm-srgb",
            sourceFormat: "basis",
            effectiveQuality:
              target === "rgba8unorm" || target === "rgba8unorm-srgb"
                ? "rgba8-fallback"
                : "transcoded",
          });
        },
      },
    });
    await expect(
      wrongDims.load(basisFixture(2, 2, KHR_DF_TRANSFER_LINEAR), {
        semantic: "occlusion",
        capabilities: { bc: false, etc2: false, astc: false },
      }),
    ).rejects.toThrowError(Forge3DError);
    expect(calls).toBe(1);
  });

  it("derives direct color space from the mapped format", async () => {
    const loader = new Ktx2Loader();
    const linear = await loader.load(
      ktx2Fixture(37, new Uint8Array(16).fill(200)),
      { semantic: "base-color", capabilities: ALL_CAPS },
    );
    expect(linear.colorSpace).toBe("linear");
    expect(linear.format).toBe("rgba8unorm");
    await expect(
      loader.load(ktx2Fixture(43, new Uint8Array(16)), {
        semantic: "normal",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toThrowError(Forge3DError);
  });

  it("derives basis target from the DFD transfer function", async () => {
    const calls: { target: string; colorSpace: string }[] = [];
    const loader = new Ktx2Loader({
      basisTranscoder: {
        transcode(_data, target, colorSpace) {
          calls.push({ target, colorSpace });
          const bytes = Math.ceil(2 / 4) * Math.ceil(2 / 4) * 16;
          return Promise.resolve({
            width: 2,
            height: 2,
            format: target,
            colorSpace,
            levels: [{ width: 2, height: 2, data: new Uint8Array(bytes) }],
            compressed: true,
            sourceFormat: "basis",
            effectiveQuality: "transcoded",
          });
        },
      },
    });
    const image = await loader.load(
      basisFixture(2, 2, KHR_DF_TRANSFER_LINEAR),
      { semantic: "base-color", capabilities: ALL_CAPS },
    );
    expect(image.format).toBe("astc-4x4-unorm");
    expect(image.colorSpace).toBe("linear");
    expect(calls[0]).toEqual({
      target: "astc-4x4-unorm",
      colorSpace: "linear",
    });
  });

  it("rejects basis sRGB payloads for data semantics and bad transfers", async () => {
    const adapter = {
      transcode() {
        return Promise.reject(new Error("adapter must not run"));
      },
    };
    const loader = new Ktx2Loader({ basisTranscoder: adapter });
    await expect(
      loader.load(basisFixture(2, 2, KHR_DF_TRANSFER_SRGB), {
        semantic: "normal",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    expect(loader.getLastReport()?.effectiveFormat).toBe("unsupported");

    await expect(
      loader.load(basisFixture(2, 2, 0), {
        semantic: "base-color",
        capabilities: ALL_CAPS,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    expect(loader.getLastReport()?.reason).toContain("transfer");
  });
});

describe("bundled basis loader source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src-ts/textures.ts", import.meta.url)),
    "utf8",
  );

  it("contains no eval, new Function, or remote fallback", () => {
    expect(source).not.toContain("new Function");
    expect(source).not.toContain("eval(");
    expect(source).not.toContain("unsafe-eval");
    expect(source).not.toContain("https://");
    expect(source).not.toContain("http://");
    expect(source).not.toContain("unpkg");
    expect(source).not.toContain("cdn");
    expect(source).not.toContain("fetch(");
  });

  it("keeps default URLs under ../assets/basis/", () => {
    expect(source).toContain('"../assets/basis/basis_transcoder.js"');
    expect(source).toContain('"../assets/basis/basis_transcoder.wasm"');
  });

  it("keys the module coordinator by URL pair and evicts failures", () => {
    expect(source).toContain("JSON.stringify([jsUrl, wasmUrl])");
    expect(source).toContain("store.modules.delete(key)");
  });
});
