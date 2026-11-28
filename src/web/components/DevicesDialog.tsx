import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useT, type MessageKey } from "../i18n";
import { Dialog, DialogHeader } from "./Dialog";
import { Loader } from "./Loader";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import type { Row } from "./SessionList";

type Device = {
  id: string;
  name: string;
  alias?: string;
  host?: string;
  user?: string;
  port?: number;
  link: { state: "offline" | "connecting" | "connected" };
};
type RemoteSession = {
  key: string;
  name: string | null;
  project: string | null;
  provider: string | null;
  state: "working" | "waiting" | "ended" | "idle";
};
type Draft = { name?: string } & ({ alias: string } | { host: string; user: string; port?: number });
type Reply = {
  ok: boolean;
  type?: string;
  error?: string;
  confirm?: string;
  keys?: { keyType: string; fingerprint: string }[];
  devices?: Device[];
  device?: Device;
  sessions?: RemoteSession[];
};

async function request(path: string, signal: AbortSignal, body?: object): Promise<Reply> {
  try {
    const response = await fetch(`/api/devices${path}`, body ? {
      method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : { signal, cache: "no-store" });
    const reply = await response.json() as Reply;
    return response.ok ? reply : { ok: false, error: reply.error };
  } catch {
    return { ok: false };
  }
}

const errorKeys: Record<string, MessageKey> = {
  auth_failed: "board.devices.auth",
  unreachable: "board.devices.unreachable",
  no_remote_ccdeck: "board.devices.remote",
  version_too_old: "board.devices.update",
  ssh_missing: "board.devices.sshMissing",
  host_key_changed: "board.devices.keyChanged",
  trust_expired: "board.devices.expired",
  duplicate: "board.devices.duplicate",
  invalid: "board.devices.invalid",
};
const remoteStates: Record<RemoteSession["state"], MessageKey> = {
  idle: "board.stage.phrase.idle",
  working: "board.stage.phrase.working",
  waiting: "board.list.waiting",
  ended: "board.stage.phrase.ended",
};
const destination = ({ alias, user, host, port }: Device) => alias ?? `${user}@${host}${port ? `:${port}` : ""}`;
const providerName = (value: string | null | undefined) => value === "claude" ? "Claude Code" : value === "codex" ? "Codex" : value;

export default function DevicesDialog({ local, onOpenLocal, onClose }: {
  local: Row[];
  onOpenLocal: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useModalDismiss(onClose);
  const scrim = useScrimDismiss(onClose);
  const operation = useRef<AbortController | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const trustCancel = useRef<HTMLButtonElement>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [adding, setAdding] = useState(false);
  const [addressType, setAddressType] = useState<"alias" | "host">("alias");
  const [challenge, setChallenge] = useState<{ reply: Reply; draft?: Draft; device?: Device } | null>(null);
  const remote = devices.find(device => device.id === selected);

  useEffect(() => {
    if (challenge) trustCancel.current?.focus();
    else if (adding) nameField.current?.focus();
  }, [adding, challenge]);

  function start() {
    if (operation.current) return null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    setChallenge(null);
    return controller.signal;
  }
  function finish(signal: AbortSignal) {
    if (signal.aborted) return;
    operation.current = null;
    setBusy(false);
  }
  function report(reply: Reply) {
    setError(errorKeys[reply.error ?? reply.type ?? ""] ?? "board.devices.failed");
  }
  async function refresh(signal: AbortSignal) {
    const reply = await request("", signal);
    if (!signal.aborted && reply.ok) setDevices(reply.devices ?? []);
    return reply;
  }
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    void refresh(controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      if (!reply.ok) report(reply);
      finish(controller.signal);
    });
    return () => operation.current?.abort();
  }, []);

  function select(id: string | null) {
    if (operation.current) return false;
    setSelected(id);
    setSessions(null);
    setAdding(false);
    setChallenge(null);
    setError(null);
    return true;
  }

  async function read(device: Device, signal: AbortSignal) {
    const reply = await request(`/sessions?${new URLSearchParams({ id: device.id })}`, signal);
    if (signal.aborted) return;
    if (reply.ok) setSessions(reply.sessions ?? []);
    else {
      setSessions(null);
      if (reply.type === "host_key_unknown") setChallenge({ reply, device });
      else report(reply);
    }
    await refresh(signal);
  }

  async function save(draft: Draft, signal: AbortSignal) {
    const reply = await request("/add", signal, draft);
    if (signal.aborted) return;
    if (!reply.ok || !reply.device) { report(reply); return; }
    const device = reply.device;
    setDevices(current => [...current.filter(entry => entry.id !== device.id), device]);
    setSelected(device.id);
    setAdding(false);
    setSessions(null);
    await read(device, signal);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = (name: string) => String(data.get(name) ?? "").trim();
    const name = input("name") || undefined;
    const draft: Draft = addressType === "alias" ? { name, alias: input("alias") } : {
      name, host: input("host"), user: input("user"), port: input("port") ? Number(input("port")) : undefined,
    };
    const signal = start();
    if (!signal) return;
    const reply = await request("/test", signal, { draft });
    if (signal.aborted) return;
    if (reply.ok) await save(draft, signal);
    else if (reply.type === "host_key_unknown") setChallenge({ reply, draft });
    else report(reply);
    finish(signal);
  }

  async function trust() {
    if (!challenge?.reply.confirm) return;
    const { reply, draft, device } = challenge;
    const signal = start();
    if (!signal) return;
    const result = await request("/trust", signal, { confirm: reply.confirm });
    if (signal.aborted) return;
    if (result.ok && draft) await save(draft, signal);
    else if (result.ok && device) await read(device, signal);
    else report(result);
    finish(signal);
  }

  async function connect(device: Device) {
    const signal = start();
    if (!signal) return;
    await read(device, signal);
    finish(signal);
  }

  async function disconnect(device: Device) {
    const signal = start();
    if (!signal) return;
    const reply = await request("/disconnect", signal, { id: device.id });
    if (signal.aborted) return;
    if (reply.ok) { setSessions(null); await refresh(signal); }
    else report(reply);
    finish(signal);
  }

  const title = t("board.devices.title");
  return createPortal(
    <Dialog scrim={scrim} dialogRef={dialogRef} className="devices-dialog" labelledBy="devices-dialog-title">
      <DialogHeader titleId="devices-dialog-title" title={title} onClose={onClose} closeLabel={t("common.close")} />
      <div className="devices-layout">
        <div className="devices-list">
          <ul>
            <li><Button variant="ghost" className="devices-device" aria-current={!adding && !selected ? "true" : undefined}
              aria-disabled={busy || undefined} onClick={() => select(null)}>{t("board.devices.local")}</Button></li>
            {devices.map(device => (
              <li key={device.id}>
                <Button variant="ghost" className="devices-device" aria-current={!adding && selected === device.id ? "true" : undefined}
                  aria-disabled={busy || undefined} onClick={() => select(device.id)}>
                  <span>{device.name}</span>
                  <small>{t(`board.devices.${device.link.state}`)}</small>
                </Button>
              </li>
            ))}
          </ul>
          <button className="btn" type="button" aria-disabled={busy || undefined} onClick={() => { if (select(null)) setAdding(true); }}>{t("board.devices.add")}</button>
        </div>
        <section className="devices-content">
          {adding ? <>
            <h3>{t("board.devices.add")}</h3>
            <form className="devices-form" hidden={challenge !== null} onSubmit={submit}>
              <fieldset>
                <label>{t("board.devices.name")}<Input ref={nameField} name="name" maxLength={64} /></label>
                <div className="devices-address">
                  <span id="devices-address-label">{t("board.devices.address")}</span>
                  <div role="group" aria-labelledby="devices-address-label">
                    <Button aria-pressed={addressType === "alias"} aria-disabled={busy || undefined}
                      onClick={() => { if (!operation.current) setAddressType("alias"); }}>{t("board.devices.alias")}</Button>
                    <Button aria-pressed={addressType === "host"} aria-disabled={busy || undefined}
                      onClick={() => { if (!operation.current) setAddressType("host"); }}>{t("board.devices.host")}</Button>
                  </div>
                </div>
                {addressType === "alias" ? <label>{t("board.devices.alias")}<Input name="alias" required autoCapitalize="none" spellCheck={false} /></label> : <>
                  <label>{t("board.devices.host")}<Input name="host" required autoCapitalize="none" spellCheck={false} /></label>
                  <label>{t("board.devices.user")}<Input name="user" required autoCapitalize="none" spellCheck={false} /></label>
                  <label>{t("board.devices.port")}<Input name="port" type="number" min={1} max={65535} placeholder="22" /></label>
                </>}
                <button className="btn primary" type="submit" aria-disabled={busy || undefined}>{t("board.devices.testSave")}</button>
              </fieldset>
            </form>
          </> : remote ? <>
            <div className="devices-heading">
              <div><h3>{remote.name}</h3><p>{destination(remote)}</p></div>
              <div className="devices-actions">
                {remote.link.state === "connected" && <button className="btn" type="button" aria-disabled={busy || !!challenge || undefined}
                  onClick={() => { if (!challenge) void disconnect(remote); }}>{t("board.devices.disconnect")}</button>}
                <button className="btn primary" type="button" aria-disabled={busy || !!challenge || undefined} onClick={() => { if (!challenge) void connect(remote); }}>
                  {t(sessions ? "board.devices.refresh" : "board.devices.connect")}
                </button>
              </div>
            </div>
            {sessions?.length ? <ul className="devices-sessions">
              {sessions.map(row => <li key={row.key}>
                <div><strong>{row.name ?? row.project ?? t("board.devices.session")}</strong>
                  <p>{[providerName(row.provider), row.project].filter(Boolean).join(" · ")}</p></div>
                <span>{t(remoteStates[row.state])}</span>
              </li>)}
            </ul> : !busy && !challenge && !error && <p>{t(sessions ? "board.devices.empty" : "board.devices.connectHint")}</p>}
          </> : <>
            <h3>{t("board.devices.local")}</h3>
            {local.length ? <ul className="devices-sessions">
              {local.map(row => <li key={row.sessionId}>
                <Button variant="ghost" className="devices-local-session" onClick={() => onOpenLocal(row.sessionId)}>
                  <strong>{row.label}</strong>
                  <span>{[providerName(row.provider), row.folder].filter(Boolean).join(" · ")}</span>
                </Button>
              </li>)}
            </ul> : !busy && <p>{t("board.devices.empty")}</p>}
          </>}
          {challenge && <div className="devices-trust">
            <h3>{t("board.devices.verify")}</h3>
            <p>{t("board.devices.verifyHint")}</p>
            <ul>{challenge.reply.keys?.map(key => <li key={key.fingerprint}><code>{key.keyType} {key.fingerprint}</code></li>)}</ul>
            <div className="devices-actions">
              <button ref={trustCancel} className="btn" type="button" onClick={() => setChallenge(null)}>{t("common.cancel")}</button>
              <button className="btn primary" type="button" disabled={!challenge.reply.confirm || !challenge.reply.keys?.length} onClick={() => void trust()}>
                {t("board.devices.trust")}
              </button>
            </div>
          </div>}
          {busy && <p className="loader-line" role="status"><Loader />{t("board.devices.connecting")}</p>}
          {error && <p className="devices-error" role="alert">{t(error)}</p>}
        </section>
      </div>
    </Dialog>, document.body,
  );
}
