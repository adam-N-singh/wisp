// OS notifications for agent activity. Suppressed when the user is already
// looking at that agent in a focused window, or (by preference) whenever the
// app is focused. Also one when an update has downloaded.
import { join } from "node:path";
import { Notification } from "electron";
import type { NotificationPreferences } from "../shared/edges";

export interface Activity {
  agentId: string;
  name: string;
  kind: "finished" | "needs-approval" | "question" | "error";
  preview: string;
}

const HEADLINE: Record<Activity["kind"], string> = {
  finished: "",
  "needs-approval": "Needs your approval: ",
  question: "Has a question: ",
  error: "Ran into a problem: ",
};

export function notifyActivity(
  activity: Activity,
  context: { prefs: NotificationPreferences; windowFocused: boolean; viewingAgentId: string | null; assetsDir: string; onClick: (agentId: string) => void },
): void {
  if (!context.prefs.enabled || !Notification.isSupported()) return;
  const viewing = context.windowFocused && context.viewingAgentId === activity.agentId;
  if (viewing) return;
  if (context.prefs.onlyWhenUnfocused && context.windowFocused) return;
  const notification = new Notification({
    title: activity.name,
    body: `${HEADLINE[activity.kind]}${activity.preview}`.slice(0, 240),
    silent: !context.prefs.sound,
    icon: join(context.assetsDir, "app-icon.png"),
  });
  notification.on("click", () => context.onClick(activity.agentId));
  notification.show();
}

/** Once per downloaded version; the app lives in the tray, so it may not quit (and install) for a while. */
export function notifyUpdateReady(version: string, context: { prefs: NotificationPreferences; assetsDir: string; onClick: () => void }): void {
  if (!context.prefs.enabled || !Notification.isSupported()) return;
  const notification = new Notification({
    title: `Wisp ${version} is ready`,
    body: "It installs the next time Wisp quits. Click to see it in Settings and restart now.",
    silent: !context.prefs.sound,
    icon: join(context.assetsDir, "app-icon.png"),
  });
  notification.on("click", context.onClick);
  notification.show();
}
