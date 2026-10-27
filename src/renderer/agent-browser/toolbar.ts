// The agent browser's toolbar: who drives (the agent, or the user while the agent waits), Take
// over / Hand back, the address and the tabs. Navigation and tabs work only while the user has
// the browser; while the agent asks for something (browser_wait_for_user) it says what, and points
// to the chat, where the user answers.
import type { EdgeClient } from "../../shared/rpc/edge";
import type { agentBrowserToolbarEdge, AgentBrowserToolbarView } from "../../shared/edges";
import "./toolbar.css";

declare global {
  interface Window {
    agentBrowserToolbar: EdgeClient<typeof agentBrowserToolbarEdge>;
  }
}

const toolbar = window.agentBrowserToolbar;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const back = $<HTMLButtonElement>("back");
const forward = $<HTMLButtonElement>("forward");
const reload = $<HTMLButtonElement>("reload");
const address = $<HTMLInputElement>("address");
const status = $<HTMLSpanElement>("status");
const chat = $<HTMLButtonElement>("chat");
const control = $<HTMLButtonElement>("control");
const tabs = $<HTMLDivElement>("tabs");

let view: AgentBrowserToolbarView | null = null;
let editing = false;

function render(next: AgentBrowserToolbarView): void {
  view = next;
  const user = next.control === "user";
  document.body.classList.toggle("user", user);
  document.body.classList.toggle("asking", next.request != null);
  back.disabled = !user || !next.canGoBack;
  forward.disabled = !user || !next.canGoForward;
  reload.disabled = !user || next.tabs.length === 0;
  address.readOnly = !user;
  const active = next.tabs.find((tab) => tab.active);
  if (!editing) address.value = active?.url === "about:blank" ? "" : (active?.url ?? "");
  address.placeholder = user ? "Type an address" : "";
  status.textContent = next.request != null ? `${next.agentName} asks: ${next.request}` : user ? `You're in control. ${next.agentName} waits.` : `${next.agentName} is browsing${next.loading ? "…" : ""}`;
  chat.hidden = next.request == null;
  control.textContent = user ? `Hand back to ${next.agentName}` : "Take over";

  tabs.replaceChildren(
    ...next.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = `tab${tab.active ? " tab--active" : ""}`;
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(tab.active));
      item.title = tab.url;
      const label = document.createElement("button");
      label.type = "button";
      label.className = "tab__label";
      label.textContent = tab.title.trim() || (tab.url === "about:blank" ? "New tab" : tab.url);
      label.disabled = !user;
      label.addEventListener("click", () => void toolbar.switchBrowserTab({ tabId: tab.id }));
      item.append(label);
      if (user) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab__close";
        close.setAttribute("aria-label", `Close ${label.textContent}`);
        close.textContent = "×";
        close.addEventListener("click", () => void toolbar.closeBrowserTab({ tabId: tab.id }));
        item.append(close);
      }
      return item;
    }),
  );
  if (user) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab__new";
    add.setAttribute("aria-label", "New tab");
    add.textContent = "+";
    add.addEventListener("click", () => void toolbar.newTab());
    tabs.append(add);
  }
}

back.addEventListener("click", () => void toolbar.historyBack());
forward.addEventListener("click", () => void toolbar.goForward());
reload.addEventListener("click", () => void toolbar.reload());
chat.addEventListener("click", () => void toolbar.showChat());
control.addEventListener("click", () => void (view?.control === "user" ? toolbar.returnControl() : toolbar.takeOver()));
address.addEventListener("focus", () => {
  editing = !address.readOnly;
  if (editing) address.select();
});
address.addEventListener("blur", () => {
  editing = false;
  if (view != null) render(view);
});
address.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !address.readOnly && address.value.trim().length > 0) {
    void toolbar.navigate({ url: address.value.trim() }).catch((error: unknown) => (status.textContent = error instanceof Error ? error.message.replace(/^.*?: /, "") : String(error)));
    address.blur();
  } else if (event.key === "Escape") address.blur();
});

void toolbar.read().then((first) => {
  render(first);
  toolbar.subscribe({ changed: (next) => (next.agentId === first.agentId ? render(next) : undefined) });
});
