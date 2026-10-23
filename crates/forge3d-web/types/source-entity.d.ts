import type { MemoryByteCacheLike, PersistentByteCache } from './index.js';
/** Session-local entity identity shared by whole-file and ranged transport. */
export declare class SourceEntities {
    #private;
    readonly memory?: MemoryByteCacheLike | undefined;
    readonly persistent?: PersistentByteCache | undefined;
    readonly pinned: boolean;
    constructor(memory?: MemoryByteCacheLike | undefined, persistent?: PersistentByteCache | undefined, pinned?: boolean);
    check(source: string): void;
    current(source: string): string | undefined;
    size(source: string): number | undefined;
    validator(source: string): Promise<string | undefined>;
    track(source: string, key: string): void;
    observe(source: string, headers: Headers, total?: number, representation?: "whole" | "range"): Promise<void>;
    invalidate(source: string): Promise<void>;
}
export declare function entityIfMatch(validator: string | undefined): string | undefined;
