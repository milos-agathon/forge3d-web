import type { PostFxInput, PostFxChainInput, PostFxSnapshot, ColorLutInput } from "./postfx-types.js";
export type * from "./postfx-types.js";
export declare function createIdentityColorLut(size?: number): ColorLutInput;
/** Validate every option before crossing the WASM boundary. Does not reorder effects. */
export declare function normalizePostFx(input: PostFxChainInput | readonly PostFxInput[]): PostFxSnapshot;
export declare class PostFxChain {
    #private;
    constructor(input?: PostFxChainInput | readonly PostFxInput[]);
    snapshot(): PostFxSnapshot;
    toJSON(): PostFxChainInput;
    copy(): PostFxChain;
    setEnabled(id: string, enabled: boolean): this;
}
/** Revalidate serialized snapshots used by scene replay and workers. */
export declare function validatePostFxSnapshot(snapshot: PostFxSnapshot): PostFxSnapshot;
export declare function resolvePostFx(input: PostFxChain | PostFxChainInput | PostFxSnapshot | readonly PostFxInput[] | null): PostFxSnapshot | null;
