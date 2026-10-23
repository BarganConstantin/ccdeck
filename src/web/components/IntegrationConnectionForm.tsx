// The form that connects a tracker, or edits a connection (#2178), drawn from
// the provider's field list (integrations/registry.ts): an address, a token,
// whatever else the provider asks for, and a name — with the provider's own
// words on what the token is and where to make one.
//
// A secret field is never filled in. Editing starts it empty, and empty keeps
// the saved value (the server reads it so); a new value replaces it. What was
// typed into a secret field is dropped as soon as the form is sent.
//
// Each field is named by its label alone; its hint, and the reason a send was
// refused, are its description. A refusal that names a field is said under
// that field and takes focus there, so the reader lands where the fix is; one
// that names none is said above Cancel and Connect.
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
  onDirtyChange?: (dirty: boolean) => void;
}

/** A field as it reads with the values typed so far. */
function resolved(field: FieldDef, values: Readonly<Record<string, string>>): FieldDef {
  const v = field.variants;
  return v ? { ...field, ...(v.by[values[v.field] ?? ""] ?? {}) } : field;
}

const shown = (field: FieldDef, values: Readonly<Record<string, string>>) =>
  !field.when || field.when.is.includes(values[field.when.field] ?? "");

export default function IntegrationConnectionForm({ def, existing, busy, error, onSubmit, onCancel, onDirtyChange }: IntegrationConnectionFormProps) {
  const uid = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(def.fields.map(f => [
    f.name, f.secret ? "" : f.initial?.(existing) ?? (f.type === "choice" ? f.options?.[0]?.value ?? "" : ""),
  ])));
  const [name, setName] = useState(existing?.name ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const editing = Boolean(existing);
  // The choices a saved secret was made under: switching one (Cloud to
  // Server) means the saved token no longer fits, so the form says so.
  const startValues = useRef(values);
  const startName = useRef(name);
  useEffect(() => {
    onDirtyChange?.(name !== startName.current || Object.keys(values).some(key => values[key] !== startValues.current[key]));
  }, [name, values, onDirtyChange]);
  const choicesKept = def.fields.filter(f => f.type === "choice").every(f => values[f.name] === startValues.current[f.name]);
  const keepsSecret = editing && existing!.tokenSaved && choicesKept;

  const set = (key: string, value: string) => { if (!busy) setValues(state => ({ ...state, [key]: value })); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const input: Record<string, string> = {};
    for (const field of def.fields) if (shown(field, values)) input[field.name] = (values[field.name] ?? "").trim();
    // Keyboard Enter can submit from a field that becomes disabled while checking.
    // Keep focus on the surviving busy action, visible even in a short pane.
    event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
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
  // The field a refusal names, when it is one on show that can take focus.
  const errorField = error?.field && visible.some(f => f.name === error.field && f.type !== "choice") ? error.field : null;
  const errorId = `${uid}-error`;

  useEffect(() => {
    // Reconnect lands on an edit for a refused token: the token is what to change.
    const first = editing ? firstSecret : firstText ?? firstSecret;
    if (first) inputs.current.get(first)?.focus();
    formRef.current?.scrollIntoView?.({ block: "nearest" });
    // On mount only: the fields on show then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (errorField) inputs.current.get(errorField)?.focus();
  }, [error, errorField]);

  const errorWords = error && <>
    {error.message}
    {error.detail && <span className="ig-form-detail"> {def.label} said: {error.detail}</span>}
    {error.kind === "rate-limit" && error.retryAfter ? <span> Try again in {error.retryAfter} s.</span> : null}
  </>;

  return (
    <FormContext.Provider value={context}>
      <form ref={formRef} className="ig-form" onSubmit={submit} aria-labelledby={`${uid}-title`} noValidate>
        <header className="ig-managed-header">
          <span className="ig-provider-glyph" aria-hidden><def.Glyph /></span>
          <div className="ig-managed-identity">
            <h2 className="ig-form-title" id={`${uid}-title`}>{editing ? `Edit ${existing!.name}` : `Connect ${def.label}`}</h2>
            {editing && <p>{def.label} connection</p>}
          </div>
        </header>

        {visible.map(raw => {
          const field = resolved(raw, values);
          const invalid = error?.field === field.name;
          const describedBy = [field.hint ? `${uid}-${field.name}-hint` : "", invalid ? errorId : ""].filter(Boolean).join(" ") || undefined;
          if (field.type === "choice") {
            return (
              <fieldset key={field.name} className="fb-kinds" aria-invalid={invalid || undefined}>
                <legend className="vis-hidden">{field.label}</legend>
                {(field.options ?? []).map(option => (
                  <label key={option.value} className="fb-kind">
                    <input type="radio" name={`${uid}-${field.name}`} value={option.value} checked={values[field.name] === option.value}
                      aria-disabled={busy || undefined} onChange={() => set(field.name, option.value)}
                      onKeyDown={e => { if (isPlainEnter(e.nativeEvent)) e.preventDefault(); }} />
                    {option.label}
                  </label>
                ))}
              </fieldset>
            );
          }
          const keeps = field.secret && keepsSecret;
          const id = `${uid}-${field.name}`;
          return (
            <div key={field.name} className="fb-field">
              <label className="fb-field-label" htmlFor={id}>{field.label}{field.optional && <span className="fb-optional"> optional</span>}</label>
              <input id={id} className={`ap-manage-input ig-input${field.secret ? " ig-mono" : ""}`}
                ref={el => { if (el) inputs.current.set(field.name, el); else inputs.current.delete(field.name); }}
                type={field.type} inputMode={field.type === "url" ? "url" : field.type === "email" ? "email" : undefined}
                autoComplete={field.autoComplete ?? "off"} spellCheck={false}
                value={values[field.name] ?? ""} onChange={e => set(field.name, e.target.value)}
                placeholder={keeps ? "Saved. Leave blank to keep it" : field.placeholder}
                readOnly={busy} aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-required={!field.optional && !keeps || undefined} />
              {field.hint && <span className="ig-hint" id={`${uid}-${field.name}-hint`}>{field.hint}</span>}
              {invalid && errorField === field.name && <span className="ig-form-error" id={errorId} role="alert">{errorWords}</span>}
            </div>
          );
        })}

        <details className="ig-help ig-token-help">
          <summary>How to create a {def.label} token</summary>
          {def.tokenHelp}
        </details>

        <div className="fb-field">
          <label className="fb-field-label" htmlFor={`${uid}-name`}>Name <span className="fb-optional">optional</span></label>
          <input id={`${uid}-name`} className="ap-manage-input ig-input" type="text" autoComplete="off" maxLength={120}
            readOnly={busy} value={name} onChange={e => setName(e.target.value)} placeholder={host || def.label} />
        </div>

        {error && !errorField && <p className="ig-form-error" id={errorId} role="alert">{errorWords}</p>}

        <div className="ig-form-actions">
          <button type="submit" className="btn primary" aria-disabled={busy} aria-busy={busy}>
            {busy ? "Checking…" : editing ? "Save" : "Connect"}
          </button>
          <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
        </div>
      </form>
    </FormContext.Provider>
  );
}
