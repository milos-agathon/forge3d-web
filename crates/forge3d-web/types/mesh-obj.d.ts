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
export declare function parseMtl(text: string): ObjMaterial[];
export declare function parseObj(text: string, mtlTexts?: Readonly<Record<string, string>>): ObjImport;
export declare function encodeObj(input: MeshInput, metadata?: Pick<ObjImport, "groups" | "objects" | "materialGroups" | "materialLibraries">): string;
export declare function encodeMtl(materials: readonly ObjMaterial[]): string;
