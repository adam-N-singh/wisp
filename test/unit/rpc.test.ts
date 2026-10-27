import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineEdge, EdgeCallFailure, event, method, methodChannel } from "../../src/shared/rpc/edge";
import { createEdgeClient, serveEdge, type ClientTransport, type ServerTransport } from "../../src/shared/rpc/runtime";
import { createPortPeer, type PortLike } from "../../src/shared/rpc/transports";

const edge = defineEdge("demo", {
  methods: {
    add: method<number>().args(z.object({ a: z.number(), b: z.number() })),
    boom: method<void>().noArgs,
    ping: method<string>().noArgs,
  },
  events: { tick: event<{ n: number }>() },
});

function memoryPair(): { client: ClientTransport; server: ServerTransport } {
  const handlers = new Map<string, (payload: unknown, caller: string) => Promise<unknown>>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    server: {
      handle: (channel, handler) => handlers.set(channel, handler),
      emit: (channel, payload) => listeners.get(channel)?.forEach((listener) => listener(payload)),
    },
    client: {
      invoke: async (channel, payload) => {
        const handler = handlers.get(channel);
        if (handler == null) throw new Error(`No handler registered for '${channel}'`);
        return handler(structuredClone(payload), "test");
      },
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set();
        listeners.set(channel, set);
        set.add(listener);
        return () => set.delete(listener);
      },
    },
  };
}

test("channel naming", () => {
  assert.equal(methodChannel("main", "themeInfo"), "rpc/main/call/themeInfo");
});

test("calls, validation failures, handler failures and events", async () => {
  const { client: clientTransport, server } = memoryPair();
  const emit = serveEdge(edge, { add: ({ a, b }) => a + b, boom: () => Promise.reject(new Error("kaput")), ping: () => "pong" }, server);
  const client = createEdgeClient(edge, clientTransport);
  assert.equal(await client.add({ a: 2, b: 3 }), 5);
  assert.equal(await client.ping(), "pong");
  await assert.rejects(client.add({ a: 2, b: "x" } as never), (error: unknown) => error instanceof EdgeCallFailure && error.code === "rpc.invalid-args");
  await assert.rejects(client.boom(), (error: unknown) => error instanceof EdgeCallFailure && error.code === "rpc.handler-failed" && error.detail === "kaput");
  const ticks: number[] = [];
  const off = client.subscribe({ tick: ({ n }) => ticks.push(n) });
  emit("tick", { n: 1 });
  off();
  emit("tick", { n: 2 });
  assert.deepEqual(ticks, [1]);
});

test("an unregistered method is reported as unknown via the probe", async () => {
  const { client: clientTransport, server } = memoryPair();
  const partial = defineEdge("demo", { methods: { ping: method<string>().noArgs } });
  serveEdge(partial, { ping: () => "pong" }, server);
  const client = createEdgeClient(edge, clientTransport);
  await assert.rejects(client.add({ a: 1, b: 1 }), (error: unknown) => error instanceof EdgeCallFailure && error.code === "rpc.unknown-method");
});

function portPair(): [PortLike, PortLike] {
  const make = () => ({ listeners: new Set<(data: unknown) => void>(), closers: new Set<() => void>() });
  const a = make();
  const b = make();
  const port = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): PortLike => ({
    post: (data) => queueMicrotask(() => other.listeners.forEach((listener) => listener(structuredClone(data)))),
    onMessage: (listener) => {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    onClose: (listener) => self.closers.add(listener),
    close: () => other.closers.forEach((listener) => listener()),
  });
  return [port(a, b), port(b, a)];
}

test("MessagePort peers carry requests both ways and fail pending calls on close", async () => {
  const [left, right] = portPair();
  const server = createPortPeer(left, "server");
  const caller = createPortPeer(right, "caller");
  serveEdge(edge, { add: ({ a, b }) => a * 10 + b, boom: () => new Promise(() => undefined), ping: () => "pong" }, server.server);
  const client = createEdgeClient(edge, caller.client);
  assert.equal(await client.add({ a: 4, b: 2 }), 42);
  const hanging = client.boom();
  server.close();
  await assert.rejects(hanging, (error: unknown) => error instanceof EdgeCallFailure);
});
