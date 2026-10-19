// The form that connects a tracker, or edits a connection (#2178), drawn from
// the provider's field list (integrations/registry.ts): an address, a token,
// whatever else the provider asks for, and a name — with the provider's own
// words on what the token is and where to make one.
//
// A secret field is never filled in. Editing starts it empty, and empty keeps
// the saved value (the server reads it so); a new value replaces it. What was
// typed into a secret field is dropped as soon as the form is sent.
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { isPlainEnter } from "../feedback";
import type { IntegrationFailure } from "../integrations/client";
import type { FieldDef, IntegrationConnection, IntegrationWebDef } from "../integrations/types";

interface FormState {
  values: Readonly<Record<string, string>>;
  existing?: IntegrationConnection;
}

const FormContext = createContext<FormState>({ values: {} });

/** The values typed so far, for a provider's token help to follow ("open the
 *  token page on jira.example.com"). */
export function useIntegrationForm(): FormState {
  return useContext(FormContext);
}

export interface IntegrationConnectionFormProps {
  def: IntegrationWebDef;
  existing?: IntegrationConnection;
  busy: boolean;
  error: IntegrationFailure | null;
  onSubmit: (input: Record<string, string>, name: string) => void;
  onCancel: () => void;
}

/** A field as it reads with the values typed so far. */
function resolved(field: FieldDef, values: Readonly<Record<string, string>>): FieldDef {
  const v = field.variants;
  return v ? { ...field, ...(v.by[values[v.field] ?? ""] ?? {}) } : field;
}

const shown = (field: FieldDef, values: Readonly<Record<string, string>>) =>
  !field.when || field.when.is.includes(values[field.when.field] ?? "");

export default function IntegrationConnectionForm({ def, existing, busy, error, onSubmit, onCancel }: IntegrationConnectionFormProps) {
  const uid = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(def.fields.map(f => [
    f.name, f.secret ? "" : f.initial?.(existing) ?? (f.type === "choice" ? f.options?.[0]?.value ?? "" : ""),
  ])));
  const [name, setName] = useState(existing?.name ?? "");
  const firstRef = useRef<HTMLInputElement | null>(null);
  const secretRef = useRef<HTMLInputElement | null>(null);
  const editing = Boolean(existing);
  // The choices a saved secret was made under: switching one (Cloud to
  // Server) means the saved token no longer fits, so the form says so.
  const startValues = useRef(values);
  const choicesKept = def.fields.filter(f => f.type === "choice").every(f => values[f.name] === startValues.current[f.name]);
  const keepsSecret = editing && existing!.tokenSaved && choicesKept;

  useEffect(() => {
    // Reconnect lands on an edit for a refused token: the token is what to change.
    (editing ? secretRef : firstRef).current?.focus();
  }, [editing]);

  const set = (key: string, value: string) => setValues(state => ({ ...state, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const input: Record<string, string> = {};
    for (const field of def.fields) if (shown(field, values)) input[field.name] = (values[field.name] ?? "").trim();
    onSubmit(input, name.trim());
    setValues(state => Object.fromEntries(Object.entries(state).map(([k, v]) => [k, def.fields.find(f => f.name === k)?.secret ? "" : v])));
  };

  const host = useMemo(() => {
    const raw = values.baseUrl ?? "";
    try { return raw ? new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).host : ""; } catch { return ""; }
  }, [values.baseUrl]);
  const context = useMemo(() => ({ values, existing }), [values, existing]);
  const visible = def.fields.filter(f => shown(f, values));
  const firstText = visible.find(f => !f.secret && f.type !== "choice")?.name;
  const firstSecret = visible.find(f => f.secret)?.name;

  return (
    <FormContext.Provider value={context}>
      <form className="ig-form" onSubmit={submit} aria-labelledby={`${uid}-title`} noValidate>
        <h4 className="ig-form-title" id={`${uid}-title`}>{editing ? `Edit ${existing!.name}` : `Connect ${def.label}`}</h4>

        {visible.map(raw => {
          const field = resolved(raw, values);
          const invalid = error?.field === field.name;
          const describedBy = [field.hint ? `${uid}-${field.name}-hint` : "", invalid ? `${uid}-error` : ""].filter(Boolean).join(" ") || undefined;
          if (field.type === "choice") {
            return (
              <fieldset key={field.name} className="fb-kinds" aria-invalid={invalid || undefined}>
                <legend className="vis-hidden">{field.label}</legend>
                {(field.options ?? []).map(option => (
                  <label key={option.value} className="fb-kind">
                    <input type="radio" name={`${uid}-${field.name}`} value={option.value} checked={values[field.name] === option.value}
                      onChange={() => set(field.name, option.value)}
                      onKeyDown={e => { if (isPlainEnter(e.nativeEvent)) e.preventDefault(); }} />
                    {option.label}
                  </label>
                ))}
              </fieldset>
            );
          }
          const ref = field.name === firstSecret ? secretRef : field.name === firstText ? firstRef : undefined;
          const keeps = field.secret && keepsSecret;
          return (
            <label key={field.name} className="fb-field">
              <span className="fb-field-label">{field.label}{field.optional && <span className="fb-optional"> optional</span>}</span>
              <input ref={ref} className={`ap-manage-input ig-input${field.secret ? " ig-mono" : ""}`}
                type={field.type} inputMode={field.type === "url" ? "url" : field.type === "email" ? "email" : undefined}
                autoComplete={field.autoComplete ?? "off"} spellCheck={false}
                value={values[field.name] ?? ""} onChange={e => set(field.name, e.target.value)}
                placeholder={keeps ? "Saved. Leave blank to keep it" : field.placeholder}
                aria-invalid={invalid || undefined} aria-describedby={describedBy} />
              {field.hint && <span className="ig-hint" id={`${uid}-${field.name}-hint`}>{field.hint}</span>}
            </label>
          );
        })}

        <div className="ig-help">{def.tokenHelp}</div>

        <label className="fb-field">
          <span className="fb-field-label">Name <span className="fb-optional">optional</span></span>
          <input className="ap-manage-input ig-input" type="text" autoComplete="off" maxLength={120}
            value={name} onChange={e => setName(e.target.value)} placeholder={host || def.label} />
        </label>

        {error && (
          <p className="ig-form-error" id={`${uid}-error`} role="alert">
            {error.message}
            {error.detail && <span className="ig-form-detail"> {def.label} said: {error.detail}</span>}
            {error.kind === "rate-limit" && error.retryAfter ? <span> Try again in {error.retryAfter} s.</span> : null}
          </p>
        )}

        <div className="ig-form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" aria-busy={busy}>
            {busy ? "Checking…" : editing ? "Save" : "Connect"}
          </button>
        </div>
      </form>
    </FormContext.Provider>
  );
}
