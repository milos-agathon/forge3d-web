import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { LicenseManager, licenseManager } from '../../src-ts/license.js';
import licenses from '../fixtures/w21/licenses.json';
import { productGateCases } from './w21-gate-cases.js';

beforeEach(() => licenseManager.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

describe('W21 issuer review regressions', () => {
  it('configures the actual package gates once, accepts a runtime-generated issuer and rejects development signatures', async () => {
    vi.resetModules();
    const api: any = await import('../../src-ts/index.js');
    api.licenseManager.clear();
    expect(api.configureLicenseIssuer).toBeTypeOf('function');
    const secret = ed.utils.randomSecretKey(), publicKey = await ed.getPublicKeyAsync(secret);
    const message = 'F3D-PRO-runtime-issuer-20991231';
    const key = message + '-' + hex(await ed.signAsync(new TextEncoder().encode(message), secret));
    expect(() => api.configureLicenseIssuer('bad')).toThrow();
    api.configureLicenseIssuer(hex(publicKey));
    expect(() => api.configureLicenseIssuer(hex(publicKey))).toThrow();
    for (const fixture of Object.values(licenses)) {
      await expect(api.setLicenseKey(fixture)).rejects.toThrow('signature');
      for (const [name, invoke] of productGateCases(api)) await expect(Promise.resolve().then(invoke), name).rejects.toMatchObject({ code: 'LICENSE_REQUIRED' });
    }
    for (const feature of Object.values(api.PRO_FEATURES)) expect(() => api.requirePro(feature)).toThrow();
    expect((await api.setLicenseKey(key)).status).toBe('active');
    expect(api.compileStyle(api.parseStyle({ layers: [] }), {}).layers).toEqual([]);
    api.licenseManager.clear();
    expect(() => api.configureLicenseIssuer(hex(publicKey))).toThrow();
  }, 15000);
  it('locks issuer configuration as soon as a nonempty verification starts, even after clear', async () => {
    vi.resetModules(); const api: any = await import('../../src-ts/index.js');
    expect(api.configureLicenseIssuer).toBeTypeOf('function');
    const pending = api.setLicenseKey(licenses.active);
    expect(() => api.configureLicenseIssuer('11'.repeat(32))).toThrow();
    await pending; api.licenseManager.clear();
    expect(() => api.configureLicenseIssuer('11'.repeat(32))).toThrow();
  }, 15000);
});

describe('W21 local dates and interleaved verification', () => {
  it.each(['valid', 'forged'])('load verifies a %s stored key after an earlier pending setKey commits', async stored => {
    const actual = globalThis.crypto.subtle;
    let releaseVerification!: () => void;
    const verify = vi.fn(async (...args: Parameters<SubtleCrypto['verify']>) => {
      const valid = await actual.verify(...args);
      if (verify.mock.calls.length === 1) await new Promise<void>(resolve => { releaseVerification = resolve; });
      return valid;
    });
    vi.stubGlobal('crypto', { subtle: { importKey: actual.importKey.bind(actual), verify } });
    const manager = new LicenseManager(), pending = manager.setKey(licenses.active);
    await vi.waitFor(() => expect(releaseVerification).toBeTypeOf('function'));
    let completeRead!: (bytes: Uint8Array) => void;
    const store = { get: () => new Promise<Uint8Array>(resolve => { completeRead = resolve; }), put: async () => {}, delete: async () => {}, clear: async () => {} };
    const loaded = manager.load(store);
    releaseVerification(); await pending;
    expect(manager.getInfo().tier).toBe('pro');
    const key = stored === 'valid' ? licenses.enterprise : licenses.enterprise.replace('20991231', '20991230');
    completeRead(new TextEncoder().encode(key));
    if (stored === 'valid') expect((await loaded).tier).toBe('enterprise');
    else await expect(loaded).rejects.toThrow('signature');
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it.each(['clear', 'new-success', 'new-failure'])('load respects a %s issued after its storage read starts', async action => {
    const manager = new LicenseManager({ verifier: 'noble' });
    let completeRead!: (bytes: Uint8Array) => void;
    const store = { get: () => new Promise<Uint8Array>(resolve => { completeRead = resolve; }), put: async () => {}, delete: async () => {}, clear: async () => {} };
    const loaded = manager.load(store);
    if (action === 'clear') manager.clear();
    else if (action === 'new-success') await manager.setKey(licenses.active);
    else await expect(manager.setKey('bad')).rejects.toThrow();
    completeRead(new TextEncoder().encode(licenses.enterprise));
    expect((await loaded).tier).toBe(action === 'clear' ? null : action === 'new-success' ? 'pro' : 'enterprise');
  });
  it('matches local calendar midnight rather than the UTC date', async () => {
    let now = new Date(2026, 9, 1, 0, 0, 0);
    const manager = new LicenseManager({ now: () => now, onWarning: () => {} });
    await manager.setKey(licenses.grace);
    expect(manager.getInfo()).toMatchObject({ status: 'active', daysRemaining: 0 });
    now = new Date(2026, 9, 15, 23, 59, 59);
    expect(manager.getInfo()).toMatchObject({ status: 'grace', daysRemaining: 0 });
    now = new Date(2026, 9, 16, 0, 0, 0);
    expect(manager.getInfo().status).toBe('expired');
  });
  it.each(['malformed', 'signature'])('a newer %s failure does not cancel an older valid pending key', async failure => {
    const actual = globalThis.crypto.subtle, releases: (() => void)[] = [];
    vi.stubGlobal('crypto', { subtle: {
      importKey: actual.importKey.bind(actual),
      verify: async (...args: Parameters<SubtleCrypto['verify']>) => { const valid = await actual.verify(...args); await new Promise<void>(r => releases.push(r)); return valid; },
    } });
    const manager = new LicenseManager(), older = manager.setKey(licenses.active);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const newer = manager.setKey(failure === 'malformed' ? 'bad' : licenses.active.replace('20991231', '20991230'));
    const rejected = expect(newer).rejects.toThrow();
    if (failure === 'signature') { await vi.waitFor(() => expect(releases).toHaveLength(2)); releases[1]!(); }
    await rejected; releases[0]!(); await older;
    expect(manager.getInfo()).toMatchObject({ status: 'active', tier: 'pro' });
  });
  it.each(['clear', 'new-success'])('%s wins over an older pending valid key', async winner => {
    const actual = globalThis.crypto.subtle, releases: (() => void)[] = [];
    vi.stubGlobal('crypto', { subtle: {
      importKey: actual.importKey.bind(actual),
      verify: async (...args: Parameters<SubtleCrypto['verify']>) => { const valid = await actual.verify(...args); await new Promise<void>(r => releases.push(r)); return valid; },
    } });
    const manager = new LicenseManager(), older = manager.setKey(licenses.active);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    if (winner === 'clear') manager.clear();
    else { const newer = manager.setKey(licenses.enterprise); await vi.waitFor(() => expect(releases).toHaveLength(2)); releases[1]!(); await newer; }
    releases[0]!(); await older;
    expect(manager.getInfo().tier).toBe(winner === 'clear' ? null : 'enterprise');
  });
});
