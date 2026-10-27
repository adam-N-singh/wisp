// Box host utility process: the box on this PC. Main spawns it, hands it a
// MessagePort, configures it over `box-control` (models with credentials,
// workspace root, cloud computer) and hands it ChatGPT plan and MCP access
// tokens over `box-host`. The gateway itself lives in host.ts, which the
// standalone box server (src/box-server/) shares.
import { createPortPeer, mainPort, type MessagePortMainLike } from "../shared/rpc/transports";
import { createEdgeClient, serveEdge } from "../shared/rpc/runtime";
import { boxControlEdge, boxHostEdge } from "../shared/edges";
import { startBoxHost } from "./host";

interface Bootstrap {
  type: "bootstrap";
  dataDir: string;
  token: string;
  version: string;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown; ports: MessagePortMainLike[] }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const log = (line: string) => process.stderr.write(`box-host: ${line}\n`);

parentPort.on("message", ({ data, ports }) => {
  if ((data as Bootstrap)?.type === "bootstrap" && ports[0] != null) {
    start(data as Bootstrap, ports[0]).catch((error) => {
      log(`composition failure: ${error instanceof Error ? error.stack : String(error)}`);
      process.exit(1);
    });
  }
});

async function start(boot: Bootstrap, controlPort: MessagePortMainLike): Promise<void> {
  const control = createPortPeer(mainPort(controlPort), "box-control");
  const main = createEdgeClient(boxHostEdge, control.client);
  const box = await startBoxHost({
    dataDir: boot.dataDir,
    version: boot.version,
    token: boot.token,
    host: "127.0.0.1",
    port: 0,
    bridgeListener: "shared",
    // Main keeps the refresh token and hands out fresh access tokens.
    refreshChatGptToken: (force) => main.refreshChatGptToken({ force }),
    // Main keeps MCP sign-ins too, encrypted with the OS keychain.
    mcpAuth: {
      accessToken: (server, force) => main.mcpAccessToken({ serverId: server.id, url: server.url, force }),
      forget: (serverId) => main.forgetMcpSignIn({ serverId }),
    },
    log,
  });

  serveEdge(
    boxControlEdge,
    {
      configure: (next) => box.configure(next),
      listModels: ({ provider }) => box.listModels(provider),
      mcpSignInTarget: ({ serverId }) => box.mcpSignInTarget(serverId),
      mcpSignInChanged: ({ serverId }) => box.mcpSignInChanged(serverId),
    },
    control.server,
  );
  parentPort.postMessage({ type: "ready", port: box.port });

  const shutdown = () => {
    box.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  control.closed.then(shutdown);
}
