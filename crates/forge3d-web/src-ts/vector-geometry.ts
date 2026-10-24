import {planVectorWork} from "./vector-work-plan.js";
export {triangulateVectorPolygon} from "./vector-triangulation.js";
import { vectorInvalid, VectorLayers } from "./vector-layers.js";
import { TerrainDataset } from "./terrain-dataset.js";
import type { TerrainHeightmapInput } from "./index.js";
import type { VectorPosition, VectorSnapshot, VectorSelectionStyle } from "./vector-types.js";
export interface VectorPacket {
    vertices: number[][];
    oit: string;
    culling: string;
    featureCount: number;
    atlas: {
        width: number;
        height: number;
        rgba: number[];
    };
    highlights: number[][];
}
type P = VectorPosition;
/** Highlight changes do not clone or tessellate geometry. IDs are sorted for GPU lookup. */
export function compileVectorHighlights(source: VectorLayers | Pick<VectorSnapshot, "selections" | "hover" | "hoverStyle" | "timeSeconds">, timeSeconds?: number): number[][] {
    const snapshot = source instanceof VectorLayers ? source.highlightSnapshot() : source;
    const highlights = new Map<number, number[]>();
    function highlight(id: number, s: VectorSelectionStyle) {
        const c = s.color ?? [1, .8, 0, .5];
        highlights.set(id, [id, s.outline ? 1 : 0, s.glow ? 1 : 0, 0, ...c, s.outlineWidth ?? 2, s.glowIntensity ?? .5, s.glowRadius ?? 8, (s.pulseSpeed ?? 0) > 0 ? Math.sin((timeSeconds ?? snapshot.timeSeconds) * (s.pulseSpeed ?? 0)) * .5 + .5 : 1]);
    }
    for (const selection of snapshot.selections)
        if (selection.visible)
            for (const id of selection.ids)
                highlight(id, selection.style);
    if (snapshot.hover !== null) highlight(snapshot.hover, snapshot.hoverStyle);
    return [...highlights.values()].sort((a, b) => a[0]! - b[0]!);
}
/** CPU topology; projection, billboard expansion, elevation and culling run on GPU. */
export function compileVectorPacket(source: VectorLayers | VectorSnapshot, terrain?: TerrainHeightmapInput): VectorPacket {
    const snapshot = source instanceof VectorLayers ? source.snapshot() : VectorLayers.from(source).snapshot();
    const dataset = terrain ? TerrainDataset.fromArray(terrain) : undefined;
    const plan=planVectorWork(snapshot,dataset?.spacing),{atlasWidth,atlasHeight}=plan;
    const rgba = new Uint8Array(atlasWidth * atlasHeight * 4);
    rgba.fill(255);
    const vertices: number[][] = [];
    let featureCount = 0;
    const highlights = compileVectorHighlights(snapshot);
    for (const {layer,atlasY,features} of plan.layers) {
        const atlas = layer.atlas;
        if (atlas) {
            for (let y = 0; y < atlas.height; y++)
                rgba.set(atlas.rgba.subarray(y * atlas.width * 4, (y + 1) * atlas.width * 4), ((atlasY + y) * atlasWidth) * 4);
        }
        for (const {feature,style:s,segments,triangles,levels} of features) {
            featureCount++;
            const color = [s.color[0], s.color[1], s.color[2], s.color[3] * s.opacity];
            const drape = (p: P): P => { if (!s.drape)
                return [...p]; if (!dataset)
                throw vectorInvalid("draped vectors require terrain"); const hx = (dataset.width - 1) * dataset.spacing[0] / 2, hz = (dataset.height - 1) * dataset.spacing[1] / 2; const q = dataset.query(Math.max(-hx, Math.min(hx, p[0])), Math.max(-hz, Math.min(hz, p[2]))); if (!q || !Number.isFinite(q.elevation))
                throw vectorInvalid("cannot drape onto nodata"); return [p[0], (q.elevation - dataset.domain[0]) * dataset.exaggeration + s.drapeOffset, p[2]]; };
            const tileX = atlas ? s.atlasTile % (atlas.width / atlas.tileSize) : 0, tileY = atlas ? Math.floor(s.atlasTile / (atlas.width / atlas.tileSize)) : 0;
            const uvrect = atlas ? [tileX * atlas.tileSize / atlasWidth, (atlasY + tileY * atlas.tileSize) / atlasHeight, atlas.tileSize / atlasWidth, atlas.tileSize / atlasHeight] : [0, 0, 1, 1];
            const emit = (p: P, prev: P, next: P, expand: number, offset: number[], uv: number[], shape: number, elevation = 0) => { vertices.push([...p, elevation, ...prev, expand, ...next, s.miterLimit, ...offset, ...uv, ...color, feature.id, shape, 0, 0, ...uvrect, s.depthBias, s.lodThreshold, .5 / atlasWidth, .5 / atlasHeight]); };
            const point = (p: P, size: number, shape: number) => { for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]])
                emit(p, p, p, 1, [x! * (size / 2 + 1), y! * (size / 2 + 1)], [x! * (1 + 2 / size), y! * (1 + 2 / size)], shape); };
            if (feature.kind === "point")
                point(drape(feature.position), s.pointSize, ["circle", "square", "diamond", "triangle", "texture", "sphere"].indexOf(s.shape) + 1);
            if (feature.kind === "line") {
                const dense: P[] = [];
                const originals = feature.positions;
                for (let i = 0; i < originals.length - 1; i++) {
                    const a = originals[i]!, b = originals[i + 1]!;
                    const n=segments[i]!;
                    for (let j = 0; j < n; j++) {
                        const t = j / n;
                        dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
                    }
                }
                dense.push(originals.at(-1)!);
                const ps = dense.map(drape);
                const w = s.lineWidth / 2;
                for (let i = 0; i < ps.length - 1; i++) {
                    const a = ps[i]!, b = ps[i + 1]!;
                    if (a.every((x, k) => x === b[k]))
                        continue;
                    const start = i === 0 && s.cap === "square" ? -w - 1 : 0, end = i === ps.length - 2 && s.cap === "square" ? w + 1 : 0;
                    const quad: [
                        [
                            P,
                            number,
                            number
                        ],
                        ...Array<[
                            P,
                            number,
                            number
                        ]>
                    ] = [[a, -w - 1, start], [a, w + 1, start], [b, w + 1, end], [a, -w - 1, start], [b, w + 1, end], [b, -w - 1, end]];
                    for (const [p, x, y] of quad)
                        emit(p, a, b, 2, [x, y], [x / w, 0], 7);
                }
                if (s.cap === "round") {
                    point(ps[0]!, s.lineWidth, 1);
                    point(ps.at(-1)!, s.lineWidth, 1);
                }
                for (let i = 1; i < ps.length - 1; i++) {
                    const p = ps[i]!, a = ps[i - 1]!, b = ps[i + 1]!;
                    if (s.join === "round")
                        point(p, s.lineWidth, 1);
                    else
                        for (const side of [-1, 1]) {
                            // The bevel wedge covers the gap between the segment quads.
                            // A miter adds its tip triangle; it must not replace that wedge.
                            emit(p, a, p, 2, [side * w, 0], [side, 0], 0);
                            emit(p, p, p, 0, [0, 0], [0, 0], 0);
                            emit(p, p, b, 2, [side * w, 0], [side, 0], 0);
                            if (s.join === "miter") {
                                emit(p, a, p, 2, [side * w, 0], [side, 0], 0);
                                emit(p, a, b, 3, [side * w, 0], [side, 0], 0);
                                emit(p, p, b, 2, [side * w, 0], [side, 0], 0);
                            }
                        }
                }
            }
            if (feature.kind === "polygon") {
                const midpoint = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
                const roof = (a: P, b: P, c: P, level: number): void => {
                    if (level === 0) {
                        for (const source of [a, b, c]) {
                            const p = drape(source);
                            emit(p, p, p, 0, [0, 0], [0, 0], 0, s.extrusion);
                        }
                        if (s.extrusion > 0)
                            for (const source of [c, b, a]) {
                                const p = drape(source);
                                emit(p, p, p, 0, [0, 0], [0, 0], 0, 0);
                            }
                        return;
                    }
                    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
                    roof(a, ab, ca, level - 1);
                    roof(ab, b, bc, level - 1);
                    roof(ca, bc, c, level - 1);
                    roof(ab, bc, ca, level - 1);
                };
                for (const [a, b, c] of triangles)
                    roof(a!, b!, c!, levels);
                if (s.extrusion > 0)
                    for (const ring of feature.rings)
                        for (let i = 0; i < ring.length; i++) {
                            const start = ring[i]!, end = ring[(i + 1) % ring.length]!, segments = 2 ** levels;
                            const at = (t: number): P => drape([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t]);
                            for (let j = 0; j < segments; j++) {
                                const a = at(j / segments), b = at((j + 1) / segments);
                                for (const [p, e] of [[a, 0], [b, 0], [b, s.extrusion], [a, 0], [b, s.extrusion], [a, s.extrusion]] as [
                                    P,
                                    number
                                ][])
                                    emit(p, p, p, 0, [0, 0], [0, 0], 0, e);
                            }
                        }
            }

        }

    }
    return { vertices, oit: snapshot.oit, culling: snapshot.culling, featureCount, atlas: { width: atlasWidth, height: atlasHeight, rgba: [...rgba] }, highlights };
}
