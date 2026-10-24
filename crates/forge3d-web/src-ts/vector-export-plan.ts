import { cancelled,checkBytes,color,integer } from './cartography-common.js';
import { Bounds,project2dToScreen,type VectorScene,type ExportPoint } from './vector-export-scene.js';
import type { VectorExportOptions,VectorExportFont } from './vector-export.js';
/** Capture options before any async encoder/font work; sources retain their established byte-source contract. */
export function captureExportOptions<T extends VectorExportOptions & {fonts?:readonly VectorExportFont[]}>(options:T):T {
    return {...options,...(options.bounds?{bounds:new Bounds(options.bounds.minX,options.bounds.minY,options.bounds.maxX,options.bounds.maxY)}:{}),...(options.background?{background:[...options.background]}:{}),...(options.fonts?{fonts:options.fonts.map(f=>({...f}))}:{})} as T;
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Fully owned screen-space geometry and styling shared by SVG/PDF encoders. */
export function compileVectorExportPlan(scene:VectorScene,options:VectorExportOptions={}) {
    cancelled(options.signal);const width=integer(options.width??800,'width'),height=integer(options.height??600,'height'),precision=integer(options.precision??2,'precision',0,10);
    const supplied=options.bounds??scene.computeBounds(10),bounds=new Bounds(supplied.minX,supplied.minY,supplied.maxX,supplied.maxY);
    const sceneBytes=scene.getMemoryReport().cpuBytes;checkBytes(sceneBytes*8,options.maxBytes);
    const project=(p:ExportPoint)=>project2dToScreen(p,bounds,[width,height]);
    const polygons=scene.polygons.map(p=>({...p,exterior:p.exterior.map(project),holes:p.holes.map(r=>r.map(project)),fillVisible:p.style.fillColor[3]>.001,strokeVisible:p.style.strokeColor[3]>.001}));
    const polylines=scene.polylines.map(p=>({...p,path:p.path.map(project)}));
    const families=new Set<string>();
    const labels=(options.includeLabels===false?[]:scene.labels).map(l=>{
        const family=l.style.fontFamily;families.add(family);
        let pdfFamily=['sans-serif','Arial','DejaVu Sans'].includes(family)?'DejaVu Sans':family;
        for(const [pattern,fallback] of [[/[\u0600-\u06ff]/u,'NotoSansArabic'],[/[\u0900-\u097f]/u,'NotoSansDevanagari']] as const)if(pattern.test(l.text)){families.add(fallback);if(['NotoSans','DejaVu Sans'].includes(pdfFamily))pdfFamily=fallback;}
        return {...l,position:project(l.position),pdfFamily,haloVisible:!!l.style.haloWidth&&l.style.haloColor[3]>.001};
    });
    return freeze({width,height,precision,bounds,polygons,polylines,labels,families:[...families].sort(),sceneBytes,background:options.background?color(options.background):null});
}
export type VectorExportPlan=ReturnType<typeof compileVectorExportPlan>;
