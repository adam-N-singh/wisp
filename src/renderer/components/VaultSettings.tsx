// Settings → Vault (README "Vault"): logins and contact info on this PC that agents fill into
// their agent browser. Main keeps them sealed (src/main/vault.ts); this page lists them without
// values, edits them (a saved password is never sent back here: leaving the field empty keeps it),
// imports a password export the user made in Chrome, Edge or Firefox (read by main), and shows the
// audit log's latest fills and whether its hash chain is intact.
import { type FormEvent, useEffect, useState } from "react";
import { siteLabel } from "../../shared/agent-browser";
import { CONTACT_FIELDS, FIELD_LABELS, type VaultImportResult, type VaultItemDraft, type VaultItemKind, type VaultItemSummary, vaultItemLabel, type VaultView } from "../../shared/vault";
import { main } from "../bridge";
import { Icon } from "./icons";

type Filter = "all" | VaultItemKind;
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "login", label: "Logins" },
  { id: "contact", label: "Contact info" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error));
const blank = (kind: VaultItemKind): VaultItemDraft => ({ id: null, kind, title: "", site: "", values: {}, hasPassword: false });

function importText(result: VaultImportResult): string {
  const from = result.format === "firefox" ? "Firefox" : "Chrome or Edge";
  const parts = [`${result.added} added`, `${result.updated} updated`, `${result.unchanged} unchanged`, `${result.skipped} skipped`];
  const notes = result.notesDropped > 0 ? ` Notes on ${result.notesDropped} looked like a card number and were left out.` : "";
  return `Imported a ${from} export: ${parts.join(", ")}.${notes} Delete the exported file now: it holds your passwords in plain text.`;
}

export function VaultSettings() {
  const [view, setView] = useState<VaultView | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<VaultItemDraft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = main.subscribe({ "vault-changed": (next) => setView(next) });
    void main.readVault().then(setView);
    return off;
  }, []);
  if (view == null) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const items = view.items.filter((item) => filter === "all" || item.kind === filter);
  const audit = view.audit;
  const writable = view.available && view.problem == null;

  return (
    <div className="settings-section">
      <h2>Vault</h2>
      <p className="muted">
        Logins and contact info your agents can fill into their agent browser on this PC. Each value is sealed with this computer’s secure storage and never reaches the model, the box or the chat: the agent sees a label like “Login for shop.example (j…@gmail.com)”, and
        you’re asked here every time, for that item on that site. A login only fills on its own site. Payment cards aren’t kept.
      </p>
      {!view.available ? <div className="form-error">This computer’s secure storage isn’t available, so nothing new can be saved in the vault.</div> : null}
      {view.problem != null ? (
        <div className="form-error" role="alert">
          The vault can’t be read: {view.problem} Nothing is saved, filled or listed until it can be, and the file is left as it is. Move it aside to start an empty vault, or put back a copy that reads.
        </div>
      ) : null}

      <div className="vault__bar">
        <div className="vault__tabs" role="tablist" aria-label="Show">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={`tab${filter === item.id ? " tab--active" : ""}`} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="vault__actions">
          <button type="button" className="button" disabled={!writable || busy} onClick={() => (setEditing(blank("login")), setMessage(null))}>
            <Icon name="plus" size={12} /> New login
          </button>
          <button type="button" className="button" disabled={!writable || busy} onClick={() => (setEditing(blank("contact")), setMessage(null))}>
            <Icon name="plus" size={12} /> New contact info
          </button>
          <button
            type="button"
            className="button"
            disabled={!writable || busy}
            title="A .csv file you exported from Chrome, Edge or Firefox (its password settings → Export)"
            onClick={() =>
              void run(async () => {
                const result = await main.importVaultCsv();
                if (result != null) setMessage(importText(result));
              })
            }
          >
            <Icon name="download" size={12} /> Import passwords…
          </button>
        </div>
      </div>
      {message != null ? <div className="settings-status">{message}</div> : null}
      {error != null ? <div className="form-error">{error}</div> : null}

      {editing != null ? <VaultItemForm key={editing.id ?? `new-${editing.kind}`} draft={editing} onClose={() => setEditing(null)} onSaved={(next) => (setView(next), setEditing(null))} /> : null}

      {items.length === 0 ? (
        <p className="muted vault__empty">{view.items.length === 0 ? "Nothing in the vault yet. Add a login or contact info, or import the passwords you exported from your browser." : "Nothing of this kind yet."}</p>
      ) : (
        <ul className="vault-list" aria-label="Vault items">
          {items.map((item) => (
            <VaultRow
              key={item.id}
              item={item}
              busy={busy}
              deleting={deleting === item.id}
              onEdit={() => void run(async () => setEditing(await main.readVaultItem({ id: item.id })))}
              onDelete={() => setDeleting(item.id)}
              onCancelDelete={() => setDeleting(null)}
              onConfirmDelete={() =>
                void run(async () => {
                  setView(await main.deleteVaultItem({ id: item.id }));
                  setDeleting(null);
                  if (editing?.id === item.id) setEditing(null);
                })
              }
            />
          ))}
        </ul>
      )}

      <h3>Fills</h3>
      <p className="muted">
        {audit.ok ? `Every fill is written to vault-audit.jsonl on this PC, without its values. The log’s ${audit.entries} ${audit.entries === 1 ? "entry is" : "entries are"} hash-chained and intact.` : `The audit log’s hash chain breaks at line ${audit.brokenAt}: it was changed outside the app.`}
      </p>
      {audit.recent.length === 0 ? (
        <p className="muted">No fills yet.</p>
      ) : (
        <ul className="vault-fills" aria-label="Recent fills">
          {audit.recent.map((fill) => (
            <li key={`${fill.at}-${fill.label}`}>
              <span>{fill.label}</span>
              <span className="muted">
                on {siteLabel(fill.site)} · {fill.fields.map((field) => FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? field).join(", ")} · {new Date(fill.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VaultRow({ item, busy, deleting, onEdit, onDelete, onCancelDelete, onConfirmDelete }: { item: VaultItemSummary; busy: boolean; deleting: boolean; onEdit(): void; onDelete(): void; onCancelDelete(): void; onConfirmDelete(): void }) {
  const fields = item.fields.filter((field) => field !== "notes").map((field) => FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? field);
  return (
    <li className="vault-list__item">
      <Icon name={item.kind === "login" ? "key" : "person"} size={16} />
      <div className="vault-list__text">
        <div className="vault-list__label">{vaultItemLabel(item)}</div>
        <div className="vault-list__meta">
          {item.kind === "login" ? `Fills on ${siteLabel(item.site)}` : "Fills on any site, asking each time"} · {fields.join(", ")}
        </div>
      </div>
      {deleting ? (
        <>
          <button type="button" className="button button--danger" disabled={busy} onClick={onConfirmDelete}>
            Delete
          </button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={onCancelDelete}>
            Keep
          </button>
        </>
      ) : (
        <>
          <button type="button" className="button button--ghost" disabled={busy} onClick={onEdit} aria-label={`Edit ${vaultItemLabel(item)}`}>
            <Icon name="edit" size={12} /> Edit
          </button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={onDelete} aria-label={`Delete ${vaultItemLabel(item)}`}>
            <Icon name="trash" size={12} />
          </button>
        </>
      )}
    </li>
  );
}

function VaultItemForm({ draft, onClose, onSaved }: { draft: VaultItemDraft; onClose(): void; onSaved(view: VaultView): void }) {
  const [title, setTitle] = useState(draft.title);
  const [site, setSite] = useState(draft.site);
  const [values, setValues] = useState<Record<string, string>>(draft.values);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: string) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [field]: event.target.value }));
  const login = draft.kind === "login";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await main.saveVaultItem({ id: draft.id, kind: draft.kind, title, site, values }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form vault-form" onSubmit={(event) => void submit(event)} aria-label={login ? "Login" : "Contact info"}>
      <h3>{draft.id == null ? (login ? "New login" : "New contact info") : `Edit ${login ? "login" : "contact info"}`}</h3>
      {login ? (
        <>
          <label>
            Site
            <input className="mono" value={site} onChange={(event) => setSite(event.target.value)} placeholder="shop.example or https://shop.example/login" aria-label="Site" autoComplete="off" required />
          </label>
          <p className="form-hint form-hint--attached">It fills only on this site (with or without www.), never on another one.</p>
          <label>
            Username or email
            <input value={values.username ?? ""} onChange={set("username")} aria-label="Username" autoComplete="off" spellCheck={false} />
          </label>
          <label>
            Password
            <input type="password" value={values.password ?? ""} onChange={set("password")} placeholder={draft.hasPassword ? "Saved: leave empty to keep it" : ""} aria-label="Password" autoComplete="new-password" />
          </label>
          <label>
            Notes
            <textarea rows={2} value={values.notes ?? ""} onChange={set("notes")} aria-label="Notes" />
          </label>
          <label>
            Name (optional)
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Work account" aria-label="Item name" />
          </label>
        </>
      ) : (
        <>
          <label>
            Name for this (optional)
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Home" aria-label="Item name" />
          </label>
          {CONTACT_FIELDS.map((field) =>
            field === "street" ? (
              <label key={field}>
                {FIELD_LABELS[field]}
                <textarea rows={2} value={values[field] ?? ""} onChange={set(field)} aria-label={FIELD_LABELS[field]} />
              </label>
            ) : (
              <label key={field}>
                {FIELD_LABELS[field]}
                <input type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} value={values[field] ?? ""} onChange={set(field)} aria-label={FIELD_LABELS[field]} autoComplete="off" />
              </label>
            ),
          )}
        </>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
      <div className="inline-form">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
