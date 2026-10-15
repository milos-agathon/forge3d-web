import type { PersistentByteStore } from './index.js';
/** Development default only. Production apps must call configureLicenseIssuer before setting a key. */
export declare const LICENSE_PUBLIC_KEY_HEX = "9a995d11c2da9df6b734e7aa98d7877bb326910998667bef349eb51e167382f7";
export declare const LICENSE_GRACE_DAYS = 14;
export declare const PRO_FEATURES: Readonly<{
    mapPlate: "Map plate composition";
    svg: "SVG export";
    pdf: "PDF export";
    geoJsonBuildings: "GeoJSON building import";
    cityJsonBuildings: "CityJSON building import";
    tilesBuildings: "3D Tiles building import";
    styleLoad: "Mapbox style loading";
    styleApply: "Mapbox style application";
    bundleSave: "Scene bundle save";
    bundleLoad: "Scene bundle load";
}>;
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
    /** Local calendar day, matching native date.today(). Client clocks are not trusted entitlements. */
    now?: () => Date;
    onWarning?: (message: string) => void;
}
export declare class LicenseError extends Error {
    readonly code = "LICENSE_REQUIRED";
    constructor(feature?: string, detail?: string);
}
/** Offline validity and client API gating. This is not tamper-resistant DRM. */
export declare class LicenseManager {
    #private;
    constructor(options?: LicenseManagerOptions);
    /** Configure once, before any nonempty key attempt. Clearing never unlocks the issuer. */
    configureIssuer(publicKeyHex: string): void;
    clear(): void;
    setKey(key: string): Promise<LicenseInfo>;
    getInfo(): LicenseInfo;
    requirePro(feature?: string): void;
    /** Persistence is explicit; uses W02/W08 stores, including OPFS/IndexedDB adapters. */
    save(store: PersistentByteStore, name?: string): Promise<void>;
    load(store: PersistentByteStore, name?: string): Promise<LicenseInfo>;
}
export declare const licenseManager: LicenseManager;
/** Configure the package-wide product-gate issuer exactly once, before setting a key. */
export declare function configureLicenseIssuer(publicKeyHex: string): void;
export declare function setLicenseKey(key: string): Promise<LicenseInfo>;
export declare function getLicenseInfo(): LicenseInfo;
export declare function requirePro(feature?: string): void;
export declare function requiresPro<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, feature?: string, manager?: LicenseManager): (this: T, ...args: A) => R;
