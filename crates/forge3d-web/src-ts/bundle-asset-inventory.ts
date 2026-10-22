import type { SceneStateInput, ScenePreset } from './scene-review.js';
import type { MapSceneLayerInput } from './map-scene-types.js';
import type { BundleOptions } from './bundle.js';
import { readByteSource } from './browser-io.js';
import { bundleCancelled, bundleFailure, bundlePath } from './bundle-archive.js';
import { evaluateStyleExpression } from './style-expressions.js';
const encoder=new TextEncoder(), marker='forge3d-asset:';
function parseJson(bytes:Uint8Array):unknown {try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return bundleFailure('Invalid bundle JSON');}}
export interface BundleAssetReference { value:string; key:string; parent:Record<string,unknown>; }
/** Inventory only supported state shapes. Metadata and streamed-source intent stay opaque. */
export class BundleAssetInventory {
    readonly state:SceneStateInput;
    readonly references:BundleAssetReference[]=[];
    readonly dependencies:readonly string[];
    constructor(state:SceneStateInput,supplied:readonly string[]=[]) {
        this.state=structuredClone(state);
        const field=(parent:unknown,key:string)=>{
            if(parent && typeof parent==='object' && typeof (parent as Record<string,unknown>)[key]==='string')
                this.references.push({value:(parent as Record<string,unknown>)[key] as string,key,parent:parent as Record<string,unknown>});
        };
        const preset=(value:Partial<ScenePreset>)=>{
            for(const owner of [value.ibl,value.environment])for(const key of ['hdr','hdrPath','hdr_path'])field(owner,key);
        };
        const layers=(values:readonly MapSceneLayerInput[])=>{
            for(const layer of values) switch(layer.kind) {
                case 'raster': case 'vector': case 'labels': case 'buildings': case 'mesh': case 'point-cloud': case 'tiles3d': field(layer.source,'url'); break;
            }
        };
        field(this.state.base.terrain?.source,'url'); layers(this.state.base.layers??[]); preset(this.state.base);
        for(const review of this.state.reviewLayers??[])layers(review.layers);
        for(const variant of this.state.variants??[])if(variant.preset)preset(variant.preset);
        for(const source of Object.values(this.state.style?.sources??{}))if(source && typeof source==='object' && 'type' in source && source.type==='geojson')field(source,'data');
        this.dependencies=styleAssetUrls(this.state,supplied);
    }
    async rewrite(transform:(reference:BundleAssetReference)=>Promise<string>):Promise<SceneStateInput> {
        for(const entry of this.references)entry.parent[entry.key]=await transform(entry);
        return this.state;
    }
    verify(files:Record<string,Uint8Array>,aliases:Record<string,string>={}):void {
        const missing=(value:string)=>this.state.missingAssets?.includes(value)&&this.state.validationReport?.diagnostics.some(d=>d.code==='missing_external_asset'&&d.details.path===value&&['error','fatal'].includes(d.severity));
        for(const {value} of this.references) {
            if(value.startsWith(marker)) {if(!Object.hasOwn(files,bundlePath(value.slice(marker.length))))bundleFailure('Dangling bundle asset reference');}
            else if(!missing(value))bundleFailure('External asset reference without blocking missing-asset diagnostics');
        }
        for(const value of this.dependencies)if(!aliases[value]&&!missing(value))bundleFailure('Style asset without offline payload or blocking diagnostics');
    }
}
/** Self-contained glTF: rewrite subordinate buffers/images to data URIs before bundling. */
export async function embedGltf(bytes: Uint8Array, base: string, options: BundleOptions, remaining: () => number): Promise<Uint8Array> {
    const data = parseJson(bytes) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    let used = 0;
    for (const resource of [...data.buffers ?? [], ...data.images ?? []]) if (resource.uri && !resource.uri.startsWith('data:')) {
        const payload = await readByteSource(new URL(resource.uri, base), { maxBytes: remaining() - used, ...(options.signal ? { signal: options.signal } : {}) }); used += payload.length;
        bundleCancelled(options.signal); let text = ''; for (let i = 0; i < payload.length; i += 8192) text += String.fromCharCode(...payload.subarray(i, i + 8192));
        resource.uri = `data:application/octet-stream;base64,${btoa(text)}`;
    }
    return encoder.encode(JSON.stringify(data));
}
/** The finite glyph inventory used by this scene, plus the sprite pair. */
function styleAssetUrls(state: SceneStateInput, supplied: readonly string[]): string[] {
    const style = state.style, urls = new Set<string>();
    if (!style) return [];
    if (style.sprite) { urls.add(style.sprite + '.json'); urls.add(style.sprite + '.png'); }
    if (!style.glyphs) return [...urls];
    const requests = [...state.styleGlyphRequests ?? []];
    for (const layer of style.layers ?? []) {
        if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
        const source = style.sources?.[layer.source ?? ''] as {type?: string; data?: unknown} | undefined;
        const data = source?.type === 'geojson' && typeof source.data === 'object' ? source.data as { features?: { properties?: Record<string, unknown> }[] } : null;
        for (const feature of data?.features ?? [{ properties: {} }]) {
            const properties = feature.properties ?? {};
            const raw = evaluateStyleExpression(layer.layout['text-field'], { properties });
            const text = typeof raw === 'string' ? raw.replace(/\{([^}]+)\}/g, (_, key: string) => String(properties[key] ?? '')) : '';
            const font = layer.layout['text-font'];
            const fontStack = Array.isArray(font) && font.every(v => typeof v === 'string') ? font.join(',') : 'Open Sans Regular,Arial Unicode MS Regular';
            if (text) requests.push({ fontStack, text });
        }
    }
    for (const { fontStack, text } of requests) for (const c of text) {
        const start = Math.floor(c.codePointAt(0)! / 256) * 256;
        urls.add(style.glyphs.replaceAll('{fontstack}', encodeURIComponent(fontStack)).replaceAll('{range}', `${start}-${start + 255}`));
    }
    const pattern = new RegExp('^' + style.glyphs.split(/(\{fontstack\}|\{range\})/).map(p => p === '{fontstack}' ? '[^/]+' : p === '{range}' ? '\\d+-\\d+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
    const glyphs = supplied.filter(url => pattern.test(url));
    glyphs.forEach(url => urls.add(url));
    // A declared template is metadata until text actually needs a glyph range.
    // In particular, fill/line styles do not acquire or require font assets.
    return [...urls].sort();
}
