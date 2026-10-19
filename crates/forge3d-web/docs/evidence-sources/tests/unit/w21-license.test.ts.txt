import * as productApi from '../../src-ts/index.js';
import { productGateCases, productUrlGateCases } from './w21-gate-cases.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicenseManager, LicenseError, licenseManager, setLicenseKey, requirePro, requiresPro } from '../../src-ts/license.js';
import { MapScene } from '../../src-ts/map-scene.js';
import { loadBuildings, loadBuildingTilesMetadata, parseGeoJsonBuildings, parseCityJsonBuildings } from '../../src-ts/buildings.js';
import { compileStyle, loadStyle, loadStyleLayers, parseStyle } from '../../src-ts/map-style.js';
import { saveBundle, loadBundle } from '../../src-ts/bundle.js';
import licenses from '../fixtures/w21/licenses.json';

beforeEach(() => licenseManager.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('native Ed25519 license contract', () => {
  it.each(['auto', 'noble'] as const)('verifies the native issuer offline with %s', async verifier => {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('network forbidden'); }));
    const manager = new LicenseManager({ verifier });
    expect(await manager.setKey(licenses.active)).toMatchObject({ status: 'active', tier: 'pro', customerId: 'forge3d-ci', expiry: '2099-12-31', valid: true });
    expect(await manager.setKey(licenses.enterprise)).toMatchObject({ tier: 'enterprise' });
    manager.requirePro('test');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('works without any WebCrypto, including SHA-512', async () => {
    vi.stubGlobal('crypto', undefined);
    const manager = new LicenseManager();
    expect(await manager.setKey(licenses.active)).toMatchObject({ verifier: 'noble', valid: true });
  });
  it.each([
    '', 'not-a-license', 'F3D-FREE-ci-20991231-' + 'aa'.repeat(64),
    licenses.active.replace('20991231', '20991230'), licenses.active.replace('forge3d-ci', 'other'),
    licenses.active.replace('20991231', '20990230'), licenses.active.slice(0, -1),
    licenses.active.replace('forge3d-ci', 'forge3d ci'), 'F3D-PRO-ci-20991231-' + '00'.repeat(64),
  ].filter(Boolean))('rejects malformed, forged or tampered signed payload %#', async key => {
    const manager = new LicenseManager({ verifier: 'noble' });
    await expect(manager.setKey(key)).rejects.toBeInstanceOf(LicenseError);
    expect(manager.getInfo().status).toBe('missing');
  });
  it('uses inclusive expiry and exactly 14 grace days, rechecked on every gate', async () => {
    let now = new Date(2026,9,1,23,59,59); const warnings: string[] = [];
    const manager = new LicenseManager({ now: () => now, onWarning: m => warnings.push(m) });
    await manager.setKey(licenses.grace);
    expect(manager.getInfo()).toMatchObject({ status: 'active', daysRemaining: 0, graceEnd: '2026-10-15' });
    now = new Date(2026,9,2,0,0,0); manager.requirePro('feature');
    expect(manager.getInfo()).toMatchObject({ status: 'grace', daysRemaining: 13 });
    now = new Date(2026,9,15,23,59,59); manager.requirePro('feature');
    expect(warnings).toHaveLength(2); expect(manager.getInfo().daysRemaining).toBe(0);
    now = new Date(2026,9,16,0,0,0);
    expect(() => manager.requirePro('feature')).toThrow('grace period ended');
  });
  it('clears without implicit storage/environment reload and preserves wrapper this/arguments', async () => {
    const object = { factor: 4, step: requiresPro(function (this: { factor: number }, n: number) { return n * this.factor; }, 'test') };
    expect(() => object.step(3)).toThrow('test requires a Pro license');
    await setLicenseKey(licenses.active); expect(object.step(3)).toBe(12);
    await setLicenseKey(' '); expect(() => requirePro()).toThrow(LicenseError);
    expect(JSON.stringify(licenseManager.getInfo())).not.toContain(licenses.active);
  });
  it('persists only explicitly through a W02 byte store and revalidates corrupt keys', async () => {
    const entries = new Map<string, Uint8Array>();
    const store = { get: async (k: string) => entries.get(k), put: async (k: string, v: Uint8Array) => { entries.set(k, v); }, delete: async (k: string) => { entries.delete(k); }, clear: async () => entries.clear() };
    await licenseManager.load(store); expect(licenseManager.getInfo().status).toBe('missing');
    await setLicenseKey(licenses.active); await licenseManager.save(store); licenseManager.clear();
    await licenseManager.load(store); expect(licenseManager.getInfo().status).toBe('active');
    entries.set('forge3d-license', new TextEncoder().encode(licenses.active.replace('20991231', '20991230')));
    licenseManager.clear(); await expect(licenseManager.load(store)).rejects.toThrow('signature');
    await licenseManager.save(store); expect(entries.size).toBe(0);
  });
  it('a clear wins over in-flight verification and storage reads', async () => {
    const pending = licenseManager.setKey(licenses.active); licenseManager.clear(); await pending;
    expect(licenseManager.getInfo().status).toBe('missing');
    let complete!: (v: Uint8Array) => void;
    const store = { get: () => new Promise<Uint8Array>(r => complete = r), put: async () => {}, delete: async () => {}, clear: async () => {} };
    const read = licenseManager.load(store); licenseManager.clear(); complete(new TextEncoder().encode(licenses.active)); await read;
    expect(licenseManager.getInfo().status).toBe('missing');
  });
  it('reports MapScene building gates before resource IO', async () => {
    const fetchSpy=vi.fn(()=>{throw Error('must not fetch');});vi.stubGlobal('fetch',fetchSpy);
    const scene=new MapScene({crs:'LOCAL',camera:{kind:'orbit-camera',target:[0,0,0],distance:10},output:{width:8,height:8},layers:[{kind:'buildings',layerId:'city',source:{id:'city-data',format:'geojson',crs:'LOCAL',url:'https://example.invalid/buildings.geojson'}}]});
    try { expect(scene.validate().diagnostics.some(d=>d.code==='pro_gated_path')).toBe(true);expect((await scene.prepare()).renderBlocked()).toBe(true);await expect(scene.render()).rejects.toThrow();expect(fetchSpy).not.toHaveBeenCalled(); } finally { scene.dispose(); }
  });

  describe.each(['missing','expired','grace'] as const)('%s product gates',state=>{
    const cases = [...productGateCases(productApi), ...(state === 'grace' ? [] : productUrlGateCases(productApi))];
    it.each(cases)('%s enforces the current license state before IO',async(name,invoke)=>{
      licenseManager.clear();
      vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,9,15,23,59,59));
      const warning=vi.spyOn(console,'warn').mockImplementation(()=>{}),fetchSpy=vi.fn(()=>{throw Error('unexpected fetch');});vi.stubGlobal('fetch',fetchSpy);
      try {
        if(state!=='missing')await setLicenseKey(licenses[state]);
        if(state==='grace'){
          const value:any=await Promise.resolve().then(invoke);value?.dispose?.();
          expect(warning,name).toHaveBeenCalled();
        }else await expect(Promise.resolve().then(invoke),name).rejects.toBeInstanceOf(LicenseError);
        expect(fetchSpy,name).not.toHaveBeenCalled();
      }finally{warning.mockRestore();}
    });
  });
});
