// Typed access to what the preload exposes on `window.desktop`.
import type { EdgeClient } from "../shared/rpc/edge";
import type { gatewayEdge, mainEdge, ThemeState } from "../shared/edges";
import type { ModelSettings } from "../shared/model";
import type { StagedAttachment } from "../shared/edges";

export interface BootSnapshot {
  mainEdge: "served";
  theme: ThemeState;
  platform: NodeJS.Platform;
  appVersion: string;
  uiLayout: string | null;
  onboardingSeen: boolean;
  model: ModelSettings;
}

interface DesktopBridge {
  main: EdgeClient<typeof mainEdge>;
  gateway: EdgeClient<typeof gatewayEdge>;
  boot: BootSnapshot;
  environment: { platform: NodeJS.Platform; isDev: boolean };
  local: {
    stageAttachmentFile(file: File, filename?: string): Promise<StagedAttachment>;
    mediaUrl(path: string): string;
    /** Where a visualization's document is served (main's `wisp-visualization://`), in the app's theme. */
    visualizationUrl(path: string, theme: "light" | "dark"): string;
  };
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}

export const desktop = window.desktop;
export const main = desktop.main;
export const gateway = desktop.gateway;
