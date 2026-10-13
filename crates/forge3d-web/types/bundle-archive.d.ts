export interface BundleLimits {
    maxBytes?: number;
    maxExpandedBytes?: number;
    maxEntries?: number;
}
export declare function bundleLimits(input?: BundleLimits): {
    maxBytes: number;
    maxExpandedBytes: number;
    maxEntries: number;
};
export declare function bundlePath(path: string): string;
export declare function bundleFailure(message: string, reason?: string): never;
export declare function bundleCancelled(signal?: AbortSignal): void;
export declare function bundleHash(data: Uint8Array): Promise<string>;
/** Reject ZIP64, duplicate names, oversized central declarations and malformed/trailing data before inflate. */
export declare function decodeBundleArchive(bytes: Uint8Array, input?: BundleLimits, signal?: AbortSignal): Record<string, Uint8Array>;
export declare function encodeBundleArchive(files: Record<string, Uint8Array>, input?: BundleLimits): Uint8Array;
