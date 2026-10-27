import {
  type CallContext,
  type EdgeClient,
  type EdgeDecl,
  type EdgeEmitter,
  type EdgeHandlers,
  type Envelope,
  EdgeCallFailure,
  FAILURE_HANDLER,
  FAILURE_INVALID_ARGS,
  FAILURE_TRANSPORT,
  FAILURE_UNKNOWN_METHOD,
  eventChannel,
  isEnvelope,
  methodChannel,
  probeChannel,
} from "./edge";

/** What a client needs from a transport: request/response plus event listening. */
export interface ClientTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** What a server needs: register a request handler per channel and broadcast events. */
export interface ServerTransport {
  handle(channel: string, handler: (payload: unknown, caller: string) => Promise<unknown>): void;
  emit(channel: string, payload: unknown): void;
}

export function createEdgeClient<D extends EdgeDecl<any, any>>(edge: D, transport: ClientTransport): EdgeClient<D> {
  const client: Record<string, unknown> = {};

  // A failed invoke is ambiguous (dead transport vs. a method the far side does not
  // know). The probe disambiguates.
  const explain = async (name: string, error: unknown): Promise<EdgeCallFailure> => {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      const probe = await transport.invoke(probeChannel(edge.edge), name);
      if (isEnvelope(probe) && !probe.ok && probe.failure.code === FAILURE_UNKNOWN_METHOD) {
        return new EdgeCallFailure(probe.failure);
      }
    } catch {
      // fall through to the transport failure
    }
    return new EdgeCallFailure({ code: FAILURE_TRANSPORT, detail });
  };

  for (const name of Object.keys(edge.methods)) {
    client[name] = async (args?: unknown) => {
      let reply: unknown;
      try {
        reply = await transport.invoke(methodChannel(edge.edge, name), args ?? {});
      } catch (error) {
        throw await explain(name, error);
      }
      if (!isEnvelope(reply)) {
        throw new EdgeCallFailure({ code: FAILURE_HANDLER, detail: "The reply wasn't an RPC envelope." });
      }
      if (reply.ok) return reply.value;
      throw new EdgeCallFailure(reply.failure);
    };
  }

  client.subscribe = (handlers: Record<string, ((payload: unknown) => void) | undefined>) => {
    const offs: Array<() => void> = [];
    for (const [name, handler] of Object.entries(handlers)) {
      if (handler != null) offs.push(transport.on(eventChannel(edge.edge, name), handler));
    }
    return () => offs.forEach((off) => off());
  };

  return client as EdgeClient<D>;
}

export interface ServeOptions {
  /** Called with every handler failure, for logging. */
  onError?: (method: string, error: unknown) => void;
}

export function serveEdge<D extends EdgeDecl<any, any>>(
  edge: D,
  handlers: EdgeHandlers<D>,
  transport: ServerTransport,
  options: ServeOptions = {},
): EdgeEmitter<D> {
  const known = new Set(Object.keys(edge.methods));

  transport.handle(probeChannel(edge.edge), async (payload) => {
    const name = typeof payload === "string" ? payload : "";
    return known.has(name)
      ? ({ ok: true, value: true } satisfies Envelope<boolean>)
      : ({ ok: false, failure: { code: FAILURE_UNKNOWN_METHOD, detail: `${edge.edge} has no method ${name}` } } satisfies Envelope<never>);
  });

  for (const name of known) {
    const decl = edge.methods[name];
    const handler = (handlers as Record<string, (args: unknown, ctx: CallContext) => unknown>)[name];
    transport.handle(methodChannel(edge.edge, name), async (payload, caller): Promise<Envelope<unknown>> => {
      let args: unknown = payload;
      if (decl.schema != null) {
        const parsed = decl.schema.safeParse(payload);
        if (!parsed.success) {
          return { ok: false, failure: { code: FAILURE_INVALID_ARGS, detail: `${name}: ${parsed.error.message}` } };
        }
        args = parsed.data;
      }
      if (handler == null) {
        return { ok: false, failure: { code: FAILURE_UNKNOWN_METHOD, detail: `${edge.edge}.${name} is not implemented` } };
      }
      try {
        return { ok: true, value: await handler(args, { caller }) };
      } catch (error) {
        options.onError?.(name, error);
        if (error instanceof EdgeCallFailure) return { ok: false, failure: { code: error.code, detail: error.detail } };
        return { ok: false, failure: { code: FAILURE_HANDLER, detail: error instanceof Error ? error.message : String(error) } };
      }
    });
  }

  return ((name: string, payload: unknown) => transport.emit(eventChannel(edge.edge, name), payload)) as EdgeEmitter<D>;
}
