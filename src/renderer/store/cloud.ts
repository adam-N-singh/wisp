// Cloud computer: its settings (main) and live status (the box, via the gateway).
import type { CloudComputerStatus, CloudSettings } from "../../shared/model";
import { gateway, main } from "../bridge";
import { Store } from "./store";

export const cloudSettings = new Store<CloudSettings | null>(null);
export const cloudStatus = new Store<CloudComputerStatus | null>(null);

let started = false;
export function startCloud(): void {
  if (started) return;
  started = true;
  main.subscribe({ "cloud-settings-changed": (next) => cloudSettings.set(next) });
  gateway.subscribe({ "cloud-computer": (next) => cloudStatus.set(next) });
  void main.getCloudSettings().then((next) => cloudSettings.set(next));
  void refreshCloudStatus();
}

export async function refreshCloudStatus(): Promise<void> {
  try {
    cloudStatus.set(await gateway.getCloudComputer({}));
  } catch {
    // box restarting; the next event updates it
  }
}

/** Runs a lifecycle action; "viewer" opens the desktop view. Errors come back as messages. */
export async function cloudAction(action: "start" | "pause" | "delete" | "viewer"): Promise<string | null> {
  try {
    const result = await gateway.cloudComputerAction({ action });
    cloudStatus.set(result.status);
    if (result.viewerUrl != null) await main.openCloudDesktop({ url: result.viewerUrl });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error);
  }
}
