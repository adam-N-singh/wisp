import assert from "node:assert/strict";
import { test } from "node:test";
import { describeUpdateError, type UpdateEngine, Updater, type UpdaterOptions } from "../../src/main/updater";
import type { UpdateStatus } from "../../src/shared/edges";

/** electron-updater's autoUpdater as the updater sees it: each check runs `next`, which emits what the releases would. */
class FakeEngine implements UpdateEngine {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  next: (engine: FakeEngine) => Promise<unknown> = async () => undefined;
  private listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  }

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return this.next(this);
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

const found = (version: string) => async (engine: FakeEngine) => {
  engine.emit("checking-for-update");
  engine.emit("update-available", { version });
};
const nothingNew = async (engine: FakeEngine) => {
  engine.emit("checking-for-update");
  engine.emit("update-not-available", { version: "1.0.0" });
};

function setup(overrides: Partial<UpdaterOptions> = {}) {
  const engine = new FakeEngine();
  const changes: UpdateStatus[] = [];
  const ready: string[] = [];
  const updater = new Updater({ engine, currentVersion: "1.0.0", automatic: true, onChange: (status) => changes.push(status), onReady: (version) => ready.push(version), now: () => 1_000, ...overrides });
  return { engine, updater, changes, ready };
}

test("a development build has nothing to update: no checks, no install", async () => {
  const changes: UpdateStatus[] = [];
  const updater = new Updater({ engine: null, currentVersion: "1.0.0", automatic: true, onChange: (status) => changes.push(status) });
  assert.equal(updater.get().state, "unsupported");
  assert.equal((await updater.check()).state, "unsupported");
  assert.throws(() => updater.install(), /No update is ready/);
  updater.start();
  assert.equal(updater.setAutomatic(false).automatic, false);
  updater.stop();
});

test("downloads in the background and installs on quit, as electron-updater is told", () => {
  const { engine, updater } = setup();
  assert.equal(engine.autoDownload, true);
  assert.equal(engine.autoInstallOnAppQuit, true);
  assert.deepEqual(updater.get(), { state: "idle", currentVersion: "1.0.0", version: null, percent: null, error: null, checkedAt: null, automatic: true });
});

test("a newer version: checking, downloading with progress, then ready, announced once", async () => {
  const { engine, updater, changes, ready } = setup();
  engine.next = found("1.1.0");
  const afterCheck = await updater.check();
  assert.deepEqual(changes.map((status) => status.state), ["checking", "downloading"]);
  assert.equal(afterCheck.state, "downloading");
  assert.equal(afterCheck.version, "1.1.0");
  assert.equal(afterCheck.checkedAt, 1_000);

  engine.emit("download-progress", { percent: 42.7 });
  assert.equal(updater.get().percent, 42);
  engine.emit("update-downloaded", { version: "1.1.0" });
  assert.equal(updater.get().state, "ready");
  assert.equal(updater.get().percent, null);
  engine.emit("update-downloaded", { version: "1.1.0" });
  assert.deepEqual(ready, ["1.1.0"]);

  updater.install();
  assert.deepEqual(engine.installs, [[true, true]], "silent, and the app starts again");
});

test("nothing newer: up to date, with when it checked", async () => {
  const { engine, updater } = setup();
  engine.next = nothingNew;
  const status = await updater.check();
  assert.equal(status.state, "up-to-date");
  assert.equal(status.checkedAt, 1_000);
  assert.throws(() => updater.install(), /No update is ready/);
  assert.deepEqual(engine.installs, []);
});

test("a failed check says what went wrong in a line, from the event or the rejection", async () => {
  const { engine, updater } = setup();
  engine.next = async (fake) => {
    fake.emit("checking-for-update");
    const error = new Error('HttpError: 404 \n"method: GET url: https://github.com/adam-N-singh/wisp/releases.atom\n\nPlease double check that your authentication token is correct.');
    fake.emit("error", error);
    throw error;
  };
  let status = await updater.check();
  assert.equal(status.state, "error");
  assert.equal(status.error, "No published releases were found on GitHub.");
  assert.equal(status.checkedAt, null);

  // electron-updater normally emits "error" too; a rejection alone still ends the check.
  engine.next = async (fake) => {
    fake.emit("checking-for-update");
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  };
  status = await updater.check();
  assert.equal(status.state, "error");
  assert.equal(status.error, "Couldn't reach GitHub. Check the internet connection.");

  // The next good check clears it.
  engine.next = nothingNew;
  status = await updater.check();
  assert.equal(status.state, "up-to-date");
  assert.equal(status.error, null);
});

test("a ready update stays ready through later checks, failed ones and ones finding the same version", async () => {
  const { engine, updater, changes } = setup();
  engine.next = found("1.1.0");
  await updater.check();
  engine.emit("update-downloaded", { version: "1.1.0" });

  for (const next of [nothingNew, found("1.1.0"), async (fake: FakeEngine) => void fake.emit("error", new Error("ETIMEDOUT"))]) {
    engine.next = next;
    changes.length = 0;
    assert.equal((await updater.check()).state, "ready");
    assert.ok(changes.every((status) => status.state === "ready" && status.version === "1.1.0"), "no flicker to checking or downloading");
  }

  // A newer one replaces it.
  engine.next = found("1.2.0");
  const status = await updater.check();
  assert.equal(status.state, "downloading");
  assert.equal(status.version, "1.2.0");
});

test("one check at a time, and none while a download runs", async () => {
  const { engine, updater } = setup();
  let finish: () => void = () => undefined;
  engine.next = (fake) =>
    new Promise<void>((resolve) => {
      fake.emit("checking-for-update");
      finish = () => {
        fake.emit("update-available", { version: "1.1.0" });
        resolve();
      };
    });
  const first = updater.check();
  const second = updater.check();
  finish();
  await Promise.all([first, second]);
  assert.equal(engine.checks, 1);
  assert.equal(updater.get().state, "downloading");
  await updater.check();
  assert.equal(engine.checks, 1);
});

test("automatic checks: shortly after start, then every interval; off stops them, on starts them again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const { engine, updater } = setup({ firstCheckMs: 30_000, intervalMs: 4 * 3_600_000 });
  engine.next = nothingNew;

  updater.start();
  t.mock.timers.tick(29_999);
  assert.equal(engine.checks, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(engine.checks, 1);
  t.mock.timers.tick(4 * 3_600_000);
  await settle();
  assert.equal(engine.checks, 2);

  updater.setAutomatic(false);
  t.mock.timers.tick(10 * 3_600_000);
  await settle();
  assert.equal(engine.checks, 2);
  assert.equal(updater.get().automatic, false);

  // Back on: the next check is an interval away, as one already ran.
  updater.setAutomatic(true);
  t.mock.timers.tick(4 * 3_600_000);
  await settle();
  assert.equal(engine.checks, 3);
  updater.stop();
  t.mock.timers.tick(10 * 3_600_000);
  await settle();
  assert.equal(engine.checks, 3);
});

test("automatic updates off: start schedules nothing, a check from Settings still runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine, updater } = setup({ automatic: false });
  engine.next = nothingNew;
  updater.start();
  t.mock.timers.tick(24 * 3_600_000);
  assert.equal(engine.checks, 0);
  assert.equal((await updater.check()).state, "up-to-date");
  assert.equal(engine.checks, 1);
});

test("describeUpdateError keeps the first line, short", () => {
  assert.equal(describeUpdateError(new Error("getaddrinfo ENOTFOUND api.github.com")), "Couldn't reach GitHub. Check the internet connection.");
  assert.equal(describeUpdateError(new Error("No published versions on GitHub")), "No published releases were found on GitHub.");
  assert.equal(describeUpdateError(new Error("sha512 checksum mismatch, expected abc\nheaders: …")), "sha512 checksum mismatch, expected abc");
  assert.equal(describeUpdateError(new Error(`x${"y".repeat(300)}`)).length, 200);
  assert.equal(describeUpdateError(""), "The update check failed.");
});
