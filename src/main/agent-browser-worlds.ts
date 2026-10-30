// The isolated worlds the agent browser reads pages in (src/main/agent-browser.ts): one per frame,
// by frame id ("" for the page's own document), made on first use. A world goes with its document,
// so a frame that navigates (or goes away) drops its world, and a call that still meets a stale one
// makes it again once. Pure, so it's unit-tested.

/** The world a frame's id names: "" for the page's own document. */
const key = (frameId: string | null) => frameId ?? "";

/** A DevTools event (Page domain) that ends a frame's document drops that frame's world. */
export function forgetFrameWorld(worlds: Map<string, number>, method: string, params: unknown): void {
  const event = (params ?? {}) as { frame?: { id?: string; parentId?: string }; frameId?: string };
  if (method === "Page.frameNavigated" && event.frame?.id != null) {
    worlds.delete(event.frame.id);
    // The page's own document went too (main also clears everything on did-navigate).
    if (event.frame.parentId == null) worlds.delete("");
  } else if (method === "Page.frameDetached" && event.frameId != null) {
    worlds.delete(event.frameId);
  }
}

/** The DevTools protocol's answer for a world that's gone ("Cannot find context with specified id", …). */
export const staleWorld = (error: unknown) => /context/i.test(String(error));

/**
 * Runs `run` in the frame's world: the one `worlds` knows, or one `create` makes. When the world
 * turns out to be stale it's made again, once.
 */
export async function inWorld<T>(worlds: Map<string, number>, frameId: string | null, create: () => Promise<number>, run: (contextId: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let contextId = worlds.get(key(frameId));
    if (contextId == null) {
      contextId = await create();
      worlds.set(key(frameId), contextId);
    }
    try {
      return await run(contextId);
    } catch (error) {
      if (attempt > 0 || !staleWorld(error)) throw error;
      if (worlds.get(key(frameId)) === contextId) worlds.delete(key(frameId));
    }
  }
}
