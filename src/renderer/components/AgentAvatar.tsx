// An agent's avatar in the main window, where the roster is: a group chat's stacks its first two
// members'.
import type { AgentSummary } from "../../shared/model";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { Avatar, AvatarStack } from "./Avatar";

export function AgentAvatar({ agent, size = 28, busy = false }: { agent: AgentSummary; size?: number; busy?: boolean }) {
  const state = useStore(roster);
  if (!agent.isGroup) return <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={size} busy={busy} image={agent.avatarDataUrl} />;
  const everyone = allAgents(state);
  const members = agent.memberIds.flatMap((id) => everyone.filter((candidate) => candidate.id === id));
  return <AvatarStack members={members} size={size} busy={busy} />;
}
