// Continue, for a turn that stopped on an expired login or a usage limit
// (#2193): the button on a stopped background session's card, the line a
// continue leaves on the card, and the detail panel's section.
//
// Every one reads the store use-stop-continue.ts keeps, in the leaf that draws
// it, so an answer from the server re-renders these and nothing else on the
// card (#873). What the deck runs is src/server/stop-continue.mjs's; when it
// may run is src/server/stop-continue-gate.mjs's, asked again by the server on
// every press.
import { useCallback, useState } from "react";
import { copyText } from "../copy-text";
import { selfPressProps } from "../panel-press";
import type { AgentNodeData } from "../types";
import { useNow } from "../use-now";
import {
  CONTINUED_SHOWN_MS, continueView, pressContinue, useStopContinueSnapshot, type ContinueView,
} from "../use-stop-continue";
import {
  autoSentence, continueCommands, gateSentence, interactiveSentence, outcomeLabel, outcomeTooltip,
} from "../stop-continue-copy";

type Bearing = Pick<AgentNodeData, "kind" | "sessionId" | "stopFailure" | "job" | "provider">;

/** Why the button is what it is, as its tooltip: what it will do, or why not
 *  yet, then what the automatic continue will do, then how the last one went. */
function buttonTitle(v: ContinueView, now: number): string {
  const lines = [
    v.pressing ? "Continuing…"
      : !v.loaded ? "Checking for a working login…"
        : v.gate.ready ? "Run the turn that failed again, in place, through Claude Code's background commands."
          : gateSentence(v.gate.reason),
    v.stop ? autoSentence({ auto: v.auto, kind: v.stop.kind, held: v.held, tried: v.tried }) : "",
    v.last && v.stop && v.last.at >= v.stop.at ? `${outcomeLabel(v.last, now)}. ${outcomeTooltip(v.last)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The press, shared by the card and the panel. */
function usePress(v: ContinueView | null, sessionId: string) {
  return useCallback(() => {
    if (!v?.stop || !v.gate.ready || v.pressing) return;
    void pressContinue(sessionId, v.stop);
  }, [v, sessionId]);
}

/**
 * The card's button, inside the stop row, for a background session only — an
 * interactive one is a terminal the deck cannot type into, and its row's
 * tooltip already says to type "continue" there.
 *
 * Disabled until the gate is ready, with the reason as its title. React Flow
 * runs the node's click for a press on any button inside it, so the click is
 * stopped here, as the context donut's is.
 */
export function CardContinue({ data }: { data: Bearing }) {
  const s = useStopContinueSnapshot();
  const now = useNow(15_000);
  const v = continueView(data, s);
  const press = usePress(v, data.sessionId);
  if (!v?.stop || !v.background) return null;
  // A press never disables its own button (#518, panel-press.ts): it says it
  // is busy, and pressContinue refuses a second one.
  return (
    <button
      type="button"
      className="stop-continue"
      {...selfPressProps(v.pressing, !(v.loaded && v.gate.ready))}
      title={buttonTitle(v, now)}
      onClick={e => { e.stopPropagation(); press(); }}
    >{v.pressing ? "Continuing…" : "Continue"}</button>
  );
}

/**
 * The line a continue leaves on a card that is no longer stopped: "Continued
 * automatically 2m ago", for half an hour. A stopped card says it in its stop
 * row's tooltip instead.
 */
export function ContinuedRow({ data }: { data: Bearing }) {
  const s = useStopContinueSnapshot();
  const now = useNow(15_000);
  const v = continueView(data, s);
  if (!v || v.stop || !v.last || now - v.last.at > CONTINUED_SHOWN_MS) return null;
  return (
    <div className={`continued-row${v.last.ok ? "" : " failed"}`} title={outcomeTooltip(v.last)}>
      <span className="waiting-dot" aria-hidden />
      <span className="continued-said">{outcomeLabel(v.last, now)}</span>
    </div>
  );
}

/**
 * The detail panel's section: what Continue will do and whether it can yet,
 * the button, how the last continue went, and the commands it runs — the one
 * surface with room for all of it.
 */
export function StopContinueSection({ agent }: { agent: AgentNodeData }) {
  const s = useStopContinueSnapshot();
  const now = useNow(15_000);
  const v = continueView(agent, s);
  const press = usePress(v, agent.sessionId);
  const [copied, setCopied] = useState<"word" | "commands" | null>(null);
  const copy = useCallback(async (what: "word" | "commands", text: string) => {
    if (!(await copyText(text))) return; // still on screen and selectable
    setCopied(what);
    window.setTimeout(() => setCopied(c => (c === what ? null : c)), 1600);
  }, []);
  if (!v) return null;

  const lastLine = v.last && (!v.stop || v.last.at >= v.stop.at) && now - v.last.at <= CONTINUED_SHOWN_MS
    ? <p className={`detail-continue-last${v.last.ok ? "" : " failed"}`} title={outcomeTooltip(v.last)}>
        {outcomeLabel(v.last, now)}. {outcomeTooltip(v.last)}
      </p>
    : null;

  if (!v.stop) {
    return lastLine ? <section className="detail-section"><h3>Continue</h3>{lastLine}</section> : null;
  }

  const gateLine = !v.loaded ? "Checking for a working login…"
    : v.gate.ready ? (v.stop.kind === "api-error" ? "" : "A working login with room is active now.")
      : gateSentence(v.gate.reason);

  if (!v.background) {
    return (
      <section className="detail-section">
        <h3>Continue</h3>
        <p className="detail-recap">{interactiveSentence(v.stop.kind)}</p>
        {gateLine && <p className="detail-continue-state">{gateLine}</p>}
        <div className="detail-continue-actions">
          <button type="button" className="btn detail-continue-btn" onClick={() => { void copy("word", "continue"); }}>
            {copied === "word" ? "Copied" : "Copy “continue”"}
          </button>
        </div>
      </section>
    );
  }

  const auto = autoSentence({ auto: v.auto, kind: v.stop.kind, held: v.held, tried: v.tried });
  const commands = v.jobId ? continueCommands(v.jobId, agent.sessionId) : null;
  return (
    <section className="detail-section">
      <h3>Continue</h3>
      <p className="detail-recap">
        A background session: ccdeck can run the turn that failed again, in place, through Claude Code's own background commands.
      </p>
      {gateLine && <p className="detail-continue-state">{gateLine}</p>}
      {auto && <p className="detail-continue-state">{auto}</p>}
      {lastLine}
      <div className="detail-continue-actions">
        <button type="button" className="btn primary detail-continue-btn" {...selfPressProps(v.pressing, !(v.loaded && v.gate.ready))} title={buttonTitle(v, now)} onClick={press}>
          {v.pressing ? "Continuing…" : "Continue"}
        </button>
      </div>
      {commands && (
        <details className="detail-continue-how">
          <summary>The commands it runs</summary>
          <pre className="detail-continue-cmd"><code>{commands}</code></pre>
          <p className="detail-continue-note">The stop runs only while its process is alive and idle, and the resume only once Claude Code lists no live process for it.</p>
          <button type="button" className="btn detail-continue-btn" onClick={() => { void copy("commands", commands); }}>
            {copied === "commands" ? "Copied" : "Copy"}
          </button>
        </details>
      )}
    </section>
  );
}
