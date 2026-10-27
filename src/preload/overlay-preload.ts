// Capture overlay preload: exposes the `desktop-mount-capture-overlay` edge as
// `window.desktopMountCaptureOverlay`.
import { contextBridge, ipcRenderer } from "electron";
import { createEdgeClient } from "../shared/rpc/runtime";
import { ipcClientTransport } from "../shared/rpc/transports";
import { captureOverlayEdge } from "../shared/edges";

contextBridge.exposeInMainWorld("desktopMountCaptureOverlay", createEdgeClient(captureOverlayEdge, ipcClientTransport(ipcRenderer)));
