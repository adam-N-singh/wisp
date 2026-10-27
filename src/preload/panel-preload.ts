// Desktop-mount panel preload: exposes the `desktop-mount` edge as
// `window.desktopMount`.
import { contextBridge, ipcRenderer } from "electron";
import { createEdgeClient } from "../shared/rpc/runtime";
import { ipcClientTransport } from "../shared/rpc/transports";
import { desktopMountEdge } from "../shared/edges";

contextBridge.exposeInMainWorld("desktopMount", createEdgeClient(desktopMountEdge, ipcClientTransport(ipcRenderer)));
