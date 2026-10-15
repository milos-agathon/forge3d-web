import { hashes, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { PersistentByteStore } from './index.js';

/** Native development issuer. Production distributions must provision their issuer key. */
export const LICENSE_PUBLIC_KEY_HEX = '9a995d11c2da9df6b734e7aa98d7877bb326910998667bef349eb51e167382f7';
export const LICENSE_GRACE_DAYS = 14;
export const PRO_FEATURES = Object.freeze({
  mapPlate: 'Map plate composition', svg: 'SVG export', pdf: 'PDF export',
  geoJsonBuildings: 'GeoJSON building import', cityJsonBuildings: 'CityJSON building import',
  tilesBuildings: '3D Tiles building import', styleLoad: 'Mapbox style loading',
  styleApply: 'Mapbox style application', bundleSave: 'Scene bundle save', bundleLoad: 'Scene bundle load',
});
export type LicenseStatus = 'missing' | 'active' | 'grace' | 'expired';
export interface LicenseInfo {
  status: LicenseStatus;
  valid: boolean;
  tier: 'pro' | 'enterprise' | null;
  customerId: string | null;
  expiry: string | null;
  graceEnd: string | null;
  daysRemaining: number;
  verifier: 'webcrypto' | 'noble' | null;
}
export interface LicenseManagerOptions {
  publicKeyHex?: string;
  verifier?: 'auto' | 'noble';
  /** UTC calendar day; defaults to the local machine clock. Client clocks are not trusted entitlements. */
  now?: () => Date;
  onWarning?: (message: string) => void;
}
export class LicenseError extends Error {
  readonly code = 'LICENSE_REQUIRED';
  constructor(feature = '', detail?: string) {
    super(`${detail ?? (feature ? `${feature} requires a Pro license.` : 'Pro license required.')}\nSet your key with await setLicenseKey('F3D-...').\nhttps://github.com/milos-agathon/forge3d#license`);
    this.name = 'LicenseError';
  }
}
interface SignedLicense {
  key: string; tier: 'pro' | 'enterprise'; customerId: string; expiryDay: number;
  verifier: 'webcrypto' | 'noble';
}
const DAY = 86400000;
function hex(value: string, bytes: number): Uint8Array {
  if (!new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value)) throw new LicenseError('', 'Invalid license signature or public key.');
  return Uint8Array.from(value.match(/../g)!, x => parseInt(x, 16));
}
function iso(day: number): string { return new Date(day * DAY).toISOString().slice(0, 10); }

/** Offline validity and client API gating. This is not tamper-resistant DRM. */
export class LicenseManager {
  readonly #publicKey: Uint8Array<ArrayBuffer>;
  readonly #options: LicenseManagerOptions;
  #license: SignedLicense | undefined;
  #revision = 0;
  constructor(options: LicenseManagerOptions = {}) {
    this.#publicKey = new Uint8Array(hex(options.publicKeyHex ?? LICENSE_PUBLIC_KEY_HEX, 32));
    if (options.verifier !== undefined && !['auto', 'noble'].includes(options.verifier)) throw new LicenseError('', 'Unknown license verifier.');
    this.#options = { ...options };
  }
  clear(): void { this.#revision++; this.#license = undefined; }
  async setKey(key: string): Promise<LicenseInfo> {
    const revision = ++this.#revision;
    if (typeof key !== 'string') throw new LicenseError('', 'Invalid key format.');
    key = key.trim();
    if (!key) { this.clear(); return this.getInfo(); }
    if (key.length > 4096) throw new LicenseError('', 'License key exceeds size limit.');
    const match = /^F3D-(PRO|ENTERPRISE)-(.+)-(\d{8})-([a-fA-F0-9]{128})$/i.exec(key);
    if (!match || !key.startsWith('F3D-')) throw new LicenseError('', 'Invalid key format. Expected F3D-TIER-CUSTOMER-YYYYMMDD-signature.');
    const tier = match[1]!.toUpperCase(), customerId = match[2]!, date = match[3]!;
    if (/\s/u.test(customerId)) throw new LicenseError('', 'Customer identifier must not contain whitespace.');
    const expiry = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, expiryMs = Date.parse(expiry + 'T00:00:00Z');
    if (!Number.isFinite(expiryMs) || new Date(expiryMs).toISOString().slice(0, 10) !== expiry) throw new LicenseError('', 'Invalid expiry date in license key.');
    const message = new TextEncoder().encode(`F3D-${tier}-${customerId}-${date}`), signature = new Uint8Array(hex(match[4]!, 64));
    let verifier: 'webcrypto' | 'noble' = 'noble', valid: boolean | undefined;
    const subtle = globalThis.crypto?.subtle;
    if (this.#options.verifier !== 'noble' && subtle) {
      try {
        const publicKey = await subtle.importKey('raw', this.#publicKey, 'Ed25519', false, ['verify']);
        valid = await subtle.verify('Ed25519', publicKey, signature, message);
        verifier = 'webcrypto';
      } catch { /* Older engines may expose SubtleCrypto without Ed25519. */ }
    }
    if (valid === undefined) {
      hashes.sha512 = message => new Uint8Array(sha512(message));
      try { valid = verify(signature, message, this.#publicKey, { zip215: false }); } catch { valid = false; }
    }
    if (!valid) throw new LicenseError('', 'License signature verification failed.');
    // A clear or a newer setKey must win over an older pending verification.
    if (revision === this.#revision) this.#license = { key, tier: tier.toLowerCase() as 'pro' | 'enterprise', customerId, expiryDay: expiryMs / DAY, verifier };
    return this.getInfo();
  }
  getInfo(): LicenseInfo {
    const value = this.#license;
    if (!value) return { status: 'missing', valid: false, tier: null, customerId: null, expiry: null, graceEnd: null, daysRemaining: 0, verifier: null };
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    if (!Number.isFinite(now)) throw new LicenseError('', 'Invalid license clock.');
    const elapsed = Math.floor(now / DAY) - value.expiryDay;
    const status = elapsed <= 0 ? 'active' : elapsed <= LICENSE_GRACE_DAYS ? 'grace' : 'expired';
    return { status, valid: true, tier: value.tier, customerId: value.customerId, expiry: iso(value.expiryDay), graceEnd: iso(value.expiryDay + LICENSE_GRACE_DAYS), daysRemaining: elapsed <= 0 ? Math.max(0, -elapsed) : Math.max(0, LICENSE_GRACE_DAYS - elapsed), verifier: value.verifier };
  }
  requirePro(feature = ''): void {
    const info = this.getInfo();
    if (info.status === 'missing') throw new LicenseError(feature);
    if (info.status === 'expired') throw new LicenseError(feature, `${feature ? feature + ' requires a Pro license. ' : ''}License expired on ${info.expiry}; grace period ended on ${info.graceEnd}.`);
    if (info.status === 'grace') (this.#options.onWarning ?? console.warn)(`Your forge3d Pro license expired on ${info.expiry}. Pro features will stop working in ${info.daysRemaining} days.`);
  }
  /** Persistence is explicit; uses W02/W08 stores, including OPFS/IndexedDB adapters. */
  async save(store: PersistentByteStore, name = 'forge3d-license'): Promise<void> {
    if (this.#license) await store.put(name, new TextEncoder().encode(this.#license.key));
    else await store.delete(name);
  }
  async load(store: PersistentByteStore, name = 'forge3d-license'): Promise<LicenseInfo> {
    const revision = this.#revision, bytes = await store.get(name);
    if (revision !== this.#revision) return this.getInfo();
    if (!bytes) { this.clear(); return this.getInfo(); }
    if (bytes.length > 4096) throw new LicenseError('', 'Stored license exceeds size limit.');
    let key: string;
    try { key = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new LicenseError('', 'Stored license is not valid UTF-8.'); }
    return this.setKey(key);
  }
}
export const licenseManager = new LicenseManager();
export function setLicenseKey(key: string): Promise<LicenseInfo> { return licenseManager.setKey(key); }
export function getLicenseInfo(): LicenseInfo { return licenseManager.getInfo(); }
export function requirePro(feature = ''): void { licenseManager.requirePro(feature); }
export function requiresPro<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, feature = fn.name, manager = licenseManager): (this: T, ...args: A) => R {
  return function (this: T, ...args: A): R { manager.requirePro(feature); return fn.apply(this, args); };
}
