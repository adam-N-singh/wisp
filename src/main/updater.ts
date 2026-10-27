// Updates for the installed app. electron-updater reads the releases on GitHub (the `publish`
// block in package.json, written to resources/app-update.yml when the installer is built),
// downloads a newer installer in the background and runs it silently when the app quits, or at
// once from Settings → About or the tray. A development build has no installer to update.
import type { UpdateStatus } from "../shared/edges";

/** The part of electron-updater's autoUpdater this uses (a fake in tests). */
export interface UpdateEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterOptions {
  /** electron-updater's autoUpdater, or null where there's nothing to update (a development build). */
  engine: UpdateEngine | null;
  currentVersion: string;
  automatic: boolean;
  onChange: (status: UpdateStatus) => void;
  /** A newer version finished downloading; called once per version. */
  onReady?: (version: string) => void;
  /** The first automatic check after start, then the time between checks. */
  firstCheckMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

export class Updater {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private checked = false;
  private checking: Promise<void> | null = null;
  private announced: string | null = null;

  constructor(private readonly options: UpdaterOptions) {
    this.status = { state: options.engine == null ? "unsupported" : "idle", currentVersion: options.currentVersion, version: null, percent: null, error: null, checkedAt: null, automatic: options.automatic };
    const engine = options.engine;
    if (engine == null) return;
    engine.autoDownload = true;
    engine.autoInstallOnAppQuit = true;
    // A check while a download waits to install keeps it ready, unless a newer version turns up.
    engine.on("checking-for-update", () => {
      if (this.status.state !== "ready") this.set({ state: "checking", error: null });
    });
    engine.on("update-not-available", () => {
      this.set(this.status.state === "ready" ? { checkedAt: this.now() } : { state: "up-to-date", version: null, percent: null, error: null, checkedAt: this.now() });
    });
    engine.on("update-available", (info: { version: string }) => {
      if (this.status.state === "ready" && info.version === this.status.version) return this.set({ checkedAt: this.now() });
      this.set({ state: "downloading", version: info.version, percent: 0, error: null, checkedAt: this.now() });
    });
    engine.on("download-progress", (progress: { percent: number }) => {
      if (this.status.state === "downloading") this.set({ percent: Math.floor(progress.percent) });
    });
    engine.on("update-downloaded", (info: { version: string }) => {
      this.set({ state: "ready", version: info.version, percent: null, error: null });
      if (this.announced === info.version) return;
      this.announced = info.version;
      options.onReady?.(info.version);
    });
    engine.on("error", (error: unknown) => {
      if (this.status.state !== "ready") this.set({ state: "error", percent: null, error: describeUpdateError(error) });
    });
  }

  get(): UpdateStatus {
    return this.status;
  }

  /** Starts the automatic checks, when they're on. */
  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  setAutomatic(enabled: boolean): UpdateStatus {
    this.set({ automatic: enabled });
    this.schedule();
    return this.status;
  }

  /** Checks now; resolves once the releases answer, while a newer version downloads in the background. */
  async check(): Promise<UpdateStatus> {
    const engine = this.options.engine;
    if (engine == null || this.status.state === "downloading") return this.status;
    this.checking ??= engine
      .checkForUpdates()
      .then(
        () => undefined,
        (error: unknown) => {
          if (this.status.state === "checking") this.set({ state: "error", error: describeUpdateError(error) });
        },
      )
      .finally(() => {
        this.checking = null;
      });
    await this.checking;
    return this.status;
  }

  /** Quits, installs the downloaded version silently and starts the app again. */
  install(): void {
    if (this.options.engine == null || this.status.state !== "ready") throw new Error("No update is ready to install yet.");
    this.options.engine.quitAndInstall(true, true);
  }

  private schedule(): void {
    this.stop();
    if (this.options.engine == null || !this.status.automatic) return;
    const delay = this.checked ? (this.options.intervalMs ?? CHECK_INTERVAL_MS) : (this.options.firstCheckMs ?? FIRST_CHECK_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checked = true;
      void this.check().finally(() => {
        if (this.timer == null) this.schedule();
      });
    }, delay);
    this.timer.unref?.();
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onChange(this.status);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** electron-updater's messages carry the request and its headers; this says what went wrong in a line. */
export function describeUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(text)) return "Couldn't reach GitHub. Check the internet connection.";
  if (/\b404\b|No published versions/i.test(text)) return "No published releases were found on GitHub.";
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "The update check failed.";
}
