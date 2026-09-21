import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Forge3DRuntimeCapabilities,
  SceneSnapshot,
} from "../../src-ts/index.js";
import { Forge3DError } from "../../src-ts/index.js";
import {
  createNotebookAdapter,
  defineForge3DElement,
} from "../../src-ts/display-adapters.js";
import { Forge3DScene } from "../../src-ts/scene.js";
import { setSessionRuntimeFactoryForTests } from "../../src-ts/session.js";
import type { SessionRuntimeLike } from "../../src-ts/session.js";

const CAPABILITIES: Forge3DRuntimeCapabilities = {
  deviceState: "ready",
  maxTextureDimension2D: 4096,
  maxBufferSize: 1024 * 1024,
  surfaceFormat: "bgra8unorm",
};

class FakeRuntime implements SessionRuntimeLike {
  static instances: FakeRuntime[] = [];

  disposed = false;
  renderCalls = 0;
  scenes: SceneSnapshot[] = [];
  sceneError: unknown;

  constructor() {
    FakeRuntime.instances.push(this);
  }

  getCapabilities(): Forge3DRuntimeCapabilities {
    return CAPABILITIES;
  }

  setScene(scene: SceneSnapshot): void {
    if (this.sceneError !== undefined) {
      throw this.sceneError;
    }
    this.scenes.push(scene);
  }

  setDeviceLostHandler(): void {}

  render(): boolean {
    this.renderCalls += 1;
    return true;
  }

  screenshot(): Promise<Blob> {
    return Promise.resolve(new Blob([new Uint8Array([1])]));
  }

  dispose(): void {
    this.disposed = true;
  }
}

interface FakeElement {
  tag: string;
  attributes: Map<string, string>;
  children: FakeElement[];
  removed: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): void;
  remove(): void;
}

function makeElement(tag: string): FakeElement {
  return {
    tag,
    attributes: new Map(),
    children: [],
    removed: false,
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {
      this.removed = true;
    },
  };
}

function installDom(): { canvases: FakeElement[] } {
  const canvases: FakeElement[] = [];
  vi.stubGlobal("document", {
    createElement(tag: string) {
      const element = makeElement(tag);
      if (tag === "canvas") {
        canvases.push(element);
      }
      return element;
    },
  });
  return { canvases };
}

class FakeHTMLElementBase {
  ownerDocument: unknown;
  shadow: { children: FakeElement[]; appendChild(c: FakeElement): void } =
    {
      children: [],
      appendChild(child) {
        this.children.push(child);
      },
    };
  readonly #attrs = new Map<string, string>();

  attachShadow(): this["shadow"] {
    return this.shadow;
  }

  getAttribute(name: string): string | null {
    return this.#attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#attrs.set(name, value);
  }
}

function installCustomElements(): Map<string, unknown> {
  const registry = new Map<string, unknown>();
  vi.stubGlobal("customElements", {
    get: (name: string) => registry.get(name),
    define: (name: string, ctor: unknown) => registry.set(name, ctor),
  });
  vi.stubGlobal("HTMLElement", FakeHTMLElementBase);
  return registry;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  setSessionRuntimeFactoryForTests(undefined);
  FakeRuntime.instances = [];
  vi.unstubAllGlobals();
});

describe("defineForge3DElement", () => {
  it("throws UNSUPPORTED_FEATURE without DOM or custom elements", () => {
    vi.stubGlobal("customElements", undefined);
    vi.stubGlobal("HTMLElement", undefined);
    expect(() => defineForge3DElement()).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_FEATURE" }) as never,
    );
  });

  it("defines once and returns the existing registration", () => {
    installDom();
    const registry = installCustomElements();
    const first = defineForge3DElement("forge3d-test-el");
    const second = defineForge3DElement("forge3d-test-el");
    expect(first).toBe(second);
    expect(registry.get("forge3d-test-el")).toBe(first);
  });

  it("creates a shadow canvas with accessible defaults and drives sessions", async () => {
    const { canvases } = installDom();
    installCustomElements();
    setSessionRuntimeFactoryForTests(() =>
      Promise.resolve(new FakeRuntime()),
    );

    const Ctor = defineForge3DElement("forge3d-drive");
    const element = new Ctor() as unknown as {
      connectedCallback(): void;
      disconnectedCallback(): void;
      initialize(options?: unknown): Promise<unknown>;
      capture(): Promise<Blob>;
      dispose(): void;
      scene: unknown;
      session: Promise<unknown>;
      setAttribute(name: string, value: string): void;
    };
    element.setAttribute("aria-label", "plot");
    element.connectedCallback();

    expect(canvases).toHaveLength(1);
    const canvas = canvases[0]!;
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("aria-label")).toBe("plot");

    const session = (await element.initialize()) as {
      render(): boolean;
      setScene(scene: unknown): void;
    };
    expect(session).toBeDefined();

    const scene = Forge3DScene.create();
    scene.addOverlay({
      name: "hud",
      bounds: [0, 0, 4, 4],
      color: [0, 0, 0, 1],
    });
    element.scene = scene;
    await flush();
    expect(FakeRuntime.instances[0]!.scenes).toHaveLength(1);
    expect(FakeRuntime.instances[0]!.renderCalls).toBe(1);

    const blob = await element.capture();
    expect(blob).toBeInstanceOf(Blob);

    element.disconnectedCallback();
    await flush();
    expect(FakeRuntime.instances[0]!.disposed).toBe(true);
    expect(canvas.removed).toBe(true);
    await expect(element.initialize()).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });

  it("reports async scene setter failures through reportError", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("reportError", (value: unknown) => {
      errors.push(value);
    });
    installDom();
    installCustomElements();
    setSessionRuntimeFactoryForTests(() => {
      const runtime = new FakeRuntime();
      runtime.sceneError = new Forge3DError("INVALID_INPUT", "bad scene");
      return Promise.resolve(runtime);
    });
    const Ctor = defineForge3DElement("forge3d-scene-error");
    const element = new Ctor() as unknown as {
      connectedCallback(): void;
      scene: unknown;
    };
    element.connectedCallback();
    element.scene = Forge3DScene.create();
    await flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: string }).code).toBe("INVALID_INPUT");
  });

  it("rejects initialize while disconnected", async () => {
    installDom();
    installCustomElements();
    const Ctor = defineForge3DElement("forge3d-idle");
    const element = new Ctor() as unknown as {
      initialize(): Promise<unknown>;
    };
    await expect(element.initialize()).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
  });
});

describe("createNotebookAdapter", () => {
  it("throws UNSUPPORTED_FEATURE without DOM", () => {
    vi.stubGlobal("document", undefined);
    expect(() =>
      createNotebookAdapter(makeElement("div") as unknown as HTMLElement),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_FEATURE" }) as never,
    );
  });

  it("appends exactly one canvas and lazily drives the session", async () => {
    const { canvases } = installDom();
    setSessionRuntimeFactoryForTests(() =>
      Promise.resolve(new FakeRuntime()),
    );
    const container = makeElement("div");
    const adapter = createNotebookAdapter(
      container as unknown as HTMLElement,
    );
    expect(container.children).toHaveLength(1);
    expect(canvases).toHaveLength(1);
    expect(FakeRuntime.instances).toHaveLength(0);

    const scene = Forge3DScene.create();
    scene.addGroundPlane({
      name: "ground",
      size: [2, 2],
      color: [1, 1, 1, 1],
    });
    await adapter.display(scene);
    expect(FakeRuntime.instances).toHaveLength(1);
    expect(FakeRuntime.instances[0]!.scenes).toHaveLength(1);
    expect(FakeRuntime.instances[0]!.renderCalls).toBe(1);

    const blob = await adapter.capture();
    expect(blob).toBeInstanceOf(Blob);
    expect(FakeRuntime.instances).toHaveLength(1);

    adapter.dispose();
    adapter.dispose();
    await flush();
    expect(canvases[0]!.removed).toBe(true);
    expect(FakeRuntime.instances[0]!.disposed).toBe(true);
    await expect(adapter.session).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
  });
});
