// node-agent-coordinator utility process. It sits between the renderer and
// the box: it serves the `gateway` edge to each renderer over a dedicated
// MessagePort, relays commands to the box gateway, fans box events out to every
// renderer, and keeps a roster cache that main uses for the tray, notifications
// and the desktop panel.
import { createPortPeer, mainPort, type MessagePortMainLike, type PortPeer } from "../shared/rpc/transports";
import { createEdgeClient, serveEdge } from "../shared/rpc/runtime";
import { eventChannel } from "../shared/rpc/edge";
import { coordinatorControlEdge, coordinatorMainEdge, gatewayEdge, type SendPromptArgs, type TranscribeAudioArgs } from "../shared/edges";
import { type AgentSummary, isAgentWorking, type VoiceTranscription } from "../shared/model";
import { GatewayClient } from "./gateway-client";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown; ports: MessagePortMainLike[] }) => void): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const log = (line: string) => process.stderr.write(`node-agent-coordinator: ${line}\n`);

const roster = new Map<string, AgentSummary>();
const renderers = new Map<string, PortPeer>();
let control: ReturnType<typeof createEdgeClient<typeof coordinatorControlEdge>> | null = null;
let gateway: GatewayClient | null = null;
/** Main's attachment store; a remote box gets uploads of files from here only. */
let attachmentsRoot = "";

parentPort.on("message", ({ data, ports }) => {
  const message = data as { type?: string; id?: string; attachmentsRoot?: string };
  if (message.type === "bootstrap" && ports[0] != null) {
    attachmentsRoot = typeof message.attachmentsRoot === "string" ? message.attachmentsRoot : "";
    bootstrap(ports[0]);
  } else if (message.type === "renderer-port" && ports[0] != null && typeof message.id === "string") attachRenderer(message.id, ports[0]);
});

/** Prompts carry staged attachments; a remote box receives the files first. */
const deliverMessage = async (args: SendPromptArgs) => gateway!.dispatchCommand<{ accepted?: boolean | null } | null>("deliverMessage", await gateway!.withUploadedAttachments(args, attachmentsRoot));

/** A recording staged as an attachment goes to a remote box the same way before it's transcribed. */
const speechToText = async (args: TranscribeAudioArgs) => gateway!.dispatchCommand<VoiceTranscription>("speechToText", await gateway!.withUploadedRecording(args, attachmentsRoot));

/** The user's answer is recorded on this PC before the box hears it: local-exec only honors answers given here. */
const answerToolApproval = async (args: { agentId: string; entryId: string; requestId: string; resolution: "allow-once" | "always" | "deny" | "never" }) => {
  await control!.noteToolApproval({ requestId: args.requestId, resolution: args.resolution });
  return gateway!.dispatchCommand<null>("answerToolApproval", args);
};

function bootstrap(port: MessagePortMainLike): void {
  const peer = createPortPeer(mainPort(port), "coordinator-main");
  control = createEdgeClient(coordinatorControlEdge, peer.client);
  gateway = new GatewayClient({
    resolveConnection: () => control!.gatewayAddress({ path: "gateway" }),
    onEvent: onBoxEvent,
    onState: (state) => {
      broadcast("gateway-link", { state });
      if (state === "connected") void seedRoster().catch((error) => log(`agents roster seed skipped: ${String(error)}`));
    },
    log,
  });

  serveEdge(
    coordinatorMainEdge,
    {
      rosterAgents: async () => (gateway!.isConnected ? await seedRoster() : [...roster.values()]),
      deliverMessage: (args) => deliverMessage(args),
      windowFocusChanged: () => null,
    },
    peer.server,
    { onError: (method, error) => log(`coordinator-main ${method} failed: ${String(error)}`) },
  );

  gateway.start();
  peer.closed.then(() => {
    gateway?.stop();
    process.exit(0);
  });
}

function attachRenderer(id: string, port: MessagePortMainLike): void {
  renderers.get(id)?.close();
  const peer = createPortPeer(mainPort(port), `renderer:${id}`);
  renderers.set(id, peer);
  const forward = (method: string) => (args: unknown) => gateway!.dispatchCommand(method, args);
  const handlers = { ...Object.fromEntries(Object.keys(gatewayEdge.methods).map((method) => [method, forward(method)])), deliverMessage, answerToolApproval, speechToText };
  serveEdge(gatewayEdge, handlers as never, peer.server, { onError: (method, error) => log(`gateway ${method} failed: ${String(error)}`) });
  peer.closed.then(() => {
    if (renderers.get(id) === peer) renderers.delete(id);
  });
  peer.server.emit(eventChannel("gateway", "gateway-link"), { state: gateway?.isConnected ? "connected" : "down" });
}

function broadcast(channel: string, payload: unknown): void {
  for (const peer of renderers.values()) {
    try {
      peer.server.emit(eventChannel("gateway", channel), payload);
    } catch {
      // closed renderer; cleaned up by its `closed` promise
    }
  }
}

async function seedRoster(): Promise<AgentSummary[]> {
  const agents = await gateway!.dispatchCommand<AgentSummary[]>("rosterAgents", {});
  roster.clear();
  for (const agent of agents) roster.set(agent.id, agent);
  reportRoster();
  return agents;
}

function onBoxEvent(channel: string, payload: unknown): void {
  if (channel === "agent-saved") {
    const { agent } = payload as { agent: AgentSummary };
    roster.set(agent.id, agent);
    reportRoster();
  } else if (channel === "agent-deleted") {
    for (const id of (payload as { ids: string[] }).ids) roster.delete(id);
    reportRoster();
  } else if (channel === "activity") {
    // Main decides on OS notifications; renderers see the roster changes instead.
    const activity = payload as { agentId: string; kind: string };
    const row = roster.get(activity.agentId);
    if (row != null && (!row.notificationsEnabled || (activity.kind === "finished" && !row.notifyOnUpdatesEnabled))) return;
    void control?.noteAgentActivity(payload as never).catch((error) => log(`activity report failed: ${String(error)}`));
    return;
  }
  broadcast(channel, payload);
}

let rosterTimer: NodeJS.Timeout | null = null;
function reportRoster(): void {
  rosterTimer ??= setTimeout(() => {
    rosterTimer = null;
    const rows = [...roster.values()].filter((row) => row.isHiddenFromSidebar !== true);
    void control
      ?.reportRoster({
        running: rows.filter(isAgentWorking).length,
        unread: rows.filter((row) => row.hasUnread).length,
        awaiting: rows.filter((row) => row.awaitingUserResponse != null).length,
      })
      .catch(() => undefined);
  }, 200);
}
