export interface BuildingMaterial {
    albedo: [number, number, number];
    roughness: number;
    metallic: number;
    ior: number;
    emissive: number;
}
export declare function buildingMaterialFromName(name: string): BuildingMaterial;
export declare function parseBuildingColor(color: string): [number, number, number] | null;
export declare function buildingMaterialFromTags(tags: Readonly<Record<string, unknown>>): BuildingMaterial;
export declare function roofMaterialFromTags(tags: Readonly<Record<string, unknown>>): BuildingMaterial;
export type RoofType = "flat" | "gabled" | "hipped" | "pyramidal" | "dome" | "mansard" | "shed" | "gambrel" | "onion" | "skillion";
export declare function inferRoofType(tags: Readonly<Record<string, unknown>>): RoofType;
export declare function normalizeBuildingMaterial(input?: Partial<BuildingMaterial>): BuildingMaterial;
