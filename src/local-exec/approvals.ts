// Approvals for tools on this PC. When a call needs consent the daemon issues
// an approval id for exactly that call; the box shows the card and resends the
// call with the user's answer. The answer counts only if it is for that same
// call and the user gave it in the app on this PC (main records it as the
// coordinator relays it), so a box elsewhere can't approve on the user's behalf
// or reuse one approval for another command. The card also keeps what the call
// would act on (its plan's subject): a click on a ref the user approved isn't
// run once the page has put something else behind that ref.
import type { ToolApproval } from "../shared/gateway-protocol";

const TTL_MS = 24 * 60 * 60_000;

export interface ApprovableCall {
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  approval: ToolApproval | null;
}

export class IssuedApprovals {
  private issued = new Map<string, { agentId: string; tool: string; args: string; subject: string; at: number }>();

  /** `take` returns the user's answer to a card on this PC, once. */
  constructor(private readonly take: (requestId: string) => Promise<"allow-once" | "always" | "never" | null>) {}

  issue(approvalId: string, call: Omit<ApprovableCall, "approval">, subject = ""): void {
    for (const [id, entry] of this.issued) if (Date.now() - entry.at > TTL_MS) this.issued.delete(id);
    this.issued.set(approvalId, { agentId: call.agentId, tool: call.tool, args: JSON.stringify(call.args), subject, at: Date.now() });
  }

  /** The card was issued for something else than what the call would act on now. */
  changed(approvalId: string, subject: string): boolean {
    const card = this.issued.get(approvalId);
    return card != null && card.subject !== subject;
  }

  /** True when the call is the one the card was issued for and carries the answer the user gave here. */
  async confirm(call: ApprovableCall, subject = ""): Promise<boolean> {
    const approval = call.approval;
    if (approval?.requestId == null) return false;
    const card = this.issued.get(approval.requestId);
    if (card == null || card.agentId !== call.agentId || card.tool !== call.tool || card.args !== JSON.stringify(call.args)) return false;
    this.issued.delete(approval.requestId);
    if (card.subject !== subject) return false;
    return (await this.take(approval.requestId)) === approval.resolution;
  }
}
