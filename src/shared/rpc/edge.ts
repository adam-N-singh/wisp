// Typed RPC edges between processes. An edge is a named set of
// request/response methods plus fire-and-forget events. Channels are named
// `rpc/<edge>/call/<method>`, `rpc/<edge>/event/<event>` and `rpc/<edge>/probe`;
// every reply travels in an Envelope.
import type { z } from "zod";

export const FAILURE_UNKNOWN_METHOD = "rpc.unknown-method";
export const FAILURE_TRANSPORT = "rpc.transport-failed";
export const FAILURE_HANDLER = "rpc.handler-failed";
export const FAILURE_INVALID_ARGS = "rpc.invalid-args";

export interface Failure {
  code: string;
  detail: string;
}

export type Envelope<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export interface MethodDecl<A, R> {
  readonly schema: z.ZodType<A> | null;
  /** Phantom marker carrying the result type; never set at runtime. */
  readonly __result?: R;
}

export interface EventDecl<P> {
  readonly __payload?: P;
}

export type MethodMap = Record<string, MethodDecl<any, any>>;
export type EventMap = Record<string, EventDecl<any>>;

export interface EdgeDecl<M extends MethodMap, E extends EventMap> {
  readonly kind: "rpc-edge";
  readonly edge: string;
  readonly methods: M;
  readonly events: E;
}

/** `method<Result>().noArgs` or `method<Result>().args(zodSchema)`. */
export function method<R = void>() {
  return {
    noArgs: { schema: null } as MethodDecl<void, R>,
    args<S extends z.ZodType>(schema: S): MethodDecl<z.infer<S>, R> {
      return { schema: schema as z.ZodType<z.infer<S>> };
    },
  };
}

export function event<P>(): EventDecl<P> {
  return {};
}

export function defineEdge<M extends MethodMap, E extends EventMap = {}>(
  edge: string,
  spec: { methods: M; events?: E },
): EdgeDecl<M, E> {
  return Object.freeze({ kind: "rpc-edge", edge, methods: spec.methods, events: (spec.events ?? {}) as E });
}

export const methodChannel = (edge: string, name: string) => `rpc/${edge}/call/${name}`;
export const eventChannel = (edge: string, name: string) => `rpc/${edge}/event/${name}`;
export const probeChannel = (edge: string) => `rpc/${edge}/probe`;

export class EdgeCallFailure extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(failure: Failure) {
    super(`${failure.code}: ${failure.detail}`);
    this.name = "EdgeCallFailure";
    this.code = failure.code;
    this.detail = failure.detail;
  }
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === "object" && value !== null && "ok" in value && typeof (value as { ok: unknown }).ok === "boolean";
}

type ArgsOf<D> = D extends MethodDecl<infer A, any> ? A : never;
type ResultOf<D> = D extends MethodDecl<any, infer R> ? R : never;
type PayloadOf<D> = D extends EventDecl<infer P> ? P : never;

export type EdgeClient<D extends EdgeDecl<any, any>> = {
  [K in keyof D["methods"]]: [ArgsOf<D["methods"][K]>] extends [void]
    ? () => Promise<ResultOf<D["methods"][K]>>
    : (args: ArgsOf<D["methods"][K]>) => Promise<ResultOf<D["methods"][K]>>;
} & {
  subscribe(handlers: { [K in keyof D["events"]]?: (payload: PayloadOf<D["events"][K]>) => void }): () => void;
};

export type EdgeHandlers<D extends EdgeDecl<any, any>> = {
  [K in keyof D["methods"]]: (
    args: ArgsOf<D["methods"][K]>,
    context: CallContext,
  ) => ResultOf<D["methods"][K]> | Promise<ResultOf<D["methods"][K]>>;
};

export type EdgeEmitter<D extends EdgeDecl<any, any>> = <K extends keyof D["events"] & string>(
  name: K,
  payload: PayloadOf<D["events"][K]>,
) => void;

export interface CallContext {
  /** Opaque identity of the caller (webContents id, port name …) for per-caller state. */
  readonly caller: string;
}
