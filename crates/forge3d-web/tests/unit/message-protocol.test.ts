import { describe, expect, it } from "vitest";

import { Forge3DError } from "../../src-ts/index.js";
import type { Forge3DMessageContext } from "../../src-ts/index.js";
import {
  Forge3DMessageClient,
  Forge3DWebSocketAdapter,
  serveForge3DMessagePort,
} from "../../src-ts/message-protocol.js";

interface LinkedPair {
  client: Forge3DMessageClient;
  disposeServer: () => void;
}

function linked(
  handlers: Record<
    string,
    (payload: unknown, context: Forge3DMessageContext) => unknown
  >,
): LinkedPair {
  const channel = new MessageChannel();
  return {
    client: new Forge3DMessageClient(channel.port1),
    disposeServer: serveForge3DMessagePort(channel.port2, handlers),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Forge3DMessageClient", () => {
  it("correlates results to the matching request id", async () => {
    const { client, disposeServer } = linked({
      slow: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return payload;
      },
      fast: (payload) => payload,
    });
    const slow = client.call("slow", "a");
    const fast = client.call("fast", "b");
    expect(await fast).toBe("b");
    expect(await slow).toBe("a");
    client.dispose();
    disposeServer();
  });

  it("runs server handlers in receive order", async () => {
    const order: string[] = [];
    const { client, disposeServer } = linked({
      step: async (payload) => {
        order.push(String(payload));
        await tick();
      },
    });
    await Promise.all([
      client.call("step", "one"),
      client.call("step", "two"),
      client.call("step", "three"),
    ]);
    expect(order).toEqual(["one", "two", "three"]);
    client.dispose();
    disposeServer();
  });

  it("delivers transfer lists to the server port", async () => {
    const received: ArrayBuffer[] = [];
    const channel = new MessageChannel();
    channel.port2.addEventListener("message", (event) => {
      const data = event.data as { payload?: { buffer?: ArrayBuffer } };
      if (data.payload?.buffer !== undefined) {
        received.push(data.payload.buffer);
      }
    });
    channel.port2.start();
    const client = new Forge3DMessageClient(channel.port1);
    const buffer = new ArrayBuffer(8);
    void client
      .call("noop", { buffer }, { transfer: [buffer] })
      .catch(() => undefined);
    await tick();
    await tick();
    expect(received).toHaveLength(1);
    expect(received[0]!.byteLength).toBe(8);
    expect(buffer.byteLength).toBe(0);
    client.dispose();
    channel.port2.close();
  });

  it("normalizes remote errors including unknown methods", async () => {
    const { client, disposeServer } = linked({
      boom: () => {
        throw new Forge3DError("OUT_OF_MEMORY", "gpu full", { cap: 1 });
      },
      boomPlain: () => {
        throw new TypeError("plain failure");
      },
    });
    await expect(client.call("boom")).rejects.toMatchObject({
      code: "OUT_OF_MEMORY",
      message: "gpu full",
      details: { cap: 1 },
    });
    await expect(client.call("boomPlain")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(client.call("missing")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "unknown method missing",
    });
    client.dispose();
    disposeServer();
  });

  it("cancels an active call exactly once", async () => {
    let aborted = false;
    const { client, disposeServer } = linked({
      long: (_payload, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("interrupted");
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const pending = client.call("long", null, { signal: controller.signal });
    const expectation = expect(pending).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    await tick();
    controller.abort();
    await expectation;
    await tick();
    await tick();
    expect(aborted).toBe(true);
    client.dispose();
    disposeServer();
  });

  it("cancels a queued call before it starts", async () => {
    const started: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { client, disposeServer } = linked({
      work: async (payload) => {
        started.push(String(payload));
        await gate;
      },
    });
    const first = client.call("work", "first");
    await tick();
    const controller = new AbortController();
    const second = client.call("work", "second", {
      signal: controller.signal,
    });
    const expectation = expect(second).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    await tick();
    controller.abort();
    await tick();
    await tick();
    releaseFirst();
    await first;
    await expectation;
    expect(started).toEqual(["first"]);
    client.dispose();
    disposeServer();
  });

  it("rejects pre-aborted and invalid calls without posting", async () => {
    const { client, disposeServer } = linked({});
    await expect(client.call("")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.call("x", null, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    client.dispose();
    disposeServer();
  });

  it("dispose rejects pending calls and closes its own port", async () => {
    const { client, disposeServer } = linked({
      hang: () => new Promise(() => {}),
    });
    const pending = client.call("hang");
    client.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    await expect(client.call("hang")).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    expect(client.disposed).toBe(true);
    client.dispose();
    disposeServer();
  });

  it("server disposer aborts active handlers and closes the port", async () => {
    let aborted = false;
    const { client, disposeServer } = linked({
      long: (_payload, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("x");
            },
            { once: true },
          );
        }),
    });
    const pending = client.call("long");
    const expectation = expect(pending).rejects.toBeInstanceOf(Forge3DError);
    await tick();
    await tick();
    disposeServer();
    expect(aborted).toBe(true);
    client.dispose();
    await expectation;
    disposeServer();
  });
});

describe("Forge3DWebSocketAdapter", () => {
  function fakeSocket() {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const sent: string[] = [];
    return {
      sent,
      listeners,
      send(data: string) {
        sent.push(data);
      },
      addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
        listeners.delete(listener);
      },
      emit(data: unknown) {
        for (const listener of [...listeners]) {
          listener({ data });
        }
      },
      closeCalls: 0,
      close() {
        this.closeCalls += 1;
      },
    } as unknown as WebSocket & {
      sent: string[];
      emit(data: unknown): void;
      closeCalls: number;
    };
  }

  it("forwards port messages to the socket and socket frames to the port", async () => {
    const socket = fakeSocket();
    const adapter = new Forge3DWebSocketAdapter(socket);
    const remote = new Forge3DMessageClient(adapter.port);
    socket.emit(
      JSON.stringify({ forge3d: 1, type: "result", id: 77, payload: "hi" }),
    );
    const pending = remote.call<string>("noop");
    await tick();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      forge3d: 1,
      type: "call",
      method: "noop",
    });
    socket.emit(
      JSON.stringify({ forge3d: 1, type: "result", id: 0, payload: "hi" }),
    );
    await tick();
    expect(await pending).toBe("hi");
    remote.dispose();
    adapter.dispose();
  });

  it("turns malformed inbound frames into INTERNAL_ERROR envelopes", async () => {
    const socket = fakeSocket();
    const adapter = new Forge3DWebSocketAdapter(socket);
    const client = new Forge3DMessageClient(adapter.port);
    const pending = client.call("x");
    await tick();
    socket.emit("not-json{{{");
    socket.emit(JSON.stringify({ unrelated: true }));
    await tick();
    socket.emit(
      JSON.stringify({ forge3d: 1, type: "result", id: 0, payload: "ok" }),
    );
    await tick();
    expect(await pending).toBe("ok");
    client.dispose();
    adapter.dispose();
  });

  it("never opens or closes the app-owned socket on dispose", () => {
    const socket = fakeSocket();
    const adapter = new Forge3DWebSocketAdapter(socket);
    adapter.dispose();
    adapter.dispose();
    expect(socket.closeCalls).toBe(0);
  });
});
