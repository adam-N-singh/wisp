// A stand-in for the preload's `window.desktop`, for tests of the renderer's stores. Import it before
// anything that imports src/renderer/bridge.ts, which reads `window.desktop` when it loads. Gateway
// calls go to `answer`, which a test sets; events go out through `emit`.
export type Handler = (args: any) => Promise<unknown>;

export const fake = {
  /** What each gateway method answers; a method without one fails. */
  answer: {} as Record<string, Handler>,
  calls: [] as Array<{ method: string; args: unknown }>,
  listeners: {} as Record<string, Array<(payload: any) => void>>,
  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners[channel] ?? []) listener(payload);
  },
};

const gateway = new Proxy(
  {
    subscribe(handlers: Record<string, (payload: any) => void>) {
      for (const [channel, listener] of Object.entries(handlers)) (fake.listeners[channel] ??= []).push(listener);
      return () => undefined;
    },
  } as Record<string, unknown>,
  {
    get(target, method: string) {
      if (method in target) return target[method];
      return (args: unknown) => {
        fake.calls.push({ method, args });
        const answer = fake.answer[method];
        return answer != null ? answer(args) : Promise.reject(new Error(`no answer for ${method}`));
      };
    },
  },
);

const main = new Proxy({} as Record<string, unknown>, {
  // Client persistence and the rest: nothing kept.
  get: () => async () => null,
});

(globalThis as { window?: unknown }).window = { desktop: { gateway, main } };

/** A promise and the means to settle it, for an answer that comes when the test says. */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}
