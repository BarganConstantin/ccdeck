// The Term pane's card when the terminal's engine is not here, or did not
// verify, or did not start: each step of getting it onto this machine, from
// the deck's own install (engine-install.mjs, use-engine-install.ts).
//
// ASK ONCE, NEVER BY ITSELF. A download starts only from Install the engine.
// The engine npm put beside the deck, or the desktop app's copy, is brought in
// before this card ever shows (command-panel-engine.mjs); this is the third
// source, the same package from the npm registry, or a package file.
//
// EVERY STEP SAYS WHERE IT IS AND WHAT IS NEXT. A column of a title beside its
// glyph, one paragraph, and where it helps the steps (Download, Verify,
// Install, Start) or the bar with its bytes, speed and time left; then the
// actions, with Back to the board on every screen but the ones that run by
// themselves; and a note under them. Figma's "01 · Engine install" frames.
//
// NOTHING FROM THE TERMINAL IN COPY DETAILS. It holds the step, the code, the
// platform and the versions: never a path, a key or anything typed.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../../copy-text";
import { mb, platformLabel, type EngineStatus } from "../../engine-install-api";
import { useT, type TFunction } from "../../i18n";
import { engineView, OFFLINE_RETRY_MS, useEngineInstall, useHoldThen, type EngineView } from "../../use-engine-install";
import { KitIcon, KitStateGlyph } from "../kit-icons";

/** How long Ready stays on screen before the terminal is asked for again. */
export const READY_HOLD_MS = 900;

/** The engine refusals the card answers (terminal-api's PANEL_UNAVAILABLE but
 *  no-terminal, which is the engine's own choice and not an install's). */
export const ENGINE_CARD_CODES = ["not-installed", "not-verified", "unsupported", "failed"] as const;
export const engineCardCode = (code?: string | null): boolean => (ENGINE_CARD_CODES as readonly string[]).includes(code ?? "");

type Step = { label: string; state: "done" | "now" | "todo" | "fail"; aside?: string };

function Steps({ items }: { items: Step[] }) {
  return (
    <ol className="ts-eng-steps">
      {items.map((s) => (
        <li key={s.label} className="ts-eng-step" data-state={s.state}>
          <span className="ts-eng-mark" aria-hidden="true">
            {s.state === "done" && <KitStateGlyph name="done" size={14} />}
            {s.state === "now" && <KitStateGlyph name="working" size={14} />}
            {s.state === "fail" && <KitStateGlyph name="error" size={14} />}
            {s.state === "todo" && <i className="ts-eng-ring" />}
          </span>
          <span>{s.label}</span>
          {s.aside && <span className="ts-eng-aside">{s.aside}</span>}
        </li>
      ))}
    </ol>
  );
}

function Head({ glyph, title, tone }: { glyph: "terminal" | "lock" | "warning" | "update" | "alert"; title: string; tone?: "danger" }) {
  // "alert" is Figma's circled "!" where a download stopped: the kit's info glyph turned
  // over, since the kit holds no glyph of its own for it.
  return (
    <div className="ts-eng-head">
      <span className="ts-eng-chip" data-tone={tone} aria-hidden="true">
        {glyph === "alert" ? <KitIcon name="info" className="ts-eng-alert" /> : <KitIcon name={glyph} />}
      </span>
      <h3 className="ts-eng-title">{title}</h3>
    </div>
  );
}

/** "about 4 s", "about 2 min". */
function timeLeft(t: TFunction, seconds: number): string {
  return seconds < 60
    ? t("board.engine.leftSeconds", { n: String(Math.max(1, Math.round(seconds))) })
    : t("board.engine.leftMinutes", { n: String(Math.round(seconds / 60)) });
}

/** The bytes line under the bar: "6.1 of 14.2 MB · 2.3 MB/s · about 4 s". */
export function bytesLine(t: TFunction, received: number, total: number | null, speed: number | null): string {
  const parts = [total ? t("board.stage.setupProgress", { received: mb(received), total: mb(total) }) : t("board.stage.setupReceived", { received: mb(received) })];
  if (speed && speed > 0) {
    parts.push(t("board.engine.speed", { speed: mb(speed) }));
    if (total && total > received) parts.push(timeLeft(t, (total - received) / speed));
  }
  return parts.join(" · ");
}

/** What Copy details holds: the step, the code and the versions. */
export function engineDetails(status: EngineStatus | null | undefined, view: EngineView, code?: string | null): string {
  const lines = [`platform: ${status?.platform ?? "unknown"}`, `ccdeck: ${status?.app ?? "unknown"}`];
  lines.push(`engine pinned: ${status?.pinned ?? "none"}`, `engine installed: ${status?.installed?.version ?? "none"}`);
  if (view.state === "check" || view.state === "failed") lines.push(`step: ${view.step}`);
  if (view.state === "check") lines.push(`code: ${view.code}`);
  if (code) lines.push(`refusal: ${code}`);
  if (status?.last?.outcome === "failed") lines.push(`last: ${status.last.code} at ${status.last.step}`);
  return lines.join("\n");
}

function Bar({ share, label, line, tone }: { share: number | null; label: string; line: string; tone?: "danger" }) {
  return (
    <div className="ts-eng-progress">
      <div
        className="ts-setup-bar ts-eng-bar" data-tone={tone} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={share == null ? undefined : Math.round(share * 100)} aria-valuetext={line}
        data-unknown={share == null || undefined}
      >
        <i className="ts-setup-fill" style={share == null ? undefined : { transform: `scaleX(${share})` }} />
      </div>
      <span className="ts-eng-mono">{line}</span>
    </div>
  );
}

export interface EngineCardProps {
  /** The engine's refusal that brought the card (ENGINE_CARD_CODES). */
  code: string;
  /** The deck's own sentence, for when the install cannot say more. */
  message: ReactNode;
  /** The stage is asking again (its Check again). */
  busy?: boolean;
  onRetry(): void;
  onNotNow(): void;
  /** The stage's own card, drawn when the deck cannot say anything of its install. */
  plain: ReactNode;
}

export default function EngineCard(p: EngineCardProps) {
  const t = useT();
  const eng = useEngineInstall(true);
  const [retried, setRetried] = useState(false);
  const [copied, setCopied] = useState<"details" | "fix" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const view = engineView({ status: eng.status, code: p.code, mine: eng.mine, watched: eng.watched, retried });
  const { onRetry } = p;

  // Ready, or an install cut short and put right: the terminal is asked for
  // again by itself, once (useHoldThen: the stage's onRetry is new each render).
  const auto = view.state === "ready" || view.state === "recovered";
  useHoldThen(auto && !retried, READY_HOLD_MS, () => { setRetried(true); onRetry(); });

  // Offline: tried again while the card is open, now and then and when the
  // browser says the network is back.
  const offline = view.state === "offline";
  const { install } = eng;
  useEffect(() => {
    if (!offline) return;
    const again = () => { void install(); };
    const timer = setInterval(again, OFFLINE_RETRY_MS);
    window.addEventListener("online", again);
    return () => { clearInterval(timer); window.removeEventListener("online", again); };
  }, [offline, install]);

  const status = eng.status ?? null;
  const platform = platformLabel(status?.platform ?? "");
  const copy = async (what: "details" | "fix", text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    }
  };
  const back = <button type="button" className="btn ts-eng-back" onClick={p.onNotNow}>{t("board.engine.back")}</button>;
  const fileButton = (primary = false) => (
    <>
      <button type="button" className={primary ? "btn primary" : "btn"} aria-busy={eng.pending || undefined} onClick={() => fileRef.current?.click()}>
        {t("board.engine.installFile")}
      </button>
      <input
        ref={fileRef} type="file" hidden accept=".tgz,application/gzip,application/x-gzip,application/octet-stream"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void eng.installFile(file);
        }}
      />
    </>
  );
  const tryAgain = (onClick: () => void, primary = true) => (
    <button type="button" className={primary ? "btn primary" : "btn"} data-stage-land aria-busy={(eng.pending || p.busy) || undefined} onClick={onClick}>
      {t("board.stage.tryAgain")}
    </button>
  );
  const detailsButton = (
    <button type="button" className="btn" onClick={() => { void copy("details", engineDetails(eng.status, view, p.code)); }}>
      {copied === "details" ? t("board.stage.copied") : t("board.engine.copyDetails")}
    </button>
  );

  let body: ReactNode;
  switch (view.state) {
    case "plain":
      return <>{p.plain}</>;
    case "checking":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.checkingTitle")} />
          <Steps items={[{ label: t("board.engine.checkingLine"), state: "now" }]} />
        </>
      );
      break;
    case "ask": {
      const version = status?.pinned ?? "";
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.askTitle")} />
          <p className="ts-eng-text">
            {view.download
              ? t("board.engine.askBody", { app: status?.app ?? "", platform, version })
              : t("board.engine.askBodyFile", { app: status?.app ?? "", platform })}
          </p>
          {eng.refused && <p className="ts-eng-said" role="status">{t("board.engine.refused")}</p>}
          <div className="ts-eng-acts">
            {view.download && (
              <button type="button" className="btn primary" data-stage-land aria-busy={eng.pending || undefined} onClick={() => { void eng.install(); }}>
                {t("board.engine.install")}
              </button>
            )}
            {view.file && fileButton(!view.download)}
            {back}
          </div>
          <p className="ts-eng-note">{view.downloadOff ? t("board.engine.downloadOff") : view.download ? t("board.engine.askNote") : t("board.engine.fileNote")}</p>
        </>
      );
      break;
    }
    case "downloading": {
      const { job } = view;
      const share = job.total ? Math.min(1, job.received / job.total) : null;
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.downloadingTitle")} />
          <Bar share={share} label={t("board.engine.downloadingTitle")} line={bytesLine(t, job.received, job.total, eng.speed)} />
          <Steps items={[
            { label: t("board.engine.stepDownload"), state: "now", ...(share == null ? {} : { aside: `${Math.round(share * 100)}%` }) },
            { label: t("board.engine.stepVerify"), state: "todo" },
            { label: t("board.engine.stepInstall"), state: "todo" },
            { label: t("board.engine.stepStart"), state: "todo" },
          ]} />
          <div className="ts-eng-acts">
            <button type="button" className="btn" data-stage-land aria-busy={eng.pending || undefined} onClick={() => { void eng.cancel(); }}>{t("common.cancel")}</button>
          </div>
        </>
      );
      break;
    }
    case "verifying": {
      const { job } = view;
      const installing = job.phase === "installing";
      body = (
        <>
          <Head glyph="terminal" title={t(installing ? "board.engine.installingTitle" : "board.engine.verifyingTitle")} />
          <p className="ts-eng-mono">{job.source === "file" ? t("board.engine.fromFile") : t("board.engine.downloaded", { size: mb(job.received) })}</p>
          <Steps items={[
            { label: t("board.engine.stepDownload"), state: "done", ...(job.received ? { aside: `${mb(job.received)} MB` } : {}) },
            { label: t("board.engine.stepSignature"), state: installing ? "done" : "now" },
            { label: t("board.engine.stepPlatform"), state: installing ? "done" : "todo" },
            { label: t("board.engine.stepInstall"), state: installing ? "now" : "todo" },
          ]} />
        </>
      );
      break;
    }
    case "ready":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.readyTitle")} />
          <p className="ts-eng-text" role="status">{t("board.engine.readyBody", { version: view.version ?? "" })}</p>
          <Steps items={[
            { label: t("board.engine.stepDownload"), state: "done" },
            { label: t("board.engine.stepSignature"), state: "done" },
            { label: t("board.engine.stepPlatform"), state: "done" },
            { label: t("board.engine.stepInstall"), state: "done", aside: t("board.engine.inDataFolder") },
          ]} />
        </>
      );
      break;
    case "offline":
      body = (
        <>
          <Head glyph="alert" tone="danger" title={t("board.engine.offlineTitle")} />
          <p className="ts-eng-text">
            {view.received > 0 && view.total
              ? t("board.engine.offlineBody", { received: mb(view.received), total: mb(view.total) })
              : t("board.engine.offlineBodyNone")}
          </p>
          {view.received > 0 && view.total ? (
            <Bar
              tone="danger" share={Math.min(1, view.received / view.total)} label={t("board.engine.offlineTitle")}
              line={t("board.engine.stoppedAt", { received: mb(view.received), total: mb(view.total) })}
            />
          ) : null}
          <div className="ts-eng-acts">{tryAgain(() => { void eng.install(); })}{status?.canInstallFile && fileButton()}{back}</div>
          <p className="ts-eng-note">{t("board.engine.offlineNote")}</p>
        </>
      );
      break;
    case "permission": {
      const fix = view.fixPath ? `sudo chown -R "$(id -un)" ${view.fixPath}` : null;
      body = (
        <>
          <Head glyph="lock" tone="danger" title={t("board.engine.permissionTitle")} />
          <p className="ts-eng-text">{t("board.engine.permissionBody")}</p>
          <div className="ts-eng-acts">
            {tryAgain(() => { void eng.install(); })}
            {fix && (
              <button type="button" className="btn" onClick={() => { void copy("fix", fix); }}>
                {copied === "fix" ? t("board.stage.copied") : t("board.engine.copyFix")}
              </button>
            )}
            {back}
          </div>
          {fix && <p className="ts-eng-note">{t("board.engine.permissionNote")}</p>}
        </>
      );
      break;
    }
    case "unsupported":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.unsupportedTitle", { platform })} />
          <p className="ts-eng-text">{t("board.engine.unsupportedBody")}</p>
          <div className="ts-eng-acts">{back}</div>
          <p className="ts-eng-note">{t("board.engine.unsupportedNote")}</p>
        </>
      );
      break;
    case "unavailable":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.unavailableTitle")} />
          <p className="ts-eng-text">{t("board.engine.unavailableBody", { platform })}</p>
          <div className="ts-eng-acts">{view.file && fileButton()}{back}</div>
        </>
      );
      break;
    case "check":
      body = (
        <>
          <Head glyph="warning" tone="danger" title={t("board.engine.checkTitle")} />
          <p className="ts-eng-text">
            {t(view.code === "wrong-machine" ? "board.engine.wrongMachineBody" : view.code === "downgrade" ? "board.engine.downgradeBody" : "board.engine.checkBody")}
          </p>
          <Steps items={[
            { label: t("board.engine.stepDownload"), state: "done" },
            { label: t("board.engine.stepSignature"), state: "fail", aside: t("board.engine.noMatch") },
            { label: t("board.engine.stepInstall"), state: "todo" },
            { label: t("board.engine.stepStart"), state: "todo" },
          ]} />
          <div className="ts-eng-acts">{tryAgain(() => { void eng.install(); })}{detailsButton}{back}</div>
          <p className="ts-eng-note">{t("board.engine.checkNote")}</p>
        </>
      );
      break;
    case "update":
      body = (
        <>
          <Head glyph="update" title={t("board.engine.updateTitle")} />
          <p className="ts-eng-text">{t("board.engine.updateBody", { installed: view.installed, app: status?.app ?? "", pinned: view.pinned })}</p>
          <div className="ts-eng-acts">
            {view.download && (
              <button type="button" className="btn primary" data-stage-land aria-busy={eng.pending || undefined} onClick={() => { void eng.install(); }}>
                {t("board.engine.installUpdate")}
              </button>
            )}
            {view.file && fileButton(!view.download)}
            {back}
          </div>
          <p className="ts-eng-note">{t("board.engine.updateNote", { pinned: view.pinned })}</p>
        </>
      );
      break;
    case "elsewhere":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.elsewhereTitle")} />
          <p className="ts-eng-text" role="status">{t("board.engine.elsewhereBody")}</p>
          {view.job && view.job.phase === "downloading" && (
            <Bar
              share={view.job.total ? Math.min(1, view.job.received / view.job.total) : null}
              label={t("board.engine.elsewhereTitle")}
              line={bytesLine(t, view.job.received, view.job.total, null)}
            />
          )}
          <div className="ts-eng-acts">{back}</div>
        </>
      );
      break;
    case "recovered":
      body = (
        <>
          <Head glyph="terminal" title={t("board.engine.recoveredTitle")} />
          <p className="ts-eng-text" role="status">{t("board.engine.recoveredBody")}</p>
          <Steps items={[
            { label: t("board.engine.stepPartial"), state: "done" },
            { label: t("board.engine.stepInPlace"), state: "now", aside: view.version },
            { label: t("board.engine.stepStart"), state: "todo" },
          ]} />
        </>
      );
      break;
    case "start-failed":
      body = (
        <>
          <Head glyph="warning" tone="danger" title={t("board.engine.startFailedTitle")} />
          <p className="ts-eng-text">{t("board.engine.startFailedBody")}</p>
          <div className="ts-eng-acts">{tryAgain(onRetry)}{detailsButton}{back}</div>
          <p className="ts-eng-note">{t("board.engine.startFailedNote")}</p>
        </>
      );
      break;
    case "no-space":
      body = (
        <>
          <Head glyph="warning" tone="danger" title={t("board.engine.spaceTitle")} />
          <p className="ts-eng-text">{t("board.engine.spaceBody")}</p>
          <div className="ts-eng-acts">{tryAgain(() => { void eng.install(); })}{back}</div>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <Head glyph="warning" tone="danger" title={t("board.engine.failedTitle")} />
          <p className="ts-eng-text">{t("board.engine.failedBody")}</p>
          <div className="ts-eng-acts">{tryAgain(() => { void eng.install(); })}{detailsButton}{back}</div>
        </>
      );
      break;
  }
  return (
    <div className="ts-card ts-engine" data-engine={view.state}>
      <div className="ts-eng">{body}</div>
    </div>
  );
}
