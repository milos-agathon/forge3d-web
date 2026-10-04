import { Forge3DError } from "./index.js";
import type { PostFxInput, PostFxChainInput, PostFxSnapshot, PostFxEffectSnapshot, ColorLutInput } from "./postfx-types.js";
export type * from "./postfx-types.js";

const kinds = ["ssao", "gtao", "ssgi", "ssr", "bloom", "dof", "motion-blur", "taa", "accumulation-aa", "denoise", "tonemap", "lens"] as const;
const operators = ["none", "reinhard", "reinhard-extended", "aces", "uncharted2", "exposure", "display"] as const;
const qualities = ["low", "medium", "high", "ultra"] as const;
const views = ["none", "color", "depth", "normal", "albedo", "motion", "hzb", "effect"] as const;
function fail(s: string): never { throw new Forge3DError("INVALID_INPUT", `postFx: ${s}`); }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(v: object, allowed: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`unknown field ${k}`);
}
function n(v: unknown, d: number, lo: number, hi: number, field: string, integer = false): number {
  const x = v === undefined ? d : v;
  return typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi && (!integer || Number.isInteger(x)) ? x : fail(`${field} must be ${integer ? "an integer" : "finite"} in [${lo}, ${hi}]`);
}
function bool(v: unknown, d: boolean): boolean { return v === undefined ? d : typeof v === "boolean" ? v : fail("expected boolean"); }
function choice<T extends string>(v: unknown, d: T, choices: readonly T[]): T { return v === undefined ? d : choices.includes(v as T) ? v as T : fail(`expected ${choices.join(", ")}`); }

export function createIdentityColorLut(size = 16): ColorLutInput {
  n(size, 16, 2, 64, "lut.size", true);
  const data = new Float32Array(size ** 3 * 3);
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const i = ((b * size + g) * size + r) * 3;
    data.set([r / (size - 1), g / (size - 1), b / (size - 1)], i);
  }
  return { size, data };
}

/** Validate every option before crossing the WASM boundary. Does not reorder effects. */
export function normalizePostFx(input: PostFxChainInput | readonly PostFxInput[]): PostFxSnapshot { return normalize(input,16); }
function normalize(input: PostFxChainInput | readonly PostFxInput[],maxEffects: number): PostFxSnapshot {
  const value: PostFxChainInput = Array.isArray(input) ? { effects: input } : input as PostFxChainInput;
  if (!object(value)) fail("expected a chain object or effect array");
  keys(value, ["effects", "debug"]);
  const effects = value.effects ?? [];
  if (!Array.isArray(effects) || effects.length > maxEffects) fail("effects must be an array of at most 16 effects");
  const ids = new Set<string>();
  let tonemap = false, lens = false, temporal = false;
  const normalized = effects.map((input, index): PostFxEffectSnapshot => {
    if (!object(input)) fail("effect must be an object");
    const v = input as unknown as Record<string, unknown>;
    const kind = choice(v.kind, "tonemap", kinds);
    if (v.kind === undefined) fail("effect kind is required");
    const id = v.id ?? `${kind}-${index}`;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) fail("effect IDs must be unique nonempty ASCII identifiers (up to 64 characters)");
    ids.add(id);
    const enabled = bool(v.enabled, true);
    if (enabled) {
      if (lens) fail("lens must be last");
      if (tonemap && kind !== "lens") fail("HDR effects must precede tonemap");
      if (kind === "tonemap") { if (tonemap) fail("only one tonemap is allowed"); tonemap = true; }
      if (kind === "lens") lens = true;
      if (kind === "taa" || kind === "accumulation-aa") { if (temporal) fail("only one antialiasing history is allowed"); temporal = true; }
    }
    const p = new Array<number>(16).fill(0);
    const fields: string[] = ["id", "kind", "enabled"];
    const put = (i: number, key: string, def: number, lo: number, hi: number, integer = false) => { fields.push(key); p[i] = n(v[key], def, lo, hi, key, integer); };
    let quality: PostFxEffectSnapshot["quality"] = "medium", operator: PostFxEffectSnapshot["operator"] = "display", lut: PostFxEffectSnapshot["lut"] = null;
    switch (kind) {
      case "ssao": case "gtao":
        put(0,"radius",.5,.0001,10000); put(1,"bias",.025,0,100); put(2,"intensity",1.5,0,10); put(3,"samples",16,4,64,true);
        put(4,"bilateralRadius",2,0,8,true); put(5,"temporalWeight",.9,0,.99); break;
      case "ssgi": case "ssr":
        put(0,"maxDistance",kind === "ssgi" ? 1 : 32,.001,100000); put(1,"thickness",.1,.00001,1000); put(2,"intensity",kind === "ssgi" ? .5 : 5,0,10); put(3,"steps",kind === "ssgi" ? 16 : 96,4,128,true);
        put(4,"samples",1,1,16,true); put(5,"temporalWeight",.9,0,.99); put(6,"bilateralRadius",2,0,8,true);
        fields.push("fallback");
        if (v.fallback !== undefined) {
          if (!Array.isArray(v.fallback) || v.fallback.length !== 3) fail("fallback must be RGB");
          v.fallback.forEach((x,i) => { p[8+i] = n(x,0,0,65504,"fallback"); });
        }
        break;
      case "bloom":
        put(0,"threshold",1.5,0,65504); put(1,"softness",.5,0,1); put(2,"strength",.3,0,10); put(3,"radius",1,0,10);
        fields.push("quality"); quality = choice(v.quality,"medium",qualities); p[4] = [1,1,2,3][qualities.indexOf(quality)]!; break;
      case "dof":
        put(0,"aperture",.1,0,1); put(1,"focusDistance",10,.001,100000); put(2,"focalLength",50,.001,1000); put(3,"sensorSize",36,.001,1000);
        fields.push("quality"); quality = choice(v.quality,"medium",qualities); const q = qualities.indexOf(quality);
        put(4,"maxBlurRadius",[8,12,16,20][q]!,0,64); put(5,"blurRadiusScale",1,0,10); p[6] = [8,16,24,32][q]!; p[10] = q;
        put(7,"bokehRotation",0,-Math.PI*2,Math.PI*2); put(8,"tiltPitch",0,-1.5,1.5); put(9,"tiltYaw",0,-1.5,1.5); break;
      case "motion-blur": put(0,"shutter",.5,0,2); put(1,"samples",16,2,64,true); put(2,"maxBlurPixels",64,0,256); break;
      case "taa":
        put(0,"historyWeight",.9,0,.99); put(1,"clampGamma",1.25,.1,4); put(2,"motionScale",100,0,1000); put(3,"depthThreshold",.01,.000001,1);
        fields.push("jitter"); p[4] = bool(v.jitter,true) ? 1 : 0; break;
      case "accumulation-aa": put(0,"samples",64,1,4096,true); fields.push("jitter"); p[1] = bool(v.jitter,true) ? 1 : 0; break;
      case "denoise": put(0,"iterations",3,1,5,true); put(1,"sigmaColor",.2,.0001,100); put(2,"sigmaDepth",.01,.000001,100); put(3,"sigmaNormal",.2,.0001,2); break;
      case "tonemap":
        put(0,"exposure",0,-20,20); put(1,"whitePoint",4,.0001,65504); put(2,"gamma",0,0,4); put(3,"lutStrength",1,0,1);
        if (p[2]! > 0 && p[2]! < .1) fail("gamma must be 0 (sRGB) or >= 0.1");
        fields.push("operator", "lut"); operator = choice(v.operator,"display",operators); p[5] = operators.indexOf(operator);
        if (v.lut !== undefined && v.lut !== null) {
          if (!object(v.lut)) fail("lut must be an object"); keys(v.lut,["size","data"]);
          const size = n(v.lut.size,0,2,64,"lut.size",true); const data = v.lut.data;
          if (!(Array.isArray(data) || data instanceof Float32Array) || data.length !== size**3*3 || !data.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) fail("lut.data must contain size^3 linear RGB triples in [0, 1]");
          lut = {size, data:Array.from(data)}; p[4] = size;
        }
        break;
      case "lens":
        put(0,"distortion",0,-1,1); put(1,"chromaticAberration",0,-.2,.2); put(2,"vignetteStrength",0,0,1); put(3,"vignetteRadius",.8,0,2); put(4,"vignetteSoftness",.3,.0001,2); break;
    }
    keys(v, fields);
    return { id, kind, enabled, params:p, quality, operator, lut };
  });
  // Insert the display resolve immediately before the lens if none was supplied.
  if (!tonemap && normalized.some(e => e.enabled)) {
    let id = "display"; while (ids.has(id)) id += "_";
    const display = normalizePostFx([{kind:"tonemap", id}]).effects[0]!;
    const last = normalized.findIndex(e => e.enabled && e.kind === "lens");
    normalized.splice(last < 0 ? normalized.length : last,0,display);
  }
  const debug = value.debug ?? {view:"none"};
  if (!object(debug)) fail("debug must be an object"); keys(debug,["view","effectId","hzbMip"]);
  const view = choice(debug.view,"none",views), effectId = debug.effectId ?? null;
  if (effectId !== null && (typeof effectId !== "string" || !normalized.some(e=>e.enabled && e.id === effectId))) fail("debug.effectId must name an enabled effect");
  if (view === "effect" && effectId === null) fail("effect debug requires effectId");
  return { effects:normalized, debug:{view,effectId,hzbMip:n(debug.hzbMip,0,0,31,"hzbMip",true)} };
}

export class PostFxChain {
  #input: PostFxChainInput;
  constructor(input: PostFxChainInput | readonly PostFxInput[] = []) { normalizePostFx(input); this.#input = structuredClone(Array.isArray(input) ? {effects:input} : input as PostFxChainInput); }
  snapshot(): PostFxSnapshot { return normalizePostFx(this.#input); }
  toJSON(): PostFxChainInput { return structuredClone(this.#input); }
  copy(): PostFxChain { return new PostFxChain(this.#input); }
  setEnabled(id: string, enabled: boolean): this {
    const input = this.toJSON(); const effect = input.effects?.find((e,i)=>(e.id ?? `${e.kind}-${i}`)===id);
    if (!effect) fail(`unknown effect ${id}`); effect.enabled=enabled;
    normalizePostFx(input); this.#input=input; return this;
  }
}

/** Revalidate serialized snapshots used by scene replay and workers. */
export function validatePostFxSnapshot(snapshot: PostFxSnapshot): PostFxSnapshot {
  if (!object(snapshot) || !Array.isArray(snapshot.effects) || !object(snapshot.debug)) fail("invalid snapshot");
  keys(snapshot,["effects","debug"]);
  const effects: PostFxInput[] = snapshot.effects.map(e => {
    if (!object(e)) fail("invalid effect snapshot");
    keys(e,["id","kind","enabled","params","quality","operator","lut"]);
    if (!Array.isArray(e.params) || e.params.length !== 16 || !e.params.every(Number.isFinite)) fail("snapshot params must contain 16 finite numbers");
    const p=e.params, base={id:e.id,kind:e.kind,enabled:e.enabled};
    switch(e.kind){
      case "ssao":case "gtao":return {...base,kind:e.kind,radius:p[0]!,bias:p[1]!,intensity:p[2]!,samples:p[3]!,bilateralRadius:p[4]!,temporalWeight:p[5]!};
      case "ssgi":case "ssr":return {...base,kind:e.kind,maxDistance:p[0]!,thickness:p[1]!,intensity:p[2]!,steps:p[3]!,samples:p[4]!,temporalWeight:p[5]!,bilateralRadius:p[6]!,fallback:[p[8]!,p[9]!,p[10]!]};
      case "bloom":return {...base,kind:e.kind,threshold:p[0]!,softness:p[1]!,strength:p[2]!,radius:p[3]!,quality:e.quality};
      case "dof":return {...base,kind:e.kind,aperture:p[0]!,focusDistance:p[1]!,focalLength:p[2]!,sensorSize:p[3]!,maxBlurRadius:p[4]!,blurRadiusScale:p[5]!,bokehRotation:p[7]!,tiltPitch:p[8]!,tiltYaw:p[9]!,quality:e.quality};
      case "motion-blur":return {...base,kind:e.kind,shutter:p[0]!,samples:p[1]!,maxBlurPixels:p[2]!};
      case "taa":return {...base,kind:e.kind,historyWeight:p[0]!,clampGamma:p[1]!,motionScale:p[2]!,depthThreshold:p[3]!,jitter:p[4]===1};
      case "accumulation-aa":return {...base,kind:e.kind,samples:p[0]!,jitter:p[1]===1};
      case "denoise":return {...base,kind:e.kind,iterations:p[0]!,sigmaColor:p[1]!,sigmaDepth:p[2]!,sigmaNormal:p[3]!};
      case "tonemap":return {...base,kind:e.kind,operator:e.operator,exposure:p[0]!,whitePoint:p[1]!,gamma:p[2]!,lutStrength:p[3]!,...(e.lut?{lut:e.lut}:{})};
      case "lens":return {...base,kind:e.kind,distortion:p[0]!,chromaticAberration:p[1]!,vignetteStrength:p[2]!,vignetteRadius:p[3]!,vignetteSoftness:p[4]!};
      default:return fail("unknown effect kind");
    }
  });
  const debug=snapshot.debug;
  const result=normalize({effects,debug:{view:debug.view,...(debug.effectId!==null?{effectId:debug.effectId}:{}),hzbMip:debug.hzbMip}},17);
  if (JSON.stringify(result.effects)!==JSON.stringify(snapshot.effects.map(e=>({id:e.id,kind:e.kind,enabled:e.enabled,params:e.params,quality:e.quality,operator:e.operator,lut:e.lut===null?null:{size:e.lut.size,data:e.lut.data}})))) fail("noncanonical effect snapshot");
  return result;
}
export function resolvePostFx(input: PostFxChain | PostFxChainInput | PostFxSnapshot | readonly PostFxInput[] | null): PostFxSnapshot | null {
  if(input===null)return null;if(input instanceof PostFxChain)return input.snapshot();
  if(!Array.isArray(input)&&object(input)&&Array.isArray(input.effects)&&input.effects.some(e=>object(e)&&"params"in e))return validatePostFxSnapshot(input as unknown as PostFxSnapshot);
  return normalizePostFx(input as PostFxChainInput|readonly PostFxInput[]);
}
