import { Forge3DError } from "./index.js";
import type {
  Forge3DMessageCallOptions,
  Forge3DMessageContext,
  Forge3DMessageHandlers,
} from "./index.js";

const PROTOCOL = 1;

interface CallEnvelope {
  forge3d: number;
  type: "call";
  id: number;
  method: string;
  payload?: unknown;
}

interface CancelEnvelope {
  forge3d: number;
  type: "cancel";
  id: number;
}

interface ResultEnvelope {
  forge3d: number;
  type: "result";
  id: number;
  payload?: unknown;
}

interface ErrorEnvelope {
  forge3d: number;
  type: "error";
  id: number;
  error: { code: string; message: string; details?: unknown };
}

type Envelope = CallEnvelope | CancelEnvelope | ResultEnvelope | ErrorEnvelope;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  settled: boolean;
}

interface MessagePortLike {
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  start?(): void;
  close(): void;
}

function listen(
  port: MessagePortLike,
  listener: (data: unknown) => void,
): () => void {
  const wrapped = (event: { data: unknown }): void => listener(event.data);
  if (typeof port.addEventListener === "function") {
    port.addEventListener("message", wrapped);
    port.start?.();
    return () => port.removeEventListener?.("message", wrapped);
  }
  const legacy = port as unknown as {
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  const previous = legacy.onmessage;
  legacy.onmessage = wrapped;
  port.start?.();
  return () => {
    if (legacy.onmessage === wrapped) {
      legacy.onmessage = previous;
    }
  };
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { forge3d?: unknown }).forge3d === PROTOCOL &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function errorEnvelope(id: number, error: Forge3DError): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    forge3d: PROTOCOL,
    type: "error",
    id,
    error: { code: error.code, message: error.message },
  };
  if (error.details !== undefined) {
    try {
      structuredClone(error.details);
      envelope.error.details = error.details;
    } catch {}
  }
  return envelope;
}

function collectTransfer(value: unknown): Transferable[] {
  if (value instanceof ArrayBuffer) {
    return [value];
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer instanceof ArrayBuffer ? [value.buffer] : [];
  }
  return [];
}

export class Forge3DMessageClient {
  readonly #port: MessagePortLike;
  readonly #pending = new Map<number, PendingCall>();
  readonly #detach: () => void;
  #nextId = 0;
  #disposed = false;

  constructor(port: MessagePort) {
    this.#port = port as MessagePortLike;
    this.#detach = listen(this.#port, (data) => this.#onMessage(data));
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  call<T = unknown>(
    method: string,
    payload?: unknown,
    options: Forge3DMessageCallOptions = {},
  ): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(
        new Forge3DError("INVALID_INPUT", "method must be a nonempty string"),
      );
    }
    if (this.#disposed) {
      return Promise.reject(
        new Forge3DError("RUNTIME_DISPOSED", "Client is disposed"),
      );
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new Forge3DError("REQUEST_CANCELLED", "Call was cancelled"),
      );
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {},
        settled: false,
      };
      const settle = (fn: () => void): void => {
        if (entry.settled) {
          return;
        }
        entry.settled = true;
        this.#pending.delete(id);
        entry.cleanup();
        fn();
      };
      const onAbort = (): void => {
        try {
          this.#port.postMessage({
            forge3d: PROTOCOL,
            type: "cancel",
            id,
          } satisfies CancelEnvelope);
        } catch {}
        settle(() =>
          reject(new Forge3DError("REQUEST_CANCELLED", "Call was cancelled")),
        );
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, entry);
      try {
        const envelope: CallEnvelope = {
          forge3d: PROTOCOL,
          type: "call",
          id,
          method,
          payload,
        };
        this.#port.postMessage(envelope, options.transfer);
      } catch (error) {
        settle(() => reject(Forge3DError.from(error)));
      }
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#detach();
    const error = new Forge3DError(
      "RUNTIME_DISPOSED",
      "Client is disposed",
    );
    for (const entry of this.#pending.values()) {
      if (!entry.settled) {
        entry.settled = true;
        entry.cleanup();
        entry.reject(error);
      }
    }
    this.#pending.clear();
    try {
      this.#port.close();
    } catch {}
  }

  #onMessage(data: unknown): void {
    if (!isEnvelope(data)) {
      return;
    }
    const entry = this.#pending.get(data.id);
    if (entry === undefined) {
      return;
    }
    if (data.type === "result") {
      const result = (data as ResultEnvelope).payload;
      if (!entry.settled) {
        entry.settled = true;
        this.#pending.delete(data.id);
        entry.cleanup();
        entry.resolve(result);
      }
      return;
    }
    if (data.type === "error") {
      const remote = (data as ErrorEnvelope).error;
      const error = new Forge3DError(
        normalizeCode(remote?.code),
        typeof remote?.message === "string"
          ? remote.message
          : "Remote call failed",
        remote?.details,
      );
      if (!entry.settled) {
        entry.settled = true;
        this.#pending.delete(data.id);
        entry.cleanup();
        entry.reject(error);
      }
    }
  }
}

export function serveForge3DMessagePort(
  port: MessagePort,
  handlers: Forge3DMessageHandlers,
): () => void {
  const portLike = port as MessagePortLike;
  const calls = new Map<
    number,
    { controller: AbortController; started: boolean; responded: boolean }
  >();
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const post = (envelope: Envelope, transfer?: Transferable[]): void => {
    try {
      portLike.postMessage(envelope, transfer);
    } catch {}
  };

  const respondOnce = (id: number, envelope: Envelope, transfer?: Transferable[]): void => {
    const entry = calls.get(id);
    if (entry !== undefined && entry.responded) {
      return;
    }
    if (entry !== undefined) {
      entry.responded = true;
      calls.delete(id);
    }
    post(envelope, transfer);
  };

  const runCall = async (envelope: CallEnvelope): Promise<void> => {
    const entry = calls.get(envelope.id);
    if (entry === undefined || disposed) {
      return;
    }
    entry.started = true;
    if (entry.controller.signal.aborted) {
      respondOnce(
        envelope.id,
        errorEnvelope(
          envelope.id,
          new Forge3DError("REQUEST_CANCELLED", "Call was cancelled"),
        ),
      );
      return;
    }
    const handler = handlers[envelope.method];
    try {
      if (handler === undefined) {
        throw new Forge3DError(
          "INVALID_INPUT",
          `unknown method ${envelope.method}`,
        );
      }
      const context: Forge3DMessageContext = {
        signal: entry.controller.signal,
        requestId: envelope.id,
      };
      const result = await handler(envelope.payload, context);
      if (entry.controller.signal.aborted) {
        respondOnce(
          envelope.id,
          errorEnvelope(
            envelope.id,
            new Forge3DError("REQUEST_CANCELLED", "Call was cancelled"),
          ),
        );
        return;
      }
      respondOnce(
        envelope.id,
        {
          forge3d: PROTOCOL,
          type: "result",
          id: envelope.id,
          payload: result,
        } satisfies ResultEnvelope,
        collectTransfer(result),
      );
    } catch (error) {
      const normalized = Forge3DError.from(error);
      respondOnce(
        envelope.id,
        errorEnvelope(
          envelope.id,
          entry.controller.signal.aborted &&
            normalized.code !== "REQUEST_CANCELLED"
            ? new Forge3DError("REQUEST_CANCELLED", "Call was cancelled")
            : normalized,
        ),
      );
    }
  };

  const detach = listen(portLike, (data) => {
    if (disposed || !isEnvelope(data)) {
      return;
    }
    if (data.type === "call") {
      const call = data as CallEnvelope;
      calls.set(call.id, {
        controller: new AbortController(),
        started: false,
        responded: false,
      });
      chain = chain.then(() => runCall(call)).catch(() => undefined);
      return;
    }
    if (data.type === "cancel") {
      const cancel = data as CancelEnvelope;
      const entry = calls.get(cancel.id);
      if (entry !== undefined) {
        entry.controller.abort();
        if (!entry.started) {
          respondOnce(
            cancel.id,
            errorEnvelope(
              cancel.id,
              new Forge3DError("REQUEST_CANCELLED", "Call was cancelled"),
            ),
          );
        }
      }
    }
  });

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const entry of calls.values()) {
      entry.controller.abort();
    }
    calls.clear();
    detach();
    try {
      portLike.close();
    } catch {}
  };
}

export class Forge3DWebSocketAdapter {
  readonly #channel: MessageChannel;
  readonly #port: MessagePort;
  readonly #detachSocket: () => void;
  readonly #detachPort: () => void;
  #disposed = false;

  constructor(socket: WebSocket) {
    this.#channel = new MessageChannel();
    this.#port = this.#channel.port1;
    const socketLike = socket as unknown as {
      send(data: string): void;
      addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
      removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    };
    const onSocketMessage = (event: { data: unknown }): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        parsed = undefined;
      }
      if (!isEnvelope(parsed)) {
        parsed = errorEnvelope(
          -1,
          new Forge3DError(
            "INTERNAL_ERROR",
            "Malformed inbound Forge3D frame",
          ),
        );
      }
      try {
        this.#channel.port2.postMessage(parsed);
      } catch {}
    };
    socketLike.addEventListener("message", onSocketMessage);
    this.#detachSocket = () =>
      socketLike.removeEventListener("message", onSocketMessage);
    this.#detachPort = listen(
      this.#channel.port2 as unknown as MessagePortLike,
      (data) => {
        try {
          socketLike.send(JSON.stringify(data));
        } catch {}
      },
    );
  }

  get port(): MessagePort {
    return this.#port;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#detachSocket();
    this.#detachPort();
    try {
      this.#channel.port1.close();
    } catch {}
    try {
      this.#channel.port2.close();
    } catch {}
  }
}

function normalizeCode(code: unknown): Forge3DError["code"] {
  const codes = new Set<string>([
    "WEBGPU_UNAVAILABLE",
    "WEBGPU_ADAPTER_UNAVAILABLE",
    "INSECURE_CONTEXT",
    "WASM_LOAD_FAILED",
    "DEVICE_REQUEST_FAILED",
    "DEVICE_LOST",
    "SURFACE_CREATE_FAILED",
    "SURFACE_LOST",
    "SURFACE_OUTDATED",
    "OUT_OF_MEMORY",
    "UNSUPPORTED_FEATURE",
    "INVALID_INPUT",
    "IO_ERROR",
    "REQUEST_CANCELLED",
    "SHADER_COMPILATION_FAILED",
    "INTERNAL_ERROR",
    "RESOURCE_LIMIT_EXCEEDED",
    "RUNTIME_DISPOSED",
  ]);
  return codes.has(String(code))
    ? (String(code) as Forge3DError["code"])
    : "INTERNAL_ERROR";
}
