// Agent browser toolbar preload: exposes the `agent-browser-toolbar` edge as
// `window.agentBrowserToolbar`. Only the toolbar gets it; the agent's pages have no preload.
import { contextBridge, ipcRenderer } from "electron";
import { createEdgeClient } from "../shared/rpc/runtime";
import { ipcClientTransport } from "../shared/rpc/transports";
import { agentBrowserToolbarEdge } from "../shared/edges";

contextBridge.exposeInMainWorld("agentBrowserToolbar", createEdgeClient(agentBrowserToolbarEdge, ipcClientTransport(ipcRenderer)));
