// The keyboard shortcuts dialog (Ctrl+/), in five sections.
import { Fragment } from "react";
import { isModKey, SHORTCUT_SECTIONS, SHORTCUTS } from "../shortcuts";
import { closeDialog } from "../store/app";
import { Modal } from "./AgentDialog";

/** Key caps for each alternative combination, e.g. Ctrl K, or Alt ↑ / Alt ↓. */
export function Keys({ keys }: { keys: string[][] }) {
  return (
    <span className="keys">
      {keys.map((combo, index) => (
        <Fragment key={combo.join("+")}>
          {index > 0 ? <span className="keys__or">/</span> : null}
          <span className="keys__combo">
            {combo.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard shortcuts" onClose={closeDialog} className="modal--shortcuts">
      {/* Ctrl+/ again closes it. */}
      <div
        onKeyDown={(event) => {
          if (isModKey(event) && (event.key === "/" || event.key === "?")) {
            event.preventDefault();
            closeDialog();
          }
        }}
      >
        <div className="shortcuts">
          {SHORTCUT_SECTIONS.map((section) => (
            <section key={section} className="shortcuts__section" aria-label={section}>
              <h3>{section}</h3>
              <dl>
                {SHORTCUTS.filter((shortcut) => shortcut.section === section).map((shortcut) => (
                  <div key={shortcut.id} className="shortcuts__row">
                    <dt>{shortcut.label}</dt>
                    <dd>
                      <Keys keys={shortcut.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--primary" autoFocus onClick={closeDialog}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
