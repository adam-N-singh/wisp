import type { ClientTransport, ServerTransport } from "./runtime";

// ---------------------------------------------------------------------------
// Electron IPC (renderer -> main). Structural types keep this file free of an
// electron import so it can be bundled into any process.

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  off(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export function ipcClientTransport(ipc: IpcRendererLike): ClientTransport {
  return {
    invoke: (channel, payload) => ipc.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload);
      ipc.on(channel, wrapped);
      return () => {
        ipc.off(channel, wrapped);
      };
    },
  };
}

export interface IpcEventLike {
  sender: { id: number };
  senderFrame?: unknown;
}

export interface IpcMainLike {
  handle(channel: string, handler: (event: IpcEventLike, payload: unknown) => unknown): void;
}

export interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

/**
 * Serve an edge on ipcMain. `accept` gates every call by sender (main accepts
 * main-edge calls only from the main window's top frame).
 */
export function ipcServerTransport(ipc: IpcMainLike, targets: () => Iterable<WebContentsLike>, accept: (event: IpcEventLike) => boolean = () => true): ServerTransport {
  return {
    handle: (channel, handler) =>
      ipc.handle(channel, (event, payload) =>
        accept(event) ? handler(payload, `webContents:${event.sender.id}`) : { ok: false, failure: { code: "rpc.untrusted-sender", detail: `${channel} refused for this sender` } },
      ),
    emit: (channel, payload) => {
      for (const target of targets()) {
        if (!target.isDestroyed()) target.send(channel, payload);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MessagePort peers. One port carries both directions: either side may serve
// methods and call the other. Frames:
//   {d:1,k:"q",id,ch,p}  request      {d:1,k:"s",id,r}  response
//   {d:1,k:"e",ch,p}     event        {d:1,k:"x"}       close notice

export interface PortLike {
  post(data: unknown): void;
  onMessage(listener: (data: unknown) => void): () => void;
  onClose?(listener: () => void): void;
  close?(): void;
}

type Frame =
  | { d: 1; k: "q"; id: number; ch: string; p: unknown }
  | { d: 1; k: "s"; id: number; r: unknown }
  | { d: 1; k: "e"; ch: string; p: unknown }
  | { d: 1; k: "x" };

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && (value as { d?: unknown }).d === 1 && typeof (value as { k?: unknown }).k === "string";
}

export interface PortPeer {
  client: ClientTransport;
  server: ServerTransport;
  readonly closed: Promise<void>;
  close(): void;
}

export function createPortPeer(port: PortLike, name: string): PortPeer {
  let nextId = 1;
  let isClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const handlers = new Map<string, (payload: unknown, caller: string) => Promise<unknown>>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const markClosed = () => {
    if (isClosed) return;
    isClosed = true;
    for (const { reject } of pending.values()) reject(new Error(`port ${name} closed`));
    pending.clear();
    resolveClosed();
  };

  const post = (frame: Frame) => {
    if (isClosed) throw new Error(`port ${name} closed`);
    port.post(frame);
  };

  port.onMessage(async (data) => {
    if (!isFrame(data)) return;
    switch (data.k) {
      case "q": {
        const handler = handlers.get(data.ch);
        let reply: unknown;
        if (handler == null) {
          reply = { ok: false, failure: { code: "rpc.unknown-method", detail: `${name}: no handler for ${data.ch}` } };
        } else {
          try {
            reply = await handler(data.p, name);
          } catch (error) {
            reply = { ok: false, failure: { code: "rpc.handler-failed", detail: error instanceof Error ? error.message : String(error) } };
          }
        }
        if (!isClosed) post({ d: 1, k: "s", id: data.id, r: reply });
        return;
      }
      case "s": {
        const waiter = pending.get(data.id);
        pending.delete(data.id);
        waiter?.resolve(data.r);
        return;
      }
      case "e": {
        for (const listener of listeners.get(data.ch) ?? []) listener(data.p);
        return;
      }
      case "x":
        markClosed();
        return;
    }
  });
  port.onClose?.(markClosed);

  return {
    closed,
    client: {
      invoke(channel, payload) {
        return new Promise((resolve, reject) => {
          if (isClosed) return reject(new Error(`port ${name} closed`));
          const id = nextId++;
          pending.set(id, { resolve, reject });
          try {
            post({ d: 1, k: "q", id, ch: channel, p: payload });
          } catch (error) {
            pending.delete(id);
            reject(error as Error);
          }
        });
      },
      on(channel, listener) {
        let set = listeners.get(channel);
        if (set == null) listeners.set(channel, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
      },
    },
    server: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      emit(channel, payload) {
        if (!isClosed) post({ d: 1, k: "e", ch: channel, p: payload });
      },
    },
    close() {
      if (isClosed) return;
      try {
        port.post({ d: 1, k: "x" } satisfies Frame);
      } catch {
        // already gone
      }
      port.close?.();
      markClosed();
    },
  };
}

/** Adapter for a DOM MessagePort (renderer, web workers). */
export function domPort(port: MessagePort): PortLike {
  return {
    post: (data) => port.postMessage(data),
    onMessage: (listener) => {
      const wrapped = (event: MessageEvent) => listener(event.data);
      port.addEventListener("message", wrapped);
      port.start();
      return () => port.removeEventListener("message", wrapped);
    },
    close: () => port.close(),
  };
}

/** Adapter for Electron's MessagePortMain (main process and utility processes). */
export interface MessagePortMainLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

export function mainPort(port: MessagePortMainLike): PortLike {
  return {
    post: (data) => port.postMessage(data),
    onMessage: (listener) => {
      const wrapped = (event: { data: unknown }) => listener(event.data);
      port.on("message", wrapped);
      port.start();
      return () => port.off("message", wrapped);
    },
    onClose: (listener) => {
      port.on("close", listener);
    },
    close: () => port.close(),
  };
}
