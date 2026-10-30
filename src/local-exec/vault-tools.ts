// The vault's tools (src/shared/vault.ts). Main keeps the vault and fills from it (src/main/vault.ts);
// the daemon offers the tools and plans each fill for the policy. vault_list is a read (labels, no
// values). request_credential is rated dangerous: the user is asked on this PC every time, for that
// item on the site main read from the page, and it's never remembered. The call goes on to main with
// the site it was rated for and the approval's id, and main checks both again before a value moves.
import { randomUUID } from "node:crypto";
import { siteLabel } from "../shared/agent-browser";
import { CONTACT_FILL_KEYS, FIELD_LABELS, LOGIN_FILL_KEYS, VAULT_FILL_KEYS, VAULT_PERMISSION_ID, type VaultFillKey } from "../shared/vault";
import type { LocalTool, ToolContext } from "./tools";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

const fieldsOf = (args: Record<string, unknown>): Record<string, string> => {
  const fields = args.fields;
  if (fields == null || typeof fields !== "object" || Array.isArray(fields)) return {};
  return Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([key, ref]) => [key, String(ref ?? "")]));
};
const call = (args: Record<string, unknown>, context: ToolContext) => ({ agentId: context.agentId, itemId: String(args.item_id ?? ""), fields: fieldsOf(args), submit: args.submit === true });

export const VAULT_TOOLS: Record<"vault_list" | "request_credential", LocalTool> = {
  vault_list: {
    descriptor: {
      name: "vault_list",
      description:
        "List the logins and contact info the user keeps in their vault on their computer: each item's id and a label like “Login for shop.example (j…@gmail.com)”. You never see a value. Fill one into a page in your agent browser with request_credential; items that fit the page open in your browser are marked.",
      parameters: object({}),
      permissionId: VAULT_PERMISSION_ID,
      readOnly: true,
    },
    plan: () => ({ risk: "read-only", reasons: [], scope: "all", paths: [], action: "use-app", target: "your vault (labels only, no values)", title: "List your vault" }),
    async execute(_args, context) {
      const reply = await context.host.vault.list({ agentId: context.agentId });
      if (reply.items.length === 0) return { output: "The vault is empty. The user adds logins and contact info in Settings → Vault; until then, hand them the browser with browser_wait_for_user to sign in." };
      const page = reply.pageSite != null ? ` Your browser is on ${siteLabel(reply.pageSite)}.` : "";
      const lines = reply.items.map((item) => {
        const where = item.site != null ? `fills on ${siteLabel(item.site)}` : "fills on any site";
        return `- ${item.id}: ${item.label} — ${item.fields.join(", ")} — ${where}${item.matchesPage ? " (fits the page you're on)" : ""}`;
      });
      return { output: [`${reply.items.length} item${reply.items.length === 1 ? "" : "s"} in the vault (values are never shown).${page}`, ...lines].join("\n") };
    },
  },

  request_credential: {
    descriptor: {
      name: "request_credential",
      description: [
        "Fill a login or contact info from the user's vault (vault_list) into the page in your agent browser. fields maps what to fill to the ref of a field from browser_snapshot, like {\"username\": \"e3\", \"password\": \"e5\"}.",
        `A login fills ${LOGIN_FILL_KEYS.join(" and ")}; contact info fills ${CONTACT_FILL_KEYS.join(", ")}.`,
        "The user is asked on their computer every time, for that item on the page's site. A login only fills on its own site, and a password only into a password field.",
        "Neither you nor the chat ever sees the values: the result says how many fields were filled, and snapshots and screenshots keep those fields hidden. submit presses Enter in the last field afterwards (that signs in on most pages).",
        "Use this instead of typing a password; when nothing in the vault fits, hand the user the browser with browser_wait_for_user.",
      ].join(" "),
      parameters: object(
        {
          item_id: { type: "string", description: "The item's id from vault_list." },
          fields: {
            type: "object",
            description: "What to fill → the field's ref.",
            properties: Object.fromEntries(VAULT_FILL_KEYS.map((key) => [key, { type: "string", description: `The ref of the ${FIELD_LABELS[key].toLowerCase()} field.` }])),
            additionalProperties: false,
          },
          submit: { type: "boolean", description: "Press Enter in the last filled field afterwards (submits the form)." },
        },
        ["item_id", "fields"],
      ),
      permissionId: VAULT_PERMISSION_ID,
      readOnly: false,
    },
    async plan(args, context) {
      const info = await context.host.vault.plan(call(args, context));
      const site = siteLabel(info.site);
      const fields = info.fields.map((field) => `${FIELD_LABELS[field.key as VaultFillKey]} into ${field.ref} (${field.element})`);
      return {
        risk: "dangerous",
        reasons: [info.label, `fills ${fields.join(", ")}`, ...(info.submit ? ["then presses Enter to submit the form"] : [])],
        // The agent, the item and the page's origin: an approval is for this agent's fill of this item on this site only.
        scope: info.subject,
        paths: [],
        action: "use-app",
        target: site,
        title: `Fill ${info.kind === "login" ? "your login" : "your contact info"} on ${site}`,
        description: info.subject,
      };
    },
    async execute(args, context) {
      const subject = context.plan?.scope ?? "";
      // An origin has no "@" in it (addresses with a user name aren't opened).
      const at = subject.lastIndexOf("@");
      const expectSite = subject.startsWith("vault:") && at > 0 ? subject.slice(at + 1) : null;
      const callId = randomUUID();
      const onAbort = () => void context.host.browser.cancel({ callId }).catch(() => undefined);
      context.signal.addEventListener("abort", onAbort);
      try {
        const reply = await context.host.vault.fill({ ...call(args, context), expectSite, approvalId: context.approvalId ?? null, callId });
        return { output: reply.output };
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }
    },
  },
};
