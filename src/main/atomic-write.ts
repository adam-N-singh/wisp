import { randomInt } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

// Write a sibling temp file `<target>.<random u32>`, fsync it, then rename
// over the target, so readers never observe a torn file. Writers to one path
// are serialized.
const queues = new Map<string, Promise<void>>();

export async function writeFileAtomic(target: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const previous = queues.get(target) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeNow(target, data, mode));
  queues.set(target, next);
  try {
    await next;
  } finally {
    if (queues.get(target) === next) queues.delete(target);
  }
}

async function writeNow(target: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomInt(2 ** 32 - 1)}`;
  const handle = await open(temp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
