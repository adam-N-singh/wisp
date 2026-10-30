// The credential-request card (README "Vault"): an agent asks to fill an item from the vault into
// its agent browser. It's a local-tool-permission card from the daemon's vault permission, drawn
// as a credential request: what will be filled where, and Allow once / Deny only (a
// fill is never remembered). Its content is the copy the daemon registered on this PC, never the
// box's, and an answer counts only from the app on this PC; it names no value.
import { useEffect, useState } from "react";
import { siteLabel } from "../../shared/agent-browser";
import type { LocalToolPermissionAsk } from "../../shared/model";
import { gateway, main } from "../bridge";
import { Icon } from "./icons";
import type { CardTarget } from "./Transcript";

export function CredentialCard({ target, ask: fromBox }: { target: CardTarget; ask: LocalToolPermissionAsk }) {
  const [busy, setBusy] = useState(false);
  // undefined while asking main; null when the card wasn't registered on this PC.
  const [onThisPc, setOnThisPc] = useState<Omit<LocalToolPermissionAsk, "requestId" | "status"> | null | undefined>(undefined);
  useEffect(() => {
    void main
      .describeToolApproval({ requestId: fromBox.requestId })
      .then(setOnThisPc)
      .catch(() => setOnThisPc(null));
  }, [fromBox.requestId]);
  const resolve = async (resolution: "allow-once" | "deny") => {
    setBusy(true);
    try {
      await gateway.answerToolApproval({ ...target, requestId: fromBox.requestId, resolution });
    } finally {
      setBusy(false);
    }
  };
  const settled = fromBox.status !== "pending";
  const ask = onThisPc ?? null;
  const [item, ...rest] = ask?.reasons ?? [];
  const statusText = { allowed: "Allowed once", always: "Allowed once", denied: "Denied", never: "Denied", expired: "Expired", pending: "" }[fromBox.status];
  return (
    <div className={`permission-card credential-card${settled ? " permission-card--settled" : ""}`} role="group" aria-label="Fill from your vault">
      <div className="permission-card__head">
        <Icon name="key" size={16} />
        <span className="permission-card__title">{ask?.title ?? "Fill from your vault"}</span>
        {ask?.machineLabel ? <span className="permission-card__machine">{ask.machineLabel}</span> : null}
      </div>
      {ask != null ? (
        <>
          <div className="credential-card__item">{item}</div>
          <div className="credential-card__site">
            on <strong>{ask.target || siteLabel(null)}</strong>
          </div>
          {rest.length > 0 && !settled ? (
            <ul className="permission-card__reasons">
              {rest.slice(0, 4).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : onThisPc === null ? (
        <div className="permission-card__status">This fill can only be allowed in the app on the computer whose vault holds the item.</div>
      ) : null}
      {settled ? (
        <div className="permission-card__status">{statusText}</div>
      ) : ask != null ? (
        <div className="permission-card__actions">
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void resolve("allow-once")}>
            Allow once
          </button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void resolve("deny")}>
            Deny
          </button>
        </div>
      ) : null}
    </div>
  );
}
