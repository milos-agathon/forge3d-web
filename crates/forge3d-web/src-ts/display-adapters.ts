import { Forge3DError } from "./index.js";
import type {
  Forge3DNotebookAdapter,
  Forge3DScene as Forge3DSceneShape,
  Forge3DSessionOptions,
} from "./index.js";
import { Forge3DSession } from "./session.js";

const DEFAULT_TAG = "forge3d-viewer";

interface DocumentLike {
  createElement(tag: string): HTMLElement;
}

interface CustomElementsLike {
  get(name: string): CustomElementConstructor | undefined;
  define(name: string, ctor: CustomElementConstructor): void;
}

export function defineForge3DElement(
  tagName = DEFAULT_TAG,
): CustomElementConstructor {
  const registry = (
    globalThis as typeof globalThis & { customElements?: CustomElementsLike }
  ).customElements;
  const HTMLElementBase = (
    globalThis as typeof globalThis & {
      HTMLElement?: typeof HTMLElement;
    }
  ).HTMLElement;
  if (
    registry === undefined ||
    typeof registry.define !== "function" ||
    HTMLElementBase === undefined
  ) {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "Custom elements are not available",
    );
  }
  const existing = registry.get(tagName);
  if (existing !== undefined) {
    return existing;
  }

  class Forge3DElement extends HTMLElementBase {
    #session: Promise<Forge3DSession> | undefined;
    #canvas: HTMLCanvasElement | undefined;
    #disposed = false;

    connectedCallback(): void {
      if (this.#canvas !== undefined) {
        return;
      }
      const root = this.attachShadow({ mode: "open" });
      const documentLike = (this.ownerDocument ??
        (globalThis as typeof globalThis & { document?: DocumentLike })
          .document) as DocumentLike | undefined;
      const canvas = documentLike?.createElement("canvas") as
        | HTMLCanvasElement
        | undefined;
      if (canvas === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "DOM is not available for Forge3D elements",
        );
      }
      canvas.setAttribute("role", "img");
      canvas.setAttribute("tabindex", "0");
      canvas.setAttribute(
        "aria-label",
        this.getAttribute("aria-label") ?? "Forge3D renderer",
      );
      root.appendChild(canvas);
      this.#canvas = canvas;
    }

    disconnectedCallback(): void {
      this.dispose();
    }

    initialize(options?: Forge3DSessionOptions): Promise<Forge3DSession> {
      if (this.#disposed) {
        return Promise.reject(
          new Forge3DError(
            "RUNTIME_DISPOSED",
            "Forge3D element is disposed",
          ),
        );
      }
      if (this.#canvas === undefined) {
        return Promise.reject(
          new Forge3DError(
            "UNSUPPORTED_FEATURE",
            "Forge3D element is not connected",
          ),
        );
      }
      this.#session ??= Forge3DSession.create(this.#canvas, options ?? {});
      return this.#session;
    }

    get session(): Promise<Forge3DSession> {
      return this.initialize();
    }

    set scene(scene: Forge3DSceneShape) {
      void this.initialize()
        .then((session) => {
          session.setScene(scene);
          session.render();
        })
        .catch((error: unknown) => {
          reportDisplayError(error);
        });
    }

    async capture(): Promise<Blob> {
      return (await this.initialize()).screenshot();
    }

    dispose(): void {
      if (this.#disposed) {
        return;
      }
      this.#disposed = true;
      const pending = this.#session;
      this.#session = undefined;
      if (pending !== undefined) {
        void pending.then(
          (session) => session.dispose(),
          () => undefined,
        );
      }
      this.#canvas?.remove();
      this.#canvas = undefined;
    }
  }

  registry.define(tagName, Forge3DElement);
  return Forge3DElement;
}

function reportDisplayError(error: unknown): void {
  const report = (
    globalThis as typeof globalThis & {
      reportError?: (value: unknown) => void;
    }
  ).reportError;
  if (typeof report === "function") {
    report(error);
    return;
  }
  console.error(error);
}

export function createNotebookAdapter(
  container: HTMLElement,
  options: Forge3DSessionOptions = {},
): Forge3DNotebookAdapter {
  const documentLike = (
    globalThis as typeof globalThis & { document?: DocumentLike }
  ).document;
  if (
    documentLike === undefined ||
    typeof documentLike.createElement !== "function"
  ) {
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "DOM is not available for notebook adapters",
    );
  }
  const canvas = documentLike.createElement("canvas") as HTMLCanvasElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("aria-label", "Forge3D renderer");
  container.appendChild(canvas);

  let sessionPromise: Promise<Forge3DSession> | undefined;
  let disposed = false;
  const ensureSession = (): Promise<Forge3DSession> => {
    if (disposed) {
      return Promise.reject(
        new Forge3DError(
          "RUNTIME_DISPOSED",
          "Notebook adapter is disposed",
        ),
      );
    }
    sessionPromise ??= Forge3DSession.create(canvas, options);
    return sessionPromise;
  };

  return {
    canvas,
    get session() {
      return ensureSession();
    },
    async display(scene: Forge3DSceneShape): Promise<void> {
      const session = await ensureSession();
      session.setScene(scene);
      session.render();
    },
    async capture(): Promise<Blob> {
      return (await ensureSession()).screenshot();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      const pending = sessionPromise;
      sessionPromise = undefined;
      if (pending !== undefined) {
        void pending.then(
          (session) => session.dispose(),
          () => undefined,
        );
      }
      canvas.remove();
    },
  };
}
