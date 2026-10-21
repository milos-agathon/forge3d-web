import type { Forge3DRuntime, Forge3DRuntimeOptions } from './index.js';
type Factory = (canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions) => Promise<Forge3DRuntime>;
export interface MapNativeContext {
    create: Factory;
    dispose(): void;
}
/** Opaque ownership token, valid only inside MapScene.withRenderContext. */
export interface MapSceneRenderContext {
    readonly kind: 'forge3d.map-render-context';
}
export declare function withMapRenderContext<T>(work: (context: MapSceneRenderContext) => Promise<T>): Promise<T>;
/** WebGPU validation scopes are a device stack. Serialize complete frames on
 * a shared device so independent calls cannot consume each other's errors. */
export declare function scheduleMapFrame<T>(token: MapSceneRenderContext, render: () => Promise<T>): Promise<T>;
export declare function createScopedMapRuntime(token: MapSceneRenderContext, canvas: HTMLCanvasElement | OffscreenCanvas, options: Forge3DRuntimeOptions, fallback: Factory): Promise<Forge3DRuntime>;
export {};
