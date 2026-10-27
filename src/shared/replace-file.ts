// Atomic file replacement: write a temporary file, then rename it over the
// destination. On Windows that rename fails for a moment (EPERM, EACCES or
// EBUSY) while something else briefly holds the destination open, such as
// Defender or the search indexer scanning a file that was just written, so
// those errors are retried for about a second before giving up.
import { renameSync, rmSync } from "node:fs";

const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Waits between attempts, about 1.3 s in all. */
export const REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 150, 250, 250, 250, 250];

/** Renames `temp` over `path`. If it can't, removes `temp` and throws the last rename error. */
export function replaceFileSync(temp: string, path: string, rename: (from: string, to: string) => void = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, path);
      return;
    } catch (error) {
      if (attempt < REPLACE_RETRY_DELAYS_MS.length && TRANSIENT_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
        sleepSync(REPLACE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      try {
        rmSync(temp, { force: true });
      } catch {
        // The rename error is the one worth reporting.
      }
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
