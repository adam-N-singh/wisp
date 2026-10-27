// UI layout slice `wisp.ui.ui-layout`, schemaVersion 3 (sidebar
// width/collapse, unread filter, info pane open/width/tab). The boot
// snapshot carries it so the first paint is right.
import { desktop } from "../bridge";
import { parseSlice, sliceKey, writeSlice } from "./slices";
import { Store } from "./store";

export type InfoTab = "overview" | "computer" | "automations" | "skills" | "memory";

const INFO_TABS: readonly InfoTab[] = ["overview", "computer", "automations", "skills", "memory"];

export interface UiLayout {
  sidebar: { expandedWidth: number; isCollapsed: boolean };
  isSidebarUnreadOnly: boolean;
  infoPane: { isOpen: boolean; width: number; overviewTab: InfoTab };
  isThreadSideBySideOptIn: boolean;
  threadSideBySideWidth: number | null;
  temperatureScale: null;
}

const KEY = sliceKey("ui-layout", "global");
const SCHEMA = 3;
const DEFAULT: UiLayout = {
  sidebar: { expandedWidth: 280, isCollapsed: false },
  isSidebarUnreadOnly: false,
  infoPane: { isOpen: true, width: 320, overviewTab: "overview" },
  isThreadSideBySideOptIn: false,
  threadSideBySideWidth: null,
  temperatureScale: null,
};

const booted = parseSlice<UiLayout>(desktop.boot.uiLayout, SCHEMA);
export const layout = new Store<UiLayout>(
  booted == null ? DEFAULT : { ...DEFAULT, ...booted, sidebar: { ...DEFAULT.sidebar, ...booted.sidebar }, infoPane: { ...DEFAULT.infoPane, ...booted.infoPane, overviewTab: INFO_TABS.includes(booted.infoPane?.overviewTab as InfoTab) ? booted.infoPane.overviewTab : "overview" } },
);

export function updateLayout(patch: (current: UiLayout) => UiLayout): void {
  layout.set(patch);
  writeSlice(KEY, SCHEMA, layout.get());
}

/** Shows the info pane on this tab. */
export function openInfoTab(tab: InfoTab): void {
  updateLayout((state) => ({ ...state, infoPane: { ...state.infoPane, isOpen: true, overviewTab: tab } }));
}
