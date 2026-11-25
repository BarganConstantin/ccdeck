// The deck's half of interactive alerts: which sessions get a card in the
// alert stack, what a card's buttons do, and the other ways in to the same
// two actions, a system notification's buttons (through the service worker)
// and the desktop app's notification and tray rows (through its preload).
//
// ONE PATH FOR EVERY ANSWER. A card's "Allow once", a question's option and a
// notification's "Allow once" all become the same intent (answer-intent.ts)
// and the same Open in Chat; the pane presses the intent only once the card
// on screen shows the same words. "Open" and a notification's body open the
// session in Chat and answer nothing.
//
// WHICH SESSIONS GET A CARD: a block that began after the deck went live (the
// ones standing when it opened are on the top bar's count already), not
// dismissed, and not on screen in Chat, where the Decision card is in front of
// the reader. Cards go when the block does.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alertFor, pendingCall, type AlertChoice, type AlertModel } from "./alert-model";
import { answerIntents, useIntentVersion, type IntentOutcome } from "./answer-intent";
import { chatLinkTarget, parseWorkerMessage, WORKER_MESSAGE, type OpenRequest } from "./alert-worker";
import { onShownInChat, shownInChatKey } from "./chat-view-memory";
import type { BlockedSession } from "./ambient-counts";
import type { GraphState } from "./graph-state";
import { blockKey } from "./notify";
import { useLanguage, useT, type TFunction } from "./i18n";
import { useMirroredRef } from "./use-mirrored-ref";

/** How long a request for a session the deck does not know yet is held: a
 *  deck opened by a notification learns its sessions in its first replay. */
export const OPEN_HOLD_MS = 30_000;
/** What the desktop app raises in the page when a session waits to be taken
 *  (desktop/session-link.mjs SESSION_HELD_EVENT). */
export const DESK_SESSION_EVENT = "ccdeck:session-held";

export interface ChatAlertsDeps {
  waitingSessions: BlockedSession[];
  stateRef: { readonly current: GraphState };
  /** When the deck finished adopting the world; null before. */
  liveSince: number | null;
  /** Shows a session in a Workspace pane in Chat. */
  openInChat(sessionId: string): void;
  /** Where a session goes when Chat cannot be had (a finished turn's click too). */
  focusSession(sessionId: string): void;
}

/** The cards for `waiting`: the blocks not in `seen` (history) or
 *  `dismissed`, and not on screen in Chat. */
export function alertSessions(
  waiting: readonly BlockedSession[], seen: ReadonlySet<string> | null,
  dismissed: ReadonlySet<string>, inChat: ReadonlySet<string>,
): BlockedSession[] {
  if (!seen) return [];
  return waiting.filter(b => {
    const key = blockKey(b.id, b.waiting);
    return !seen.has(key) && !dismissed.has(key) && !inChat.has(b.id);
  });
}

/** What the stack's live region says about a new card, or an intent's end. */
export function alertSentence(alert: AlertModel, tr: TFunction): string {
  return tr("board.chat.alert.said", { name: alert.name, what: alert.what });
}

const OUTCOME_SAID: Record<IntentOutcome["kind"], string> = {
  answered: "board.chat.alert.outcome.answered",
  changed: "board.chat.alert.outcome.changed",
  locked: "board.chat.alert.outcome.locked",
  timeout: "board.chat.alert.outcome.timeout",
  expired: "board.chat.alert.outcome.timeout",
};

/** Whether an "Allow once" from a notification may become an intent: the
 *  session still waits on a permission prompt, the same block when the
 *  notification named one. */
export function allowable(req: OpenRequest, waiting: readonly BlockedSession[]): BlockedSession | null {
  if (req.action !== "allow") return null;
  const b = waiting.find(w => w.id === req.sessionId);
  if (!b || b.waiting.kind !== "permission") return null;
  if (req.since !== undefined && req.since !== b.waiting.since) return null;
  return b;
}

export function useChatAlerts({ waitingSessions, stateRef, liveSince, openInChat, focusSession }: ChatAlertsDeps) {
  const t = useT();
  // What the memos below hang on: useT hands out a new function every render.
  const lang = useLanguage();
  const waitKey = waitingSessions.map(b => blockKey(b.id, b.waiting)).join("|");

  // History: what was standing when the deck went live.
  const seen = useRef<ReadonlySet<string> | null>(null);
  if (seen.current === null && liveSince != null) seen.current = new Set(waitingSessions.map(b => blockKey(b.id, b.waiting)));

  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Forget what is no longer waiting, and every intent with it.
  useEffect(() => {
    answerIntents.prune(waitingSessions.map(b => ({ id: b.id, since: b.waiting.since })));
    const live = new Set(waitKey.split("|"));
    setDismissed(prev => (([...prev].every(k => live.has(k))) ? prev : new Set([...prev].filter(k => live.has(k)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitKey]);

  const inChatKey = useSyncExternalStore(onShownInChat, shownInChatKey, shownInChatKey);
  const alerts = useMemo(() => {
    const inChat = new Set(inChatKey ? inChatKey.split("|") : []);
    const state = stateRef.current;
    const owner = (agentId: string | undefined) => (agentId ? state.agents.get(agentId)?.sessionId : undefined);
    return alertSessions(waitingSessions, seen.current, dismissed, inChat).map(b => alertFor(b, {
      provider: state.agents.get(b.id)?.provider,
      pending: pendingCall(state.toolIndex.values(), owner, b.id, b.waiting.since),
    }, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitKey, dismissed, inChatKey, lang, liveSince]);

  // The live region: a new card is said once, and so is what became of an
  // answer chosen on one.
  const [said, setSaid] = useState("");
  const told = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh = alerts.filter(a => !told.current.has(`${a.sessionId}@${a.since}`));
    told.current = new Set(alerts.map(a => `${a.sessionId}@${a.since}`));
    if (fresh.length) setSaid(fresh.map(a => alertSentence(a, t)).join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts]);
  const intents = useIntentVersion();
  const lastOutcome = useRef(0);
  useEffect(() => {
    const outcome = answerIntents.outcomes().at(-1);
    if (!outcome || outcome.at <= lastOutcome.current) return;
    lastOutcome.current = outcome.at;
    const name = waitingSessions.find(b => b.id === outcome.sessionId);
    setSaid(t(OUTCOME_SAID[outcome.kind], { name: name?.name ?? name?.label ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intents]);

  const answer = useCallback((alert: AlertModel, choice: AlertChoice) => {
    answerIntents.put({
      sessionId: alert.sessionId, kind: choice.intent, choiceLabel: choice.label, choiceIndex: choice.index,
      since: alert.since, ...(alert.detail ? { detail: alert.detail } : null),
    });
    openInChat(alert.sessionId);
  }, [openInChat]);
  const open = useCallback((alert: AlertModel) => openInChat(alert.sessionId), [openInChat]);
  const dismiss = useCallback((alert: AlertModel) => {
    setDismissed(prev => new Set([...prev, blockKey(alert.sessionId, { kind: "permission", message: "", since: alert.since })]));
  }, []);

  // A press from outside the page: a notification's button or body (the
  // worker), the desktop app's notification or tray row, or a deck opened on
  // `#chat=<id>`. Held until the session is on the board, for a little while.
  const live = useMirroredRef({ waitingSessions, stateRef, openInChat, focusSession });
  const held = useRef<{ req: OpenRequest; at: number } | null>(null);
  const act = useCallback((req: OpenRequest): boolean => {
    const now = live.current;
    if (!now.stateRef.current.agents.has(req.sessionId)) return false;
    if (req.kind === "finished") { now.focusSession(req.sessionId); return true; }
    const block = allowable(req, now.waitingSessions);
    if (block) {
      answerIntents.put({
        sessionId: block.id, kind: "permission", choiceLabel: "Yes", choiceIndex: 0, since: block.waiting.since,
        ...(block.waiting.tool?.name === "Bash" && block.waiting.tool.preview ? { detail: block.waiting.tool.preview } : null),
      });
    }
    now.openInChat(req.sessionId);
    return true;
  }, []);
  const take = useCallback((req: OpenRequest) => {
    if (!act(req)) held.current = { req, at: Date.now() };
  }, [act]);
  useEffect(() => {
    const h = held.current;
    if (!h) return;
    if (Date.now() - h.at > OPEN_HOLD_MS) { held.current = null; return; }
    if (act(h.req)) held.current = null;
  });

  useEffect(() => {
    // A deck opened on a session: open it, and take the link out of the address.
    if (typeof window === "undefined") return;
    const target = chatLinkTarget(window.location?.hash ?? "");
    if (target) {
      try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch { /* the link stays, harmlessly */ }
      take({ sessionId: target, action: "open" });
    }
    const sw = typeof navigator !== "undefined" ? (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      const req = parseWorkerMessage(e.data);
      if (req) take(req);
    };
    sw?.addEventListener?.("message", onMessage);
    // The desktop app's notification and tray rows (desktop/session-link.mjs):
    // the session the window was opened on, taken as the deck starts and
    // whenever the app says one is waiting.
    const desk = (window as Window & { ccdeckSession?: { take?: () => Promise<unknown> } }).ccdeckSession;
    const fromDesk = () => {
      desk?.take?.().then(id => {
        const req = parseWorkerMessage({ type: WORKER_MESSAGE, sessionId: id, action: "open" });
        if (req) take(req);
      }, () => { /* no session waiting: nothing to open */ });
    };
    if (desk?.take) {
      fromDesk();
      window.addEventListener?.(DESK_SESSION_EVENT, fromDesk);
    }
    return () => {
      sw?.removeEventListener?.("message", onMessage);
      if (desk?.take) window.removeEventListener?.(DESK_SESSION_EVENT, fromDesk);
    };
  }, [take]);

  return { alerts, said, answer, open, dismiss };
}
