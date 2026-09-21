import { Forge3DError } from "./index.js";
import type {
  CameraInput,
  Forge3DSessionOptions,
  Forge3DWorkerRendererOptions,
  RendererConfigInput,
  ResizeInput,
  SceneSnapshot,
  WorkerRendererDiagnostics,
} from "./index.js";
import { Forge3DMessageClient, serveForge3DMessagePort } from "./message-protocol.js";
import { OrbitController, defaultOrbitView } from "./orbit-controller.js";
import { ResizeController } from "./resize-controller.js";
import { validateExplicitResize } from "./resource-policy.js";
import { RendererConfig } from "./renderer-config.js";
import { Forge3DScene } from "./scene.js";
import { Forge3DSession } from "./session.js";
import { ViewerControls } from "./viewer-controls.js";

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

interface RendererState {
  scene: SceneSnapshot | undefined;
  camera: CameraInput | undefined;
  size: ResizeInput | undefined;
}

interface HostSession {
  sessionPromise: Promise<Forge3DSession>;
  disposeProtocol: () => void;
  sessionDisposed: boolean;
}

const DEFAULT_MAX_DPR = 2;
const DEFAULT_MAX_CANVAS_PIXELS = 4096 * 4096;
const DEFAULT_MAX_TEXTURE_DIMENSION = 8192;

export class Forge3DWorkerRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #client: Forge3DMessageClient;
  #controls: ViewerControls | undefined;
  #controller: OrbitController | undefined;
  #resizer: ResizeController | undefined;
  readonly #previousRole: string | null;
  readonly #previousAriaLabel: string | null;
  readonly #state: RendererState = {
    scene: undefined,
    camera: undefined,
    size: undefined,
  };
  #disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    client: Forge3DMessageClient,
    previousRole: string | null,
    previousAriaLabel: string | null,
  ) {
    this.#canvas = canvas;
    this.#client = client;
    this.#previousRole = previousRole;
    this.#previousAriaLabel = previousAriaLabel;
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: Forge3DWorkerRendererOptions,
  ): Promise<Forge3DWorkerRenderer> {
    const transferable = canvas as HTMLCanvasElement & {
      transferControlToOffscreen?: () => OffscreenCanvas;
    };
    if (typeof transferable.transferControlToOffscreen !== "function") {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Canvas does not support transferControlToOffscreen",
      );
    }
    const previousRole = canvas.getAttribute("role");
    const previousAriaLabel = canvas.getAttribute("aria-label");
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      options.ariaLabel ?? "Forge3D renderer",
    );

    const channel = new MessageChannel();
    const client = new Forge3DMessageClient(channel.port1);
    const offscreen = transferable.transferControlToOffscreen();
    try {
      (options.worker as unknown as WorkerLike).postMessage(
        {
          forge3d: 1,
          type: "init",
          canvas: offscreen,
          port: channel.port2,
          options: { session: serializeSessionOptions(options.session) },
        },
        [offscreen as unknown as Transferable, channel.port2],
      );
      await client.call("ready");
    } catch (error) {
      client.dispose();
      try {
        channel.port2.close();
      } catch {}
      restoreAttribute(canvas, "role", previousRole);
      restoreAttribute(canvas, "aria-label", previousAriaLabel);
      throw Forge3DError.from(error);
    }

    let controller: OrbitController | undefined;
    let controls: ViewerControls | undefined;
    const renderer = new Forge3DWorkerRenderer(
      canvas,
      client,
      previousRole,
      previousAriaLabel,
    );
    if (options.controls !== false) {
      controller = new OrbitController(
        defaultOrbitView(),
        options.controls ?? {},
      );
      controls = new ViewerControls(
        canvas,
        controller,
        options.controls ?? {},
        () => renderer.#sendCamera(),
      );
      renderer.#controls = controls;
      renderer.#controller = controller;
    }
    if (options.resize !== false) {
      renderer.#resizer = new ResizeController({
        canvas,
        maxDevicePixelRatio:
          options.resize?.maxDevicePixelRatio ?? DEFAULT_MAX_DPR,
        maxCanvasPixels: DEFAULT_MAX_CANVAS_PIXELS,
        maxTextureDimension2D: DEFAULT_MAX_TEXTURE_DIMENSION,
        onResize: (size) => {
          if (renderer.disposed) {
            return;
          }
          void renderer.resize(size).catch(() => undefined);
        },
      });
    }
    renderer.#sendCamera();
    return renderer;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async setScene(scene: Forge3DScene): Promise<void> {
    this.#assertLive();
    if (!(scene instanceof Forge3DScene) || scene.disposed) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "scene must be a live Forge3DScene",
      );
    }
    const snapshot = scene.copy().snapshot();
    const transfer: Transferable[] = [];
    for (const node of snapshot.nodes) {
      if (node.node.kind === "terrain") {
        transfer.push(node.node.terrain.heights.buffer as ArrayBuffer);
      }
    }
    const committed =
      transfer.length > 0 ? scene.copy().snapshot() : snapshot;
    const previous = this.#state.scene;
    this.#state.scene = committed;
    try {
      await this.#client.call("setScene", snapshot, { transfer });
    } catch (error) {
      this.#state.scene = previous;
      throw Forge3DError.from(error);
    }
  }

  render(): Promise<boolean> {
    this.#assertLive();
    return this.#client.call<boolean>("render");
  }

  resize(size: ResizeInput): Promise<void> {
    this.#assertLive();
    validateExplicitResize(size);
    const normalized = { ...size };
    return this.#client.call("resize", normalized).then(() => {
      this.#state.size = normalized;
    });
  }

  screenshot(): Promise<Blob> {
    this.#assertLive();
    return this.#client.call<Blob>("screenshot");
  }

  readRgba(): Promise<Uint8Array> {
    this.#assertLive();
    return this.#client.call<Uint8Array>("readRgba");
  }

  getDiagnostics(): WorkerRendererDiagnostics {
    return {
      ownedListeners: this.#controls?.ownedListeners ?? 0,
      activePointers: this.#controls?.activePointers ?? 0,
      activeObservers: this.#resizer?.activeObservers ?? 0,
      disposed: this.#disposed,
      stateHash: computeStateHash(this.#state),
    };
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    void this.#client.call("dispose").catch(() => undefined);
    this.#client.dispose();
    this.#controls?.dispose();
    this.#resizer?.dispose();
    restoreAttribute(this.#canvas, "role", this.#previousRole);
    restoreAttribute(this.#canvas, "aria-label", this.#previousAriaLabel);
  }

  #sendCamera(): void {
    if (this.#disposed || this.#controller === undefined) {
      return;
    }
    const camera = this.#controller.getCamera();
    this.#state.camera = camera;
    void this.#client.call("setCamera", camera).catch(() => undefined);
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Forge3DError(
        "RUNTIME_DISPOSED",
        "Worker renderer is disposed",
      );
    }
  }
}

export function installForge3DWorkerHost(scope?: Worker): () => void {
  const target = (scope ?? globalThis) as unknown as {
    addEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
    removeEventListener(
      type: "message",
      listener: (event: { data: unknown }) => void,
    ): void;
  };
  let disposed = false;
  let active: HostSession | undefined;

  const teardown = (host: HostSession | undefined): void => {
    if (host === undefined) {
      return;
    }
    if (!host.sessionDisposed) {
      host.sessionDisposed = true;
      void host.sessionPromise.then(
        (session) => {
          try {
            session.dispose();
          } catch {}
        },
        () => undefined,
      );
    }
    host.disposeProtocol();
  };

  const onMessage = (event: { data: unknown }): void => {
    if (disposed) {
      return;
    }
    const data = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      (data as { forge3d?: unknown }).forge3d !== 1 ||
      (data as { type?: unknown }).type !== "init"
    ) {
      return;
    }
    const init = data as {
      canvas: OffscreenCanvas;
      port: MessagePort;
      options?: { session?: Forge3DSessionOptions };
    };
    const state: RendererState = {
      scene: undefined,
      camera: undefined,
      size: undefined,
    };
    const sessionPromise = Forge3DSession.create(
      init.canvas,
      init.options?.session ?? {},
    );
    const host: HostSession = {
      sessionPromise,
      sessionDisposed: false,
      disposeProtocol: () => {},
    };
    const session = async (): Promise<Forge3DSession> => {
      const created = await sessionPromise;
      await created.whenReady();
      return created;
    };
    host.disposeProtocol = serveForge3DMessagePort(init.port, {
      ready: async () => {
        await session();
        return true;
      },
      setScene: async (payload) => {
        const snapshot = payload as SceneSnapshot;
        const scene = reconstructScene(snapshot);
        (await session()).setScene(scene);
        state.scene = snapshot;
      },
      setCamera: async (payload) => {
        const camera = payload as CameraInput;
        (await session()).setCamera(camera);
        state.camera = camera;
      },
      render: async () => (await session()).render(),
      resize: async (payload) => {
        const size = payload as ResizeInput;
        (await session()).resize(size);
        state.size = size;
      },
      screenshot: async () => (await session()).screenshot(),
      readRgba: async () => (await session()).readRgba(),
      diagnostics: async () => ({ stateHash: computeStateHash(state) }),
      dispose: async () => {
        if (host.sessionDisposed) {
          return true;
        }
        host.sessionDisposed = true;
        try {
          (await sessionPromise).dispose();
        } catch {}
        return true;
      },
    });
    teardown(active);
    active = host;
  };

  target.addEventListener("message", onMessage);
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    target.removeEventListener("message", onMessage);
    teardown(active);
    active = undefined;
  };
}

function reconstructScene(snapshot: SceneSnapshot): Forge3DScene {
  const scene = Forge3DScene.create();
  const ids = new Map<number, number>();
  for (const node of snapshot.nodes) {
    const id = scene.addNode(node.node);
    ids.set(node.id, id);
    if (node.parent !== null) {
      const parent = ids.get(node.parent);
      if (parent === undefined) {
        throw new Forge3DError(
          "INVALID_INPUT",
          `scene node ${node.id} references unknown or later parent ${node.parent}`,
        );
      }
      scene.setParent(id, parent);
    }
    scene.setTransform(id, node.transform);
    if (!node.visible) {
      scene.setVisible(id, false);
    }
  }
  for (const pass of snapshot.passes) {
    scene.addPass(pass);
  }
  return scene;
}

function serializeSessionOptions(
  options: Forge3DSessionOptions | undefined,
): Forge3DSessionOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  const serialized: Forge3DSessionOptions = {};
  if (options.runtime !== undefined) {
    serialized.runtime = { ...options.runtime };
  }
  if (options.recovery !== undefined) {
    serialized.recovery = { ...options.recovery };
  }
  if (options.renderer !== undefined) {
    const data = RendererConfig.from(options.renderer).toJSON();
    serialized.renderer = {
      ...data,
      brdfOverride: data.brdfOverride ?? null,
    } as RendererConfigInput;
  }
  return serialized;
}

function restoreAttribute(
  canvas: HTMLCanvasElement,
  name: string,
  previous: string | null,
): void {
  if (previous === null) {
    canvas.removeAttribute(name);
    return;
  }
  canvas.setAttribute(name, previous);
}

function canonicalJson(value: unknown, stack?: Set<object>): string {
  const active = stack ?? new Set<object>();
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (active.has(value)) {
    return '"[Circular]"';
  }
  if (ArrayBuffer.isView(value)) {
    return canonicalJson(
      Array.from(value as unknown as ArrayLike<number>),
      active,
    );
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" &&
      value instanceof SharedArrayBuffer)
  ) {
    return canonicalJson(
      Array.from(new Uint8Array(value as ArrayBuffer)),
      active,
    );
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => canonicalJson(entry, active))
        .join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], active)}`,
      )
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function computeStateHash(state: RendererState): string {
  const json = canonicalJson(state);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
