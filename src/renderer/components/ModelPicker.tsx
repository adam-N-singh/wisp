// Model picker: models from every connected provider, grouped by provider,
// plus "Other model…" to type any model id.
import { useEffect, useState } from "react";
import { formatModelRef, type ModelRef, parseModelRef, PROVIDER_LABELS, type ProviderId } from "../../shared/model";
import { loadModels, modelLists, modelSettings, readyProviders } from "../store/models";
import { useStore } from "../store/store";

const DEFAULT_VALUE = "__default__";
const OTHER_PREFIX = "__other__:";

export function ModelPicker({ value, onChange, allowDefault = false, label }: { value: ModelRef | null; onChange: (next: ModelRef | null) => void; allowDefault?: boolean; label: string }) {
  const settings = useStore(modelSettings);
  const lists = useStore(modelLists);
  const providers = readyProviders(settings);
  const [other, setOther] = useState<{ provider: ProviderId; text: string } | null>(null);

  const providerKey = providers.join(",");
  useEffect(() => {
    for (const provider of providerKey.split(",")) if (provider.length > 0) void loadModels(provider as ProviderId);
  }, [providerKey]);

  const selected = value == null ? DEFAULT_VALUE : formatModelRef(value);
  const groups = providers.map((provider) => {
    const list = lists[provider];
    const ids = new Map<string, string | undefined>((list?.models ?? []).map((model) => [model.id, model.label]));
    if (value != null && value.provider === provider && value.model.length > 0 && !ids.has(value.model)) ids.set(value.model, undefined);
    return { provider, list, options: [...ids.entries()] };
  });
  const missing = value != null && !providers.includes(value.provider);
  const useOther = () => {
    if (other == null || other.text.trim().length === 0) return;
    onChange({ provider: other.provider, model: other.text.trim() });
    setOther(null);
  };

  return (
    <div className="model-picker">
      <select
        aria-label={label}
        value={other != null ? `${OTHER_PREFIX}${other.provider}` : selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === DEFAULT_VALUE) {
            setOther(null);
            onChange(null);
          } else if (next.startsWith(OTHER_PREFIX)) {
            setOther({ provider: next.slice(OTHER_PREFIX.length) as ProviderId, text: "" });
          } else {
            setOther(null);
            onChange(parseModelRef(next, { provider: "mock", model: "mock-1" }));
          }
        }}
      >
        {allowDefault ? <option value={DEFAULT_VALUE}>App default</option> : null}
        {missing ? <option value={selected}>{`${value!.model} · ${PROVIDER_LABELS[value!.provider]} (not connected)`}</option> : null}
        {groups.map(({ provider, list, options }) => (
          <optgroup key={provider} label={`${PROVIDER_LABELS[provider]}${list?.loading ? " (loading…)" : list?.error != null ? " (couldn't list models)" : ""}`}>
            {options.map(([id, optionLabel]) => (
              <option key={id} value={formatModelRef({ provider, model: id })}>
                {optionLabel != null && optionLabel !== id ? `${optionLabel} (${id})` : id}
              </option>
            ))}
            {provider !== "mock" && provider !== "claude-code" ? <option value={`${OTHER_PREFIX}${provider}`}>Other {PROVIDER_LABELS[provider]} model…</option> : null}
          </optgroup>
        ))}
      </select>
      {other != null ? (
        // Not a <form>: the picker also sits inside other forms.
        <div className="inline-form">
          <input
            className="mono"
            autoFocus
            value={other.text}
            onChange={(event) => setOther({ ...other, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                useOther();
              }
            }}
            placeholder={`${PROVIDER_LABELS[other.provider]} model id`}
            aria-label="Model id"
          />
          <button type="button" className="button" onClick={useOther}>
            Use
          </button>
          <button type="button" className="button button--ghost" onClick={() => setOther(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {groups.some(({ list }) => list?.error != null) ? (
        <div className="model-picker__errors">
          {groups
            .filter(({ list }) => list?.error != null)
            .map(({ provider, list }) => (
              <div key={provider} className="muted">
                {PROVIDER_LABELS[provider]}: {list!.error}{" "}
                <button type="button" className="link-button" onClick={() => void loadModels(provider, true)}>
                  Retry
                </button>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
