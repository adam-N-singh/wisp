import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { REPLACE_RETRY_DELAYS_MS, replaceFileSync } from "../../src/shared/replace-file";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

/** A destination holding "old" and a temporary file holding "new" beside it. */
function files(): { temp: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "wisp-replace-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "a1.json");
  writeFileSync(path, "old");
  writeFileSync(`${path}.tmp`, "new");
  return { temp: `${path}.tmp`, path };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code });
}

test("replaceFileSync retries a rename Windows briefly refuses, then replaces the file", () => {
  const { temp, path } = files();
  const codes = ["EPERM", "EACCES", "EBUSY"];
  let attempts = 0;
  replaceFileSync(temp, path, (from, to) => {
    const code = codes[attempts++];
    if (code) throw errno(code);
    renameSync(from, to);
  });
  assert.equal(attempts, 4);
  assert.equal(readFileSync(path, "utf8"), "new");
  assert.equal(existsSync(temp), false);
});

test("replaceFileSync gives up after about a second, rethrows the rename error and removes the temporary file", () => {
  const { temp, path } = files();
  const thrown: Error[] = [];
  const started = Date.now();
  assert.throws(
    () =>
      replaceFileSync(temp, path, () => {
        thrown.push(errno("EPERM"));
        throw thrown.at(-1);
      }),
    (error) => error === thrown.at(-1),
  );
  const elapsed = Date.now() - started;
  assert.equal(thrown.length, REPLACE_RETRY_DELAYS_MS.length + 1);
  assert.ok(elapsed >= 1000 && elapsed < 3000, `gave up after ${elapsed} ms`);
  assert.equal(readFileSync(path, "utf8"), "old");
  assert.equal(existsSync(temp), false);
});

test("replaceFileSync doesn't retry other errors", () => {
  const { temp, path } = files();
  let attempts = 0;
  assert.throws(
    () =>
      replaceFileSync(temp, path, () => {
        attempts++;
        throw errno("EXDEV");
      }),
    { code: "EXDEV" },
  );
  assert.equal(attempts, 1);
  assert.equal(readFileSync(path, "utf8"), "old");
  assert.equal(existsSync(temp), false);
});
