// Client persistence slices, stored by main under the keys `wisp.ui.<name>`
// and `wisp.ui.account.<account>.<name>`, each value a JSON envelope
// `{schemaVersion, value}`. Writes are debounced per key.
import { main } from "../bridge";

const ACCOUNT = "local";
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const sliceKey = (name: string, scope: "global" | "account" = "account") =>
  scope === "global" ? `wisp.ui.${name}` : `wisp.ui.account.${ACCOUNT}.${name}`;

export function parseSlice<T>(raw: string | null, schemaVersion: number): T | null {
  if (raw == null) return null;
  try {
    const envelope = JSON.parse(raw) as { schemaVersion?: number; value?: T };
    return envelope.schemaVersion === schemaVersion && envelope.value !== undefined ? envelope.value : null;
  } catch {
    return null;
  }
}

export async function readSlice<T>(key: string, schemaVersion: number): Promise<T | null> {
  try {
    return parseSlice<T>(await main.loadUiState({ key }), schemaVersion);
  } catch {
    return null;
  }
}

export function writeSlice<T>(key: string, schemaVersion: number, value: T, delayMs = 400): void {
  const existing = timers.get(key);
  if (existing != null) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void main.saveUiState({ key, value: JSON.stringify({ schemaVersion, value }) }).catch(() => undefined);
    }, delayMs),
  );
}

/** Removes a slice, and any write of it still waiting. */
export function removeSlice(key: string): void {
  const pending = timers.get(key);
  if (pending != null) clearTimeout(pending);
  timers.delete(key);
  void main.deleteUiState({ key }).catch(() => undefined);
}

/** Every slice whose name starts with `prefix` that parses at this schema version. */
export async function readSlices<T>(prefix: string, schemaVersion: number): Promise<T[]> {
  try {
    const found = await main.loadUiStates({ include: [sliceKey(prefix)], exclude: [] });
    return Object.values(found).flatMap((raw) => parseSlice<T>(raw, schemaVersion) ?? []);
  } catch {
    return [];
  }
}
