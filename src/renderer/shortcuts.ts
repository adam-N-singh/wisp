// Keyboard shortcuts. The table below is what the Ctrl+/ dialog lists; `onShortcutKeyDown` handles the app's own ones. "Mod"
// is Ctrl, or ⌘ on macOS. None of them clash with Windows, Electron's default menu (Ctrl+W, Ctrl+M,
// Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I, Ctrl+0/+/−, F11, editing keys) or the desktop mount's
// Alt+Shift+Space.
import { desktop } from "./bridge";
import { focusComposer } from "./components/Composer";
import { app, closeSettings, openConnectApps, openDialog, openSettings, type PaletteMode } from "./store/app";
import { closeFind, find, openFind } from "./store/find";
import { openInfoTab, updateLayout } from "./store/layout";
import { cancelCycle, cycle, cycleAgents, finishCycle, openAgentAt, stepAgent } from "./store/navigation";
import { stage, stageBack } from "./store/pages";

export const IS_MAC = desktop.environment.platform === "darwin";
const MOD = IS_MAC ? "⌘" : "Ctrl";
export const MOD_LABEL = MOD;
const ALT = IS_MAC ? "⌥" : "Alt";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const CTRL = IS_MAC ? "⌃" : "Ctrl";

export type ShortcutSection = "Essentials" | "Chat" | "Navigation" | "Panels" | "Window";
export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = ["Essentials", "Chat", "Navigation", "Panels", "Window"];

export interface ShortcutInfo {
  id: string;
  section: ShortcutSection;
  label: string;
  /** Alternative key combinations, each a list of keys. */
  keys: string[][];
}

export const SHORTCUTS: readonly ShortcutInfo[] = [
  { id: "commandPalette", section: "Essentials", label: "Jump to an agent, action or message", keys: [[MOD, "K"]] },
  { id: "focusSearch", section: "Essentials", label: "Search agents and messages", keys: [[MOD, SHIFT, "F"]] },
  { id: "newAgent", section: "Essentials", label: "New agent", keys: [[MOD, "N"]] },
  { id: "newGroupChat", section: "Essentials", label: "New group chat", keys: [[MOD, SHIFT, "N"]] },
  { id: "openSettings", section: "Essentials", label: "Settings", keys: [[MOD, ","]] },
  { id: "keyboardShortcuts", section: "Essentials", label: "Keyboard shortcuts", keys: [[MOD, "/"]] },
  { id: "findInChat", section: "Chat", label: "Find in chat", keys: [[MOD, "F"]] },
  { id: "findStep", section: "Chat", label: "Older or newer match, in the find bar", keys: [["Enter"], [SHIFT, "Enter"]] },
  { id: "focusInput", section: "Chat", label: "Go to the message box", keys: [[MOD, "I"]] },
  { id: "send", section: "Chat", label: "Send the message", keys: [["Enter"]] },
  { id: "newLine", section: "Chat", label: "New line", keys: [[SHIFT, "Enter"]] },
  { id: "skillMenu", section: "Chat", label: "Run a skill, typed first in the message box", keys: [["/"]] },
  { id: "dictate", section: "Chat", label: "Dictate: press to start and again to stop, or hold to talk", keys: [[MOD, "D"]] },
  { id: "dismiss", section: "Chat", label: "Cancel dictation or a voice memo, close the find bar, a menu or a dialog", keys: [["Esc"]] },
  { id: "pageBack", section: "Panels", label: "Leave a page’s editor, then close the page", keys: [["Esc"]] },
  { id: "pageSave", section: "Panels", label: "Save the page, in its editor", keys: [[MOD, "S"]] },
  { id: "previousNextAgent", section: "Navigation", label: "Previous or next agent", keys: [[ALT, "↑"], [ALT, "↓"]] },
  { id: "focusAgent", section: "Navigation", label: "Agent 1 to 9 in the sidebar", keys: [[MOD, "1–9"]] },
  { id: "cycleAgents", section: "Navigation", label: `Cycle through agents, then let go of ${CTRL} to open one`, keys: [[CTRL, "Tab"], [CTRL, SHIFT, "Tab"]] },
  { id: "toggleSidebar", section: "Panels", label: "Show or hide the sidebar", keys: [[MOD, "B"]] },
  { id: "toggleInfo", section: "Panels", label: "Show or hide the details pane", keys: [[MOD, ALT, "B"]] },
  { id: "agentSettings", section: "Panels", label: "Edit the agent", keys: [[MOD, SHIFT, ","]] },
  { id: "openSkills", section: "Panels", label: "The agent’s skills", keys: [[MOD, SHIFT, "W"]] },
  { id: "openTools", section: "Panels", label: "Connect Apps", keys: [[MOD, SHIFT, "M"]] },
  { id: "windowClose", section: "Window", label: "Close the window (agents keep running in the tray)", keys: [[MOD, "W"]] },
  { id: "minimize", section: "Window", label: "Minimize", keys: [[MOD, "M"]] },
  { id: "fullScreen", section: "Window", label: "Full screen", keys: [IS_MAC ? [CTRL, MOD, "F"] : ["F11"]] },
  { id: "zoom", section: "Window", label: "Zoom in, zoom out, actual size", keys: [[MOD, "+"], [MOD, "−"], [MOD, "0"]] },
  { id: "capture", section: "Window", label: "Capture part of the screen for the agent on your desktop", keys: [[ALT, SHIFT, "Space"]] },
];

export function openPalette(mode: PaletteMode): void {
  openDialog({ kind: "palette", mode });
}

/** The letter or digit a key press means: the typed one on Latin layouts, else the physical key (so Ctrl+K works on a Cyrillic layout). */
export function shortcutKey(event: KeyboardEvent): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (/^[a-z0-9]$/.test(key)) return key;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  return key;
}

export const isModKey = (event: { ctrlKey: boolean; metaKey: boolean }) => (IS_MAC ? event.metaKey : event.ctrlKey);

/** A dialog (the palette, the agent editor…) handles its own keys. */
const dialogOpen = () => document.querySelector("dialog[open]") != null;

const togglePanel = (panel: "sidebar" | "infoPane") =>
  updateLayout((state) => (panel === "sidebar" ? { ...state, sidebar: { ...state.sidebar, isCollapsed: !state.sidebar.isCollapsed } } : { ...state, infoPane: { ...state.infoPane, isOpen: !state.infoPane.isOpen } }));

export function onShortcutKeyDown(event: KeyboardEvent): void {
  // A key pressed without Ctrl means Ctrl went up while Ctrl+Tab was cycling, even if that key-up was missed.
  if (cycle.get() != null && !event.ctrlKey) finishCycle();
  if (event.defaultPrevented || event.isComposing) return;
  const key = shortcutKey(event);

  // Ctrl+Tab is Ctrl on macOS too (⌘Tab switches apps).
  if (event.key === "Tab" && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (dialogOpen()) return;
    event.preventDefault();
    cycleAgents(event.shiftKey ? -1 : 1);
    return;
  }
  if (dialogOpen()) return;

  if (event.key === "Escape") {
    if (cycle.get() != null) {
      event.preventDefault();
      cancelCycle();
    } else if (find.get().agentId != null) {
      event.preventDefault();
      closeFind();
    } else if (stage.get().open != null && app.get().view === "chat") {
      event.preventDefault();
      stageBack();
    }
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    if (event.target instanceof HTMLSelectElement) return; // Alt+Down opens a list
    event.preventDefault();
    stepAgent(event.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if (!isModKey(event)) return;
  // AltGr reaches us as Ctrl+Alt on Windows: let it type its character.
  if (!IS_MAC && event.altKey && event.getModifierState("AltGraph") && event.key.length === 1 && !/^[a-z0-9]$/i.test(event.key)) return;
  const { agentId, view } = app.get();
  const plain = !event.shiftKey && !event.altKey;
  const handled = (run: () => void) => {
    event.preventDefault();
    run();
  };

  if (plain && /^[1-9]$/.test(key)) {
    if (openAgentAt(Number(key))) event.preventDefault();
  } else if (plain && key === "k") handled(() => openPalette("jump"));
  else if (event.shiftKey && !event.altKey && key === "f") handled(() => openPalette("search"));
  else if (plain && key === "f") {
    if (view === "chat" && agentId != null) handled(() => openFind(agentId));
  } else if (plain && key === "n") handled(() => openDialog({ kind: "new-agent" }));
  else if (event.shiftKey && !event.altKey && key === "n") handled(() => openDialog({ kind: "new-group" }));
  else if (!event.altKey && (event.key === "," || event.code === "Comma")) {
    if (!event.shiftKey) handled(() => openSettings());
    else if (agentId != null) handled(() => openDialog({ kind: "edit-agent", agentId }));
  } else if (!event.altKey && (event.key === "/" || event.key === "?")) handled(() => openDialog({ kind: "shortcuts" }));
  else if (plain && key === "i") {
    if (agentId != null)
      handled(() => {
        // From settings, the conversation renders first.
        closeSettings();
        setTimeout(focusComposer, 0);
      });
  } else if (event.altKey && !event.shiftKey && key === "b") handled(() => togglePanel("infoPane"));
  else if (plain && key === "b") handled(() => togglePanel("sidebar"));
  else if (event.shiftKey && !event.altKey && key === "w") {
    // The agent's skills.
    handled(() => {
      closeSettings();
      openInfoTab("skills");
    });
  } else if (event.shiftKey && !event.altKey && key === "m") handled(() => openConnectApps());
}

/** Letting go of Ctrl opens the agent Ctrl+Tab moved to. */
export function onShortcutKeyUp(event: KeyboardEvent | PointerEvent): void {
  if (cycle.get() != null && (!event.ctrlKey || ("key" in event && event.key === "Control"))) finishCycle();
}
