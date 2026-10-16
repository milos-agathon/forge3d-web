import { describe, expect, it } from "vitest";

import {
  Forge3DError,
  MaterialCollection,
  resolveBrdfModel,
  type BrdfModel,
} from "../../src-ts/index.js";

const CANONICAL: readonly BrdfModel[] = [
  "lambert",
  "phong",
  "blinn-phong",
  "oren-nayar",
  "cooktorrance-ggx",
  "cooktorrance-beckmann",
  "disney-principled",
  "ashikhmin-shirley",
  "ward",
  "toon",
  "minnaert",
  "subsurface",
  "hair",
];

function pointMaterial(): Parameters<MaterialCollection["set"]>[1] {
  return {
    id: "hero",
    brdf: "oren-nayar",
    baseColor: [0.5, 0.4, 0.3, 1],
    metallic: 0.1,
    roughness: 0.7,
    sheen: 0.2,
    clearcoat: 0.1,
    subsurface: 0.05,
    anisotropy: 0.3,
  };
}

describe("resolveBrdfModel", () => {
  it("routes canonical models exactly", () => {
    for (const model of CANONICAL) {
      const route = resolveBrdfModel(model);
      expect(route.requested).toBe(model);
      expect(route.model).toBe(model);
      if (model === "blinn-phong") {
        expect(route.effectiveModel).toBe("phong");
        expect(route.implementation).toBe("alias");
        expect(route.diagnostic).toBe(
          "blinn-phong is rendered by the normalized phong route",
        );
      } else if (model === "subsurface") {
        expect(route.effectiveModel).toBe("disney-principled");
        expect(route.implementation).toBe("approximation");
        expect(route.diagnostic).toBe(
          "subsurface is approximated by disney-principled with the subsurface lobe",
        );
      } else if (model === "hair") {
        expect(route.effectiveModel).toBe("ashikhmin-shirley");
        expect(route.implementation).toBe("approximation");
        expect(route.diagnostic).toBe(
          "hair is approximated by ashikhmin-shirley anisotropy",
        );
      } else {
        expect(route.effectiveModel).toBe(model);
        expect(route.implementation).toBe("exact");
        expect(route.diagnostic).toBeUndefined();
      }
    }
  });

  it("resolves alternate spellings as aliases", () => {
    const aliases: [string, BrdfModel][] = [
      ["blinnphong", "blinn-phong"],
      ["  Blinn_Phong  ", "blinn-phong"],
      ["oren nayar", "oren-nayar"],
      ["orennayar", "oren-nayar"],
      ["cook-torrance-ggx", "cooktorrance-ggx"],
      ["cooktorranceggx", "cooktorrance-ggx"],
      ["ggx", "cooktorrance-ggx"],
      ["GGX", "cooktorrance-ggx"],
      ["cook-torrance-beckmann", "cooktorrance-beckmann"],
      ["cooktorrancebeckmann", "cooktorrance-beckmann"],
      ["beckmann", "cooktorrance-beckmann"],
      ["disneyprincipled", "disney-principled"],
      ["disney", "disney-principled"],
      ["ashikhminshirley", "ashikhmin-shirley"],
      ["sss", "subsurface"],
      ["kajiyakay", "hair"],
      ["kajiya-kay", "hair"],
      // Native normalize_key also drops '.' and hyphens anywhere.
      ["Oren.Nayar", "oren-nayar"],
      ["cook_torrance.ggx", "cooktorrance-ggx"],
      ["Kajiya Kay", "hair"],
      ["MINNAERT", "minnaert"],
    ];
    for (const [input, model] of aliases) {
      const route = resolveBrdfModel(input);
      expect(route.requested).toBe(input);
      expect(route.model).toBe(model);
    }
    // Must match forge3d-core resolve_brdf, which re-validates every commit.
    expect(resolveBrdfModel("Oren.Nayar").diagnostic).toBe(
      "oren.nayar is an alias for oren-nayar",
    );
    const ggx = resolveBrdfModel("ggx");
    expect(ggx.implementation).toBe("alias");
    expect(ggx.effectiveModel).toBe("cooktorrance-ggx");
    expect(ggx.diagnostic).toBe("ggx is an alias for cooktorrance-ggx");
  });

  it("mentions both facts when an alias resolves into an approximation", () => {
    const sss = resolveBrdfModel("sss");
    expect(sss.implementation).toBe("approximation");
    expect(sss.diagnostic).toBe(
      "subsurface is approximated by disney-principled with the subsurface lobe; input alias sss resolves to subsurface",
    );
    const hair = resolveBrdfModel("kajiya-kay");
    expect(hair.implementation).toBe("approximation");
    expect(hair.diagnostic).toBe(
      "hair is approximated by ashikhmin-shirley anisotropy; input alias kajiya-kay resolves to hair",
    );
  });

  it("treats case and whitespace normalization as the same route", () => {
    const blinn = resolveBrdfModel("  Blinn_Phong  ");
    expect(blinn.requested).toBe("  Blinn_Phong  ");
    expect(blinn.model).toBe("blinn-phong");
    expect(blinn.implementation).toBe("alias");
    expect(blinn.diagnostic).toBe(
      "blinn-phong is rendered by the normalized phong route",
    );
    const oren = resolveBrdfModel("Oren Nayar");
    expect(oren.model).toBe("oren-nayar");
    expect(oren.implementation).toBe("exact");
    expect(oren.diagnostic).toBeUndefined();
  });

  it("rejects unknown models", () => {
    for (const bad of ["custom-brdf", "", "ward-ish", "  "]) {
      try {
        resolveBrdfModel(bad);
        expect.unreachable(`${bad} should reject`);
      } catch (error) {
        expect(error).toBeInstanceOf(Forge3DError);
        expect((error as Forge3DError).code).toBe("INVALID_INPUT");
      }
    }
  });
});

describe("MaterialCollection", () => {
  it("starts with the default slot at index 0 and revision 0", () => {
    const materials = new MaterialCollection();
    expect(materials.size).toBe(1);
    expect(materials.maxMaterials).toBe(256);
    expect(materials.revision).toBe(0);
    const fallback = materials.get("default");
    expect(fallback).toBeDefined();
    expect(fallback!.id).toBe("default");
    expect(fallback!.brdf).toBe("cooktorrance-ggx");
    expect(fallback!.baseColor).toEqual([1, 1, 1, 1]);
    expect(fallback!.metallic).toBe(0);
    expect(fallback!.roughness).toBe(0.5);
    expect(fallback!.sheen).toBe(0);
    expect(fallback!.clearcoat).toBe(0);
    expect(fallback!.subsurface).toBe(0);
    expect(fallback!.anisotropy).toBe(0);
    expect(fallback!.route.model).toBe("cooktorrance-ggx");
    expect(materials.values().map((entry) => entry.slot)).toEqual(["default"]);
    expect(materials.values()[0]!.index).toBe(0);
  });

  it("validates maxMaterials bounds", () => {
    for (const bad of [0, 257, 1.5, Number.NaN, -1]) {
      expect(() => new MaterialCollection(bad)).toThrowError(Forge3DError);
    }
    expect(new MaterialCollection(1).maxMaterials).toBe(1);
  });

  it("assigns stable monotonically increasing indices", () => {
    const materials = new MaterialCollection();
    materials.set("hero", pointMaterial());
    materials.set("prop", { id: "prop", brdf: "lambert" });
    const entries = materials.values();
    const hero = entries.find((entry) => entry.slot === "hero")!;
    const prop = entries.find((entry) => entry.slot === "prop")!;
    expect(hero.index).toBe(1);
    expect(prop.index).toBe(2);
    materials.remove("hero");
    materials.set("boss", { id: "boss" });
    const boss = materials.get("boss")!;
    expect(materials.values().find((e) => e.slot === "boss")!.index).toBe(3);
    expect(boss.brdf).toBe("cooktorrance-ggx");
    materials.set("prop", { id: "prop2", brdf: "ward" });
    expect(materials.values().find((e) => e.slot === "prop")!.index).toBe(2);
  });

  it("rejects inserts at maxMaterials", () => {
    const materials = new MaterialCollection(1);
    try {
      materials.set("hero", pointMaterial());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Forge3DError);
      expect((error as Forge3DError).code).toBe("INVALID_INPUT");
      expect((error as Forge3DError).message).toContain("maximum of 1");
    }
  });

  it("rejects empty slots and ids and invalid field ranges", () => {
    const materials = new MaterialCollection();
    expect(() => materials.set("", pointMaterial())).toThrowError(Forge3DError);
    expect(() =>
      materials.set("hero", { ...pointMaterial(), id: "" }),
    ).toThrowError(Forge3DError);
    for (const [field, value] of [
      ["baseColor", [1.5, 0, 0, 1]],
      ["baseColor", [0, 0, 0]],
      ["metallic", -0.1],
      ["roughness", Number.NaN],
      ["sheen", 2],
      ["clearcoat", -1],
      ["subsurface", 1.5],
      ["anisotropy", 2],
      ["anisotropy", -1.01],
      ["brdf", "not-a-model"],
    ] as const) {
      expect(() =>
        materials.set("hero", {
          ...pointMaterial(),
          [field]: value,
        }),
      ).toThrowError(Forge3DError);
    }
  });

  it("clear restores the canonical default route when only the route differs", () => {
    const materials = new MaterialCollection();
    materials.set("default", { id: "default", brdf: "ggx" });
    expect(materials.get("default")!.route.requested).toBe("ggx");
    const revision = materials.revision;
    materials.clear();
    expect(materials.revision).toBe(revision + 1);
    const restored = materials.get("default")!;
    expect(restored.route.requested).toBe("cooktorrance-ggx");
    expect(restored.route.implementation).toBe("exact");
    expect(restored.route.diagnostic).toBeUndefined();
  });

  it("round-trips alias and approximation routes through snapshots exactly", () => {
    const materials = new MaterialCollection();
    materials.set("hero", { id: "hero", brdf: "ggx" });
    materials.set("skin", { id: "skin", brdf: "sss" });
    materials.set("hair", { id: "hair", brdf: "kajiya-kay" });
    materials.set("weird", { id: "weird", brdf: "  Blinn_Phong  " });
    const snapshot = materials.snapshot();
    const restored = MaterialCollection.from(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.get("skin")!.route.requested).toBe("sss");
    expect(restored.get("skin")!.route.implementation).toBe("approximation");
    expect(restored.get("skin")!.route.diagnostic).toBe(
      "subsurface is approximated by disney-principled with the subsurface lobe; input alias sss resolves to subsurface",
    );
    expect(restored.get("weird")!.route.requested).toBe("  Blinn_Phong  ");
  });

  it("rejects tampered routes and brdf mismatches in snapshots", () => {
    const materials = new MaterialCollection();
    materials.set("hero", { id: "hero", brdf: "sss" });
    const snapshot = materials.snapshot();
    const hero = snapshot.materials.find((entry) => entry.slot === "hero")!;
    const tamper = (mutate: (route: Record<string, unknown>) => void) => {
      const copy = structuredClone(snapshot);
      const entry = copy.materials.find((e) => e.slot === "hero")!;
      mutate(entry.material.route as unknown as Record<string, unknown>);
      expect(() => MaterialCollection.from(copy)).toThrowError(Forge3DError);
    };
    tamper((route) => {
      route.model = "subsurface-alt";
    });
    tamper((route) => {
      route.effectiveModel = "phong";
    });
    tamper((route) => {
      route.implementation = "exact";
    });
    tamper((route) => {
      route.diagnostic = "tampered";
    });
    tamper((route) => {
      delete route.diagnostic;
    });
    tamper((route) => {
      route.requested = "ward";
    });
    const brdfMismatch = structuredClone(snapshot);
    brdfMismatch.materials.find(
      (e) => e.slot === "hero",
    )!.material.brdf = "ward" as never;
    expect(() => MaterialCollection.from(brdfMismatch)).toThrowError(
      Forge3DError,
    );
    expect(hero.material.route.model).toBe("subsurface");
  });

  it("never removes the default slot and clear restores it", () => {
    const materials = new MaterialCollection();
    expect(materials.remove("default")).toBe(false);
    materials.set("default", { id: "changed", brdf: "toon", roughness: 0.9 });
    materials.set("hero", pointMaterial());
    const revision = materials.revision;
    materials.clear();
    expect(materials.revision).toBe(revision + 1);
    expect(materials.size).toBe(1);
    const restored = materials.get("default")!;
    expect(restored.id).toBe("default");
    expect(restored.brdf).toBe("cooktorrance-ggx");
    expect(restored.roughness).toBe(0.5);
    const afterClear = materials.revision;
    materials.clear();
    expect(materials.revision).toBe(afterClear);
  });

  it("routes slots through the shared table", () => {
    const materials = new MaterialCollection();
    materials.set("hero", { id: "hero", brdf: "sss" });
    const route = materials.route("hero");
    expect(route.model).toBe("subsurface");
    expect(route.effectiveModel).toBe("disney-principled");
    expect(materials.route("default").implementation).toBe("exact");
    expect(() => materials.route("missing")).toThrowError(Forge3DError);
  });

  it("defensively copies inputs and outputs", () => {
    const materials = new MaterialCollection();
    const input = pointMaterial();
    const color = input.baseColor!;
    materials.set("hero", input);
    color[0] = 9;
    input.id = "mutated";
    const stored = materials.get("hero")!;
    expect(stored.id).toBe("hero");
    expect(stored.baseColor).toEqual([0.5, 0.4, 0.3, 1]);
    stored.baseColor[0] = 9;
    expect(materials.get("hero")!.baseColor[0]).toBe(0.5);
    const snapshot = materials.snapshot();
    snapshot.materials[0]!.material.baseColor[0] = 9;
    expect(materials.get("default")!.baseColor[0]).toBe(1);
    const copy = materials.copy();
    copy.set("hero", { id: "hero", baseColor: [0, 0, 0, 1] });
    expect(materials.get("hero")!.baseColor[0]).toBe(0.5);
  });

  it("restores from snapshots with preserved indices", () => {
    const materials = new MaterialCollection();
    materials.set("hero", pointMaterial());
    materials.remove("hero");
    materials.set("boss", { id: "boss", brdf: "ward" });
    const snapshot = materials.snapshot();
    const restored = MaterialCollection.from(snapshot);
    expect(restored.values().find((e) => e.slot === "boss")!.index).toBe(
      materials.values().find((e) => e.slot === "boss")!.index,
    );
    restored.set("extra", { id: "extra" });
    const extraIndex = restored.values().find((e) => e.slot === "extra")!.index;
    expect(extraIndex).toBeGreaterThan(2);
    expect(() =>
      MaterialCollection.from({ ...snapshot, maxMaterials: 0 }),
    ).toThrowError(Forge3DError);
    expect(() =>
      MaterialCollection.from({
        ...snapshot,
        materials: [],
      }),
    ).toThrowError(Forge3DError);
  });

  it("estimates gpu bytes as maxMaterials*64+16", () => {
    expect(new MaterialCollection().estimatedGpuBytes()).toBe(256 * 64 + 16);
    expect(new MaterialCollection(8).estimatedGpuBytes()).toBe(8 * 64 + 16);
  });
});
