import { meshNumber } from "./mesh.js";
export interface BuildingMaterial {
  albedo: [number, number, number];
  roughness: number;
  metallic: number;
  ior: number;
  emissive: number;
}
const presets: Record<
  string,
  [number, number, number, number, number?, number?]
> = {
  brick: [0.55, 0.25, 0.18, 0.75],
  brick_old: [0.45, 0.22, 0.15, 0.85],
  concrete: [0.6, 0.58, 0.55, 0.7],
  concrete_weathered: [0.45, 0.42, 0.4, 0.8],
  glass: [0.04, 0.04, 0.05, 0.1, 0, 1.52],
  steel: [0.56, 0.57, 0.58, 0.35, 0.9, 2.5],
  aluminum: [0.91, 0.92, 0.92, 0.3, 0.95, 1.44],
  wood: [0.5, 0.35, 0.2, 0.7],
  wood_painted: [0.9, 0.9, 0.88, 0.5],
  plaster: [0.88, 0.86, 0.82, 0.65],
  stone: [0.65, 0.6, 0.5, 0.6],
  sandstone: [0.76, 0.65, 0.45, 0.7],
  granite: [0.35, 0.33, 0.32, 0.4],
  marble: [0.92, 0.9, 0.88, 0.25],
  roof_tiles: [0.6, 0.3, 0.15, 0.7],
  roof_metal: [0.6, 0.6, 0.62, 0.4, 0.7, 2],
  roof_shingles: [0.25, 0.25, 0.27, 0.9],
  roof_slate: [0.3, 0.32, 0.35, 0.5],
};
const aliases: Record<string, string> = {
  bricks: "brick",
  old_brick: "brick_old",
  weathered_brick: "brick_old",
  cement: "concrete",
  weathered_concrete: "concrete_weathered",
  metal: "steel",
  aluminium: "aluminum",
  timber: "wood",
  painted_wood: "wood_painted",
  stucco: "plaster",
  render: "plaster",
  limestone: "stone",
  tiles: "roof_tiles",
  terracotta: "roof_tiles",
  metal_roof: "roof_metal",
  shingles: "roof_shingles",
  asphalt: "roof_shingles",
  slate: "roof_slate",
};
export function buildingMaterialFromName(name: string): BuildingMaterial {
  const key = name.toLowerCase().trim(),
    v = presets[aliases[key] ?? key];
  return v
    ? {
        albedo: [v[0], v[1], v[2]],
        roughness: v[3],
        metallic: v[4] ?? 0,
        ior: v[5] ?? 1.5,
        emissive: 0,
      }
    : {
        albedo: [0.7, 0.7, 0.7],
        roughness: 0.6,
        metallic: 0,
        ior: 1.5,
        emissive: 0,
      };
}
export function parseBuildingColor(
  color: string,
): [number, number, number] | null {
  const named: Record<string, [number, number, number]> = {
    white: [1, 1, 1],
    black: [0, 0, 0],
    red: [1, 0, 0],
    green: [0, 0.5, 0],
    blue: [0, 0, 1],
    yellow: [1, 1, 0],
    gray: [0.5, 0.5, 0.5],
    grey: [0.5, 0.5, 0.5],
    brown: [0.6, 0.3, 0.1],
    beige: [0.96, 0.96, 0.86],
  };
  let s = color.trim().toLowerCase();
  if (named[s]) return [...named[s]!];
  if (/^#[\da-f]{3}$/.test(s))
    s = "#" + [...s.slice(1)].map((x) => x + x).join("");
  if (!/^#[\da-f]{6}$/.test(s)) return null;
  return [
    parseInt(s.slice(1, 3), 16) / 255,
    parseInt(s.slice(3, 5), 16) / 255,
    parseInt(s.slice(5, 7), 16) / 255,
  ];
}
export function buildingMaterialFromTags(
  tags: Readonly<Record<string, unknown>>,
): BuildingMaterial {
  for (const key of [
    "building:material",
    "building:facade:material",
    "material",
  ])
    if (typeof tags[key] === "string")
      return buildingMaterialFromName(tags[key] as string);
  for (const key of ["building:colour", "building:color"])
    if (typeof tags[key] === "string") {
      const color = parseBuildingColor(tags[key] as string);
      if (color) return { ...buildingMaterialFromName(""), albedo: color };
    }
  const type = String(tags.building ?? "").toLowerCase(),
    map: Record<string, string> = {
      commercial: "glass",
      office: "glass",
      retail: "glass",
      skyscraper: "glass",
      industrial: "concrete",
      warehouse: "concrete",
      hangar: "concrete",
      house: "brick",
      detached: "brick",
      semidetached_house: "brick",
      terrace: "brick",
      residential: "brick",
      apartments: "concrete",
      church: "stone",
      cathedral: "stone",
      castle: "stone",
      palace: "stone",
      monument: "stone",
      barn: "wood",
      farm: "wood",
      cabin: "wood",
      shed: "wood",
      public: "stone",
      civic: "stone",
      government: "stone",
      hotel: "glass",
    };
  return buildingMaterialFromName(map[type] ?? "");
}
export function roofMaterialFromTags(
  tags: Readonly<Record<string, unknown>>,
): BuildingMaterial {
  for (const key of ["roof:material", "building:roof:material"])
    if (typeof tags[key] === "string")
      return buildingMaterialFromName(tags[key] as string);
  for (const key of ["roof:colour", "roof:color"])
    if (typeof tags[key] === "string") {
      const color = parseBuildingColor(tags[key] as string);
      if (color)
        return {
          ...buildingMaterialFromName(""),
          roughness: 0.6,
          albedo: color,
        };
    }
  const type = String(tags.building ?? "").toLowerCase();
  return buildingMaterialFromName(
    ["house", "detached", "residential"].includes(type)
      ? "roof_tiles"
      : ["industrial", "warehouse", "commercial"].includes(type)
        ? "roof_metal"
        : ["church", "cathedral"].includes(type)
          ? "roof_slate"
          : "roof_shingles",
  );
}
export type RoofType =
  | "flat"
  | "gabled"
  | "hipped"
  | "pyramidal"
  | "dome"
  | "mansard"
  | "shed"
  | "gambrel"
  | "onion"
  | "skillion";
export function inferRoofType(
  tags: Readonly<Record<string, unknown>>,
): RoofType {
  for (const key of ["building:roof:shape", "roof:shape", "roof_shape"])
    if (typeof tags[key] === "string") {
      const s = (tags[key] as string).toLowerCase().trim();
      if (["lean_to", "lean-to"].includes(s)) return "shed";
      return [
        "flat",
        "gabled",
        "hipped",
        "pyramidal",
        "dome",
        "mansard",
        "shed",
        "gambrel",
        "onion",
        "skillion",
      ].includes(s)
        ? (s as RoofType)
        : "flat";
    }
  const t = String(tags.building ?? "").toLowerCase();
  if (
    [
      "house",
      "detached",
      "semidetached_house",
      "terrace",
      "residential",
      "bungalow",
      "cabin",
      "farm",
      "barn",
    ].includes(t)
  )
    return "gabled";
  if (["apartments", "dormitory", "hotel", "temple", "shrine"].includes(t))
    return "hipped";
  if (["church", "cathedral", "chapel", "mosque"].includes(t))
    return tags.religion === "christian" &&
      String(tags.denomination ?? "").includes("orthodox")
      ? "onion"
      : "gabled";
  if (["greenhouse", "shed", "carport"].includes(t)) return "shed";
  return "flat";
}
export function normalizeBuildingMaterial(
  input: Partial<BuildingMaterial> = {},
): BuildingMaterial {
  const m = {
    ...buildingMaterialFromName(""),
    ...input,
    albedo: [...(input.albedo ?? [0.7, 0.7, 0.7])] as [number, number, number],
  };
  for (const x of m.albedo) meshNumber(x, "albedo", 0, 1);
  meshNumber(m.roughness, "roughness", 0, 1);
  meshNumber(m.metallic, "metallic", 0, 1);
  meshNumber(m.ior, "ior", 1);
  meshNumber(m.emissive, "emissive", 0);
  return m;
}
