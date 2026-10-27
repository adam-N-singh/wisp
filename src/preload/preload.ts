// Main window preload. It exposes `window.desktop` ({main, boot, environment,
// local}) and the gateway client (`window.desktop.gateway`) instead of handing
// the raw coordinator port to the page. The coordinator port is requested from
// main and replaced transparently when the coordinator restarts.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createEdgeClient, type ClientTransport } from "../shared/rpc/runtime";
import { createPortPeer, domPort, ipcClientTransport, type PortPeer } from "../shared/rpc/transports";
import { gatewayEdge, mainEdge } from "../shared/edges";

const boot = ipcRenderer.sendSync("wisp:boot-snapshot-sync");
const main = createEdgeClient(mainEdge, ipcClientTransport(ipcRenderer));

// ---- gateway over the coordinator MessagePort ---------------------------------------------
let peer: PortPeer | null = null;
let markReady!: () => void;
let ready = new Promise<void>((resolve) => (markReady = resolve));
const subscriptions = new Set<{ channel: string; listener: (payload: unknown) => void; off: (() => void) | null }>();

ipcRenderer.on("wisp:coordinator-port", (event) => {
  const port = event.ports[0];
  if (port == null) return;
  peer?.close();
  peer = createPortPeer(domPort(port), "coordinator");
  for (const subscription of subscriptions) subscription.off = peer.client.on(subscription.channel, subscription.listener);
  markReady();
  peer.closed.then(() => {
    // The coordinator went away; calls wait for the replacement port.
    ready = new Promise<void>((resolve) => (markReady = resolve));
  });
});
void ipcRenderer.invoke("wisp:coordinator-port-request");

const gatewayTransport: ClientTransport = {
  async invoke(channel, payload) {
    await ready;
    return peer!.client.invoke(channel, payload);
  },
  on(channel, listener) {
    const subscription = { channel, listener, off: peer?.client.on(channel, listener) ?? null };
    subscriptions.add(subscription);
    return () => {
      subscription.off?.();
      subscriptions.delete(subscription);
    };
  },
};
const gateway = createEdgeClient(gatewayEdge, gatewayTransport);

// ---- local helpers ------------------------------------------------------------------------
async function stageAttachmentFile(file: File, filename?: string) {
  const name = filename ?? file.name ?? "file";
  const path = webUtils.getPathForFile(file);
  if (path) return main.stageUploadFile({ filename: name, sourcePath: path });
  return main.stageUploadBytes({ filename: name, bytes: new Uint8Array(await file.arrayBuffer()) });
}

contextBridge.exposeInMainWorld("desktop", {
  main,
  gateway,
  boot,
  environment: {
    platform: process.platform,
    isDev: process.env.NODE_ENV !== "production",
  },
  local: {
    stageAttachmentFile,
    mediaUrl: (path: string) => `wisp-media://file/${encodeURIComponent(path)}`,
    visualizationUrl: (path: string, theme: "light" | "dark") => `wisp-visualization://doc/${encodeURIComponent(path)}?theme=${theme}`,
  },
});
