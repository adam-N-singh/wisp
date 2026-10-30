// Group chats: the New group chat dialog (Mod+Shift+N, the palette), the room's details pane with
// its Members, and what the room shows while members take their turns ("{names} are reading",
// "Typing…"). The turns themselves are the box's (src/box/rooms.ts).
import { type FormEvent, useEffect, useState } from "react";
import type { AgentSummary } from "../../shared/model";
import { gateway } from "../bridge";
import { closeDialog, openDialog, selectAgent } from "../store/app";
import { layout } from "../store/layout";
import { allAgents, getAgent, roster, upsertAgent } from "../store/roster";
import { useStore } from "../store/store";
import { Modal } from "./AgentDialog";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./icons";

/** A gateway error without its method or failure-code prefix. */
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause));

/** "Scout", "Scout and Atlas", "Scout, Atlas and Echo". */
export function namesText(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const nameOf = (id: string) => getAgent(id)?.name ?? "A bot";

/** While members take their turns: "Scout is reading", "Scout and Atlas are reading", or "Scout · Typing…". */
export function groupActivityText(room: AgentSummary): string | null {
  const running = (room.groupTurns ?? []).filter((turn) => turn.isRunningTurn === true);
  if (running.length === 0) return room.isRunning ? "Passing the message around…" : null;
  const typing = running.filter((turn) => turn.isComposingMessage);
  if (typing.length > 0) return `${namesText(typing.map((turn) => nameOf(turn.memberId)))} · Typing…`;
  const names = running.map((turn) => nameOf(turn.memberId));
  return `${namesText(names)} ${names.length === 1 ? "is" : "are"} reading`;
}

/** The room's line under its messages while a round runs. */
export function GroupActivity({ room }: { room: AgentSummary }) {
  useStore(roster); // members' names
  const text = groupActivityText(room);
  if (text == null) return null;
  return (
    <div className="working" aria-label="Bots are replying">
      <span className="working__dots">
        <i />
        <i />
        <i />
      </span>
      <span className="working__text">{text}</span>
    </div>
  );
}

/** New group chat: a name (or none, to name it after its bots) and two or more bots. */
export function NewGroupDialog() {
  const state = useStore(roster);
  const bots = allAgents(state).filter((agent) => !agent.isGroup);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (picked.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const { agent } = await gateway.makeGroupChat({ name: name.trim(), memberAgentIds: picked, clientNonce: crypto.randomUUID() });
      // In the roster before it's selected, which its event may not have reached yet.
      upsertAgent(agent);
      closeDialog();
      selectAgent(agent.id);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <Modal title="New group chat" onClose={closeDialog}>
      <form className="form" onSubmit={(event) => void create(event)}>
        <label>
          Name <span className="muted">(optional)</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={picked.length > 0 ? picked.map(nameOf).join(", ") : "Named after its bots"} />
        </label>
        <fieldset className="member-picker">
          <legend>Bots</legend>
          {bots.length < 2 ? <p className="muted">A group chat needs at least two bots. Create another one first.</p> : null}
          {bots.map((bot) => (
            <label key={bot.id} className="member-picker__row">
              <input type="checkbox" checked={picked.includes(bot.id)} onChange={() => toggle(bot.id)} />
              <AgentAvatar agent={bot} size={24} />
              <span className="member-picker__name">{bot.name}</span>
              {bot.description.length > 0 ? <span className="member-picker__role muted">{bot.description}</span> : null}
            </label>
          ))}
        </fieldset>
        <p className="muted">In the chat, @mention a bot to ask only it, or @everyone. A message that mentions no one gives every bot a turn, and each may pass.</p>
        {error != null ? <p className="form-error">{error}</p> : null}
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={picked.length < 2 || busy}>
            Create group chat
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The details pane of a group chat: its name, its Members (added and removed here), and how turns go. */
export function GroupDetails({ room }: { room: AgentSummary }) {
  const state = useStore(roster);
  const width = useStore(layout, (value) => value.infoPane.width);
  const everyone = allAgents(state);
  const members = room.memberIds.flatMap((id) => everyone.filter((agent) => agent.id === id));
  const others = everyone.filter((agent) => !agent.isGroup && !room.memberIds.includes(agent.id));
  const [name, setName] = useState(room.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(room.name);
    setError(null);
  }, [room.id, room.name]);

  const change = (ids: string[]) => {
    setError(null);
    void gateway.changeGroupMembers({ id: room.id, memberAgentIds: ids }).catch((cause) => setError(errorText(cause)));
  };
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0 || name.trim() === room.name) return;
    void gateway.editAgent({ id: room.id, profile: { name: name.trim(), description: room.description }, editedFields: ["name"] }).catch((cause) => setError(errorText(cause)));
  };

  return (
    <aside className="info-pane" style={{ width }} aria-label="Group chat details">
      <div className="info-pane__body">
        <div className="overview">
          <section>
            <h3>Name</h3>
            <form className="group-rename" onSubmit={rename}>
              <input aria-label="Group chat name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="button button--small" disabled={name.trim().length === 0 || name.trim() === room.name}>
                Rename
              </button>
            </form>
          </section>
          <section aria-label="Members">
            <h3>Members</h3>
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.id} className="member-list__row">
                  <button type="button" className="member-list__open" title={`Open your chat with ${member.name}`} onClick={() => selectAgent(member.id)}>
                    <AgentAvatar agent={member} size={24} />
                    <span className="member-list__name">{member.name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--small"
                    aria-label={`Remove ${member.name}`}
                    title={members.length <= 2 ? "A group chat needs at least two bots" : `Remove ${member.name} from the chat`}
                    disabled={members.length <= 2}
                    onClick={() => change(room.memberIds.filter((id) => id !== member.id))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
            {others.length > 0 ? (
              <select className="member-list__add" aria-label="Add a bot" value="" onChange={(event) => event.target.value.length > 0 && change([...room.memberIds, event.target.value])}>
                <option value="">Add a bot…</option>
                {others.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            ) : null}
            {error != null ? <p className="form-error">{error}</p> : null}
          </section>
          <section>
            <h3>How turns go</h3>
            <p className="muted">
              A message that @mentions bots goes to them, in that order; @everyone goes to all. One that mentions no one gives each bot a turn, and a bot with nothing to add passes. A bot can
              @mention another to ask it, up to three times in a row. Each bot keeps its own conversation for this chat, apart from your chat with it.
            </p>
          </section>
          <section className="overview__buttons">
            <button type="button" className="button" onClick={() => openDialog({ kind: "new-group" })}>
              <Icon name="users" size={14} /> New group chat
            </button>
          </section>
        </div>
      </div>
    </aside>
  );
}
