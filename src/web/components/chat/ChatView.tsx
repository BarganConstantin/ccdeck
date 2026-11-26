// Chat: the conversation of one session, in the Workspace pane, with the
// Decision card docked under it when a question waits.
//
// ON PROPS. ChatView draws the `source` it is handed (loading, an error, or the
// turns); the stage reads it from the session's transcript, and a Chat|Term
// switch with nothing to show is not drawn (StageHeader draws it only when a
// view is given). Test and harness data live in __tests__/, never here.
//
// THE COLUMN stops at 776 and centres in a wider pane (chat.css). It sticks to the
// bottom as lines arrive, unless the reader scrolled up to read (more than
// BOTTOM_SLACK above the end); the stick is instant, and holds when the column
// or the region changes size under it (a Decision card docking, a disclosure
// opening). A reader scrolled up gets the way back with how many turns came
// meanwhile ("3 new"), and it goes there smoothly unless motion is reduced.
// There is no virtualisation in 4.0, and a host caps the turns it hands over.
//
// A TURN IS DRAWN AGAIN ONLY WHEN IT CHANGED. Each read of the transcript gives
// every turn back as a new object; they are kept as the objects they were
// (chat-turn-align.ts), the blocks are memoised (chat-blocks.ts) and keyed by where
// they stand in the whole conversation, so a clock tick, a key typed in the
// composer or a read that only added a line redraws the block that changed.
//
// LINES THAT ARRIVE WHILE YOU WATCH rise into place (chat-motion.css): the
// column carries `data-arrive` only once a first read of this conversation is
// drawn, and not on the render that puts older turns in front or moves "Since
// you looked" (what came while you were away is there, not arriving). That
// divider goes right before the first turn that came: a reply it falls in is
// drawn as two, the part read already and the part that came since.
//
// OLDER TURNS come as the reader nears the top, while the host has more
// (`source.older`): once the top is within a view's height of what shows, the
// page before is asked for by itself (chat-older.ts decides when), and a first
// page too short to scroll is followed by the next until it scrolls. The quiet
// button at the top stays for keys and screen readers; it shows the Loader
// while a page is read, and says when one could not be read, pressing it then
// tries again. An IntersectionObserver watches the button; a page without one
// measures on scroll and after each draw. When they arrive above, the line
// being read stays where it was: the height above it grew by what was put in,
// and the scroll moves by the same. `source.head` says when that happened.
//
// WHERE IT STANDS comes last (chat-progress.ts decides it): a message sent from
// here that the conversation does not show yet, with "Sending…" or why it was
// not taken under it, and what the session is doing. While the message is on
// its way, the session's work is the turn before it, so that line goes first.
// A screen reader hears each change of state once, in words, never the clock
// or the tool that ticks beside them; a switch to another session says nothing.
//
// AFTER THE TURN, what the session still does has a row of its own, last
// (live-activity.ts): background agents still running, or the conversation
// being compacted. The turn's "Worked for…" stays above it, since that turn
// is over; the row is the session's, not the turn's.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import IntegrationSkeleton from "../IntegrationSkeleton";
import { KitIcon } from "../kit-icons";
import type { Provider } from "../../types";
import { useT, type TFunction } from "../../i18n";
import { providerLabel } from "../../provider-copy";
import { stoppedInChat } from "../../chat-progress";
import { prefersReducedMotion } from "../../viewport-motion";
import DecisionCard, { type DecisionCardProps } from "../decision/DecisionCard";
import { Loader } from "../Loader";
import type { ChatActivity, ChatAsk, ChatLive, ChatOutgoing, ChatSource, ChatTurn, ConversationBlock } from "./chat-model";
import { conversationBlocks } from "./chat-model";
import { blockTimes } from "./chat-rich";
import { OLDER_MARGIN, olderPager, topInReach, type OlderPager } from "./chat-older";
import { ActivityLine, LiveLine, OutgoingMessage, SinceDivider } from "./ChatTurn";
import { liveKey } from "../../live-activity";
import { MemoAssistantBlock, MemoRecordLine, MemoYourCommand, MemoYourMessage } from "./chat-blocks";
import { alignTurns, turnInterner } from "../../chat-turn-align";
import "./chat.css";
import "./chat-motion.css";

export interface ChatViewProps {
  source: ChatSource;
  provider?: Provider;
  /** The question docked under the chat. Its flag is the caller's to check. */
  decision?: DecisionCardProps;
  /** How a waiting question is answered from here; without it the card is read only. */
  ask?: ChatAsk;
  /** Which session's conversation this is: a change of it is a switch, never news. */
  session?: string;
  /** A message sent from here that the conversation does not show yet. */
  outgoing?: ChatOutgoing;
  /** What the session is doing, under the last line. */
  activity?: ChatActivity;
  /** What it still does once its turn is over, on a row of its own after that. */
  live?: ChatLive;
  /** The way to Term, for a message not taken or a session gone quiet. */
  onShowTerm?(): void;
}

/** Where the conversation stands, in one word: what the live region follows. */
export function progressCue(outgoing?: ChatOutgoing, activity?: ChatActivity): string {
  if (outgoing && outgoing.state !== "taken") return outgoing.state;
  if (!activity) return "";
  return activity.state === "working" && activity.quiet ? "quiet" : activity.state;
}

/** What a screen reader hears when the cue moves from `was` to `cue`: the new
 *  state, or once its work is over, that the session finished, or that the
 *  turn was stopped when the conversation ends on that. */
export function progressSaid(cue: string, was: string, t: TFunction, agent: string, quiet = "", stopped = false): string {
  switch (cue) {
    case "sending": return t("board.chat.progress.sending");
    case "unconfirmed": return t("board.chat.progress.unconfirmed", { agent });
    case "working": return t("board.chat.progress.working", { agent });
    case "quiet": return t("board.chat.progress.quiet", { time: quiet });
    case "waiting": return t("board.chat.ask.waiting");
    default: return was !== "working" && was !== "quiet" ? ""
      : stopped ? t("board.chat.notice.interrupted") : t("board.chat.progress.done", { agent });
  }
}

/** The turn a waiting question card answers: the last turn, when it is one. */
export function liveAskAt(turns: readonly ChatTurn[]): number {
  const at = turns.length - 1;
  const last = turns[at];
  return last?.kind === "ask" && last.running ? at : -1;
}

/** The conversation's last task list, the one drawn whole; -1 when there is none.
 *  Each TodoWrite call is the whole list, so the earlier ones are history. */
export function lastTodoAt(turns: readonly ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].kind === "todo") return i;
  return -1;
}

/** Where `at` falls in a block of `length` turns starting at `start`, or undefined outside it. */
const inBlock = (at: number, start: number, length: number) => (at >= start && at < start + length ? at - start : undefined);

/** The distance from the bottom, in px, under which the reader counts as at the
 *  bottom: a nudge of the wheel does not stop the conversation following. */
export const BOTTOM_SLACK = 48;

const NO_TURNS: ChatTurn[] = [];

/** Where the turns stand in the whole conversation: `origin` numbers the first
 *  of them, `era` moves when they are another conversation's, and `arrived`
 *  is how many came at the end since the turns before. */
interface Placed { origin: number; era: number; arrived: number }

interface Place { turns: readonly ChatTurn[]; session?: string; at: Placed }

const FIRST_PLACE: Place = { turns: NO_TURNS, at: { origin: 0, era: 0, arrived: 0 } };

/** What was drawn last: a first read of this conversation, with the head it had. */
interface Drawn { ready: boolean; session?: string; head: number; era: number; since?: number }

const NOTHING_DRAWN: Drawn = { ready: false, head: 0, era: -1 };

/** The blocks with the reply that holds turn `at` cut in two there, so "Since
 *  you looked" goes right before the first turn that came, not above the part
 *  of the reply that was read already. */
export function cutAt(blocks: ConversationBlock[], at: number | undefined): ConversationBlock[] {
  if (at === undefined) return blocks;
  const i = blocks.findIndex(block => block.kind === "assistant" && at > block.index && at < block.index + block.turns.length);
  if (i < 0) return blocks;
  const block = blocks[i] as Extract<ConversationBlock, { kind: "assistant" }>;
  const k = at - block.index;
  return [...blocks.slice(0, i),
    { kind: "assistant", turns: block.turns.slice(0, k), index: block.index },
    { kind: "assistant", turns: block.turns.slice(k), index: at },
    ...blocks.slice(i + 1)];
}

/** The stage's way to answer a question, steady from one render to the next.
 *  The stage makes it anew each time it draws (each key typed in the composer),
 *  and the block that holds a waiting question would be drawn again with it;
 *  each call goes to the newest one the stage handed over. Every field the
 *  stage sets is carried: a field left out here never reaches the card (an
 *  alert's press once stopped at this line, and its answer went nowhere). */
export function useSteadyAsk(ask: ChatAsk | undefined): ChatAsk | undefined {
  const newest = useRef(ask);
  newest.current = ask;
  const has = ask !== undefined;
  const blocked = ask?.blocked;
  const gone = ask?.gone === true;
  const chat = ask?.chat !== undefined;
  const term = ask?.onShowTerm !== undefined;
  // A press is a new object for each answer chosen on an alert, the same one
  // from draw to draw until the next: the card runs it once, by its id.
  const press = ask?.press;
  return useMemo(() => {
    if (!has) return undefined;
    const steady: ChatAsk = {
      send: (questions, picks) => newest.current ? newest.current.send(questions, picks) : Promise.resolve("unavailable"),
    };
    if (blocked !== undefined) steady.blocked = blocked;
    if (gone) steady.gone = true;
    if (chat) steady.chat = questions => newest.current?.chat ? newest.current.chat(questions) : Promise.resolve("unavailable");
    if (term) steady.onShowTerm = () => newest.current?.onShowTerm?.();
    if (press) steady.press = press;
    return steady;
  }, [has, blocked, gone, chat, term, press]);
}

/** What identifies the last turn: its kind and what it says, and a tool row's,
 *  a question card's, a task list's or a sub-agent's state, a command's output
 *  as it arrives and grows, and the images counted on a message. */
export function tailKey(turn: ChatTurn | undefined): string {
  if (!turn) return "";
  if (turn.kind === "user") return `user|${turn.text}|${turn.images ?? 0}`;
  if (turn.kind === "command") return `command|${turn.name}|${turn.args ?? ""}|${turn.failed ? 1 : 0}|${turn.output ?? ""}`;
  if (turn.kind === "tool") return `tool|${turn.name}|${turn.arg}|${turn.note ?? ""}|${turn.running ? 1 : 0}|${turn.error === undefined ? 0 : 1}|${turn.declined ? 1 : 0}`;
  if (turn.kind === "ask") return `ask|${turn.questions.map(q => q.question).join("\n")}|${turn.running ? 1 : 0}|${(turn.answers ?? []).join("\n")}|${turn.reply ?? ""}`;
  if (turn.kind === "plan") return `plan|${turn.text}|${turn.running ? 1 : 0}|${turn.approved ? 1 : 0}`;
  if (turn.kind === "todo") return `todo|${turn.items.map(item => `${item.status}:${item.text}`).join("\n")}`;
  if (turn.kind === "agent") return `agent|${turn.type}|${turn.description}|${turn.running ? 1 : 0}|${turn.failed ? 1 : 0}|${turn.declined ? 1 : 0}|${turn.background ? 1 : 0}`;
  if (turn.kind === "notice") return `notice|${turn.what}|${turn.text ?? ""}`;
  return `${turn.kind}|${turn.text}`;
}

/** Before paint in a browser, so the bottom never flashes the top; a plain effect
 *  where there is no layout to wait for (rendering to a string). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatView({ source, provider, decision, ask, session, outgoing, activity, live: after, onShowTerm }: ChatViewProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  // A jump to the latest on its smooth way down: the reader is following already.
  const jumping = useRef(false);
  const latest = useRef<HTMLButtonElement | null>(null);
  const [following, setFollowing] = useState(true);
  // Turns that arrived while the reader was scrolled up.
  const [unread, setUnread] = useState(0);
  const count = source.state === "ready" ? source.turns.length : 0;
  const live = source.state === "ready" ? liveAskAt(source.turns) : -1;
  const todo = source.state === "ready" ? lastTodoAt(source.turns) : -1;
  // Each turn the object it was in the last read whenever it says the same.
  const interner = useRef<((turns: readonly ChatTurn[]) => ChatTurn[]) | null>(null);
  const read = source.state === "ready" ? source.turns : NO_TURNS;
  const turns = useMemo(() => (interner.current ??= turnInterner())(read), [read]);
  // "Since you looked" (where the first turn that came since is) cuts its reply there.
  const since = source.state === "ready" ? source.since?.at : undefined;
  const blocks = useMemo(() => cutAt(conversationBlocks(turns), since), [turns, since]);
  // Where they stand in the whole conversation, measured against the last read.
  const place = useRef(FIRST_PLACE);
  const placed = useMemo(() => {
    const was = place.current;
    if (was.turns === turns && was.session === session) return was.at;
    const moved = was.session === session ? alignTurns(was.turns, turns) : null;
    const at: Placed = moved
      ? { origin: was.at.origin + moved.dropped, era: was.at.era, arrived: moved.arrived }
      : { origin: 0, era: was.at.era + 1, arrived: 0 };
    place.current = { turns, session, at };
    return at;
  }, [turns, session]);
  const steadyAsk = useSteadyAsk(ask);
  // The block the "Since you looked" divider goes before: the one holding its turn.
  let sinceAt = -1;
  if (since !== undefined) for (let i = 0; i < blocks.length && blocks[i].index <= since; i++) sinceAt = i;
  const cue = progressCue(outgoing, activity);
  // The message on its way and the session's state are the last lines too.
  const tail = `${source.state === "ready" ? tailKey(source.turns[source.turns.length - 1]) : ""}|${cue}|${outgoing?.state ?? ""}|${outgoing?.text ?? ""}|${liveKey(after)}`;
  // What the live region says: one sentence per change of state in this session.
  const [said, setSaid] = useState("");
  const cueWas = useRef(cue);
  const sessionWas = useRef(session);
  useEffect(() => {
    const was = cueWas.current;
    cueWas.current = cue;
    if (sessionWas.current !== session) {
      sessionWas.current = session;
      setSaid("");
      return;
    }
    if (cue !== was) setSaid(progressSaid(cue, was, t, providerLabel(provider), activity?.quiet, source.state === "ready" && stoppedInChat(source.turns)));
    // The words are chosen when the state moves, not again on a language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue, session]);
  const head = source.state === "ready" ? source.head ?? 0 : 0;
  const older = source.state === "ready" ? source.older : undefined;
  // How tall the conversation was, and where its scroll stood, before turns
  // went in at the top: read while rendering, before the new ones reach the page.
  const anchorHead = useRef(head);
  const anchorHeight = useRef(0);
  const anchorTop = useRef(0);
  if (head !== anchorHead.current && scroller.current) {
    anchorHeight.current = scroller.current.scrollHeight;
    anchorTop.current = scroller.current.scrollTop;
  }
  const pressed = useRef(false);
  // New lines keep the reader at the bottom, unless they scrolled up. The last
  // turn counts as well as how many there are: once a host's cap slides the
  // window, a new line pushes an old one out and the count stays the same.
  useBeforePaint(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [count, tail]);
  // And when anything changes size under a reader at the bottom: the region
  // (a Decision card docks under it) or the column (a disclosure opens, a
  // block of code grows). The observer answers after layout, before paint.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => { if (stuck.current) el.scrollTop = el.scrollHeight; });
    watch.observe(el);
    if (column.current) watch.observe(column.current);
    return () => watch.disconnect();
  }, []);
  // Turns that arrive while the reader is scrolled up are counted on the way back.
  useEffect(() => {
    if (placed.arrived > 0 && !stuck.current) setUnread(n => n + placed.arrived);
  }, [placed]);
  // Another conversation has nothing unread.
  useEffect(() => { setUnread(0); }, [placed.era]);
  // What was drawn, for the next render to tell an arrival from a first read.
  const drawn = useRef(NOTHING_DRAWN);
  const arriving = source.state === "ready" && drawn.current.ready && drawn.current.session === session
    && drawn.current.head === head && drawn.current.era === placed.era && drawn.current.since === since;
  useEffect(() => { drawn.current = { ready: source.state === "ready", session, head, era: placed.era, since }; });
  /** Back to the latest: smoothly, or at once under reduced motion. */
  const jump = () => {
    const el = scroller.current;
    stuck.current = true;
    setFollowing(true);
    setUnread(0);
    if (!el) return;
    if (typeof el.scrollTo === "function" && !prefersReducedMotion()) {
      jumping.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else el.scrollTop = el.scrollHeight;
    el.focus({ preventScroll: true });
  };
  // A hand on the wheel, the screen, a key or the scrollbar takes the scroll back from a jump.
  const takeOver = () => { jumping.current = false; };
  // Turns put in at the top: the line being read stays in place.
  useBeforePaint(() => {
    const el = scroller.current;
    const wasHeight = anchorHeight.current;
    const wasTop = anchorTop.current;
    if (head === anchorHead.current) return;
    anchorHead.current = head;
    anchorHeight.current = 0;
    if (!el) return;
    // Set, never added to: a browser that anchors the scroll itself (Chrome,
    // Firefox, away from the very top) has moved it by the same once the page
    // is laid out, and adding would move it twice; there this sets the value
    // it holds, and a wheel's momentum goes on. Elsewhere this is the move.
    if (!stuck.current) el.scrollTop = wasTop + el.scrollHeight - wasHeight;
    // The button pressed is gone once the start is reached: the reading region keeps the keys.
    if (pressed.current && !older && typeof document !== "undefined" && (document.activeElement === null || document.activeElement === document.body)) {
      el.focus({ preventScroll: true });
    }
    pressed.current = false;
  }, [head]);
  // Older turns by themselves: the page before is asked for once the top is in
  // reach and chat-older.ts says it is due. Read from the newest draw, since the
  // observer and the scroll answer between draws.
  const olderMark = useRef<HTMLButtonElement | null>(null);
  const pager = useRef<OlderPager | null>(null);
  // Whether the top is in reach; null until the newest watch has said. Without
  // an observer watching, the scroll measures it.
  const near = useRef<boolean | null>(null);
  const watched = useRef(false);
  const offer = useRef(older);
  offer.current = older;
  const shownSession = useRef(session);
  shownSession.current = session;
  const scrolledTo = useRef(0);
  const reach = () => {
    const now = offer.current;
    if (!now || near.current === null || !(pager.current ??= olderPager()).due({ session: shownSession.current, older: now, near: near.current })) return;
    // The button holding the keys goes with the last page: the reading region takes them, as after a press.
    if (typeof document !== "undefined" && olderMark.current && document.activeElement === olderMark.current) pressed.current = true;
    now.load();
  };
  // Watched again once a page is in, its read is over or the session changes:
  // an observer's first answer says where the top is now. Until it does, the
  // scroll asks nothing: the one that sticks a reader to the bottom under a
  // page just put in comes first, and the last answer is stale. Before paint,
  // after the scroll is put where it goes, so no scroll event comes between.
  const olderState = !older ? "" : older.loading ? "loading" : older.failed ? "failed" : "idle";
  useBeforePaint(() => {
    const el = scroller.current;
    near.current = null;
    watched.current = false;
    if (!el || !olderState) return;
    const mark = olderMark.current;
    if (typeof IntersectionObserver === "undefined" || !mark) {
      near.current = topInReach(el);
      reach();
      return;
    }
    const watch = new IntersectionObserver(entries => {
      near.current = entries[entries.length - 1].isIntersecting;
      reach();
    }, { root: el, rootMargin: OLDER_MARGIN });
    watch.observe(mark);
    watched.current = true;
    return () => watch.disconnect();
    // reach reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olderState, head, session]);
  // Keyed, so the two trade places without being drawn anew (and arriving again).
  const mine = outgoing ? <OutgoingMessage key="mine" outgoing={outgoing} provider={provider} onShowTerm={onShowTerm} /> : null;
  const doing = activity ? <ActivityLine key="doing" activity={activity} provider={provider} onShowTerm={onShowTerm} /> : null;
  // Keyed by the session, so an agent list opened in one is not open in the next.
  const still = after ? <LiveLine key={`live:${session ?? ""}`} live={after} provider={provider} onShowTerm={onShowTerm} /> : null;
  // Each answer ends on how long it took, once it is over: the last one only
  // while the session is not at work on it or waiting on you.
  const times = useMemo(() => blockTimes(blocks), [blocks]);
  return (
    <div className="chat" data-docked={decision ? "" : undefined} data-arrive={arriving ? "" : undefined}>
      <div className="chat-reading">
      <div
        ref={scroller}
        className="chat-body"
        role="region"
        aria-label={t("board.chat.conversation")}
        tabIndex={0}
        onScroll={e => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
          if (jumping.current && !bottom) return;
          jumping.current = false;
          stuck.current = bottom;
          setFollowing(bottom);
          if (bottom) setUnread(0);
          // The way back goes at the bottom: the keys it held stay in the conversation.
          if (bottom && latest.current && latest.current === document.activeElement) el.focus({ preventScroll: true });
          // A move up is taken as the reader's (what this view moves goes down, at a page put in or a jump
          // to the latest): a new run of older pages.
          if (el.scrollTop < scrolledTo.current) pager.current?.moved();
          scrolledTo.current = el.scrollTop;
          if (!watched.current) near.current = topInReach(el);
          reach();
        }}
        onWheel={e => {
          takeOver();
          // Up at the top, where nothing scrolls: the reader asks for more.
          if (e.deltaY < 0) {
            pager.current?.moved();
            reach();
          }
        }}
        onTouchStart={takeOver}
        onPointerDown={takeOver}
        onKeyDown={takeOver}
      >
        <div ref={column} className="chat-col">
          {source.state === "loading" && <IntegrationSkeleton label={t("board.chat.loading")} rows={5} variant="lines" />}
          {/* The empty conversation's own line and look: nothing went wrong. */}
          {source.state === "absent" && <p className="chat-empty">{source.message}</p>}
          {source.state === "error" && (
            <div className="chat-error" role="alert">
              <span>{source.message}</span>
              {source.onRetry && <button type="button" className="chat-retry" onClick={source.onRetry}>{t("board.chat.retry")}</button>}
            </div>
          )}
          {source.state === "ready" && (
            <>
              {older && (
                <button ref={olderMark} type="button" className="chat-retry chat-older" aria-busy={older.loading || undefined}
                  onClick={() => {
                    if (older.loading) return;
                    pressed.current = true;
                    older.load();
                  }}>
                  {older.loading && <Loader />}
                  {t(older.loading ? "board.chat.olderLoading" : older.failed ? "board.chat.olderFailed" : "board.chat.older")}
                </button>
              )}
              {source.since && source.since.at === undefined && <SinceDivider since={source.since} />}
              {source.turns.length === 0 && <p className="chat-empty">{t("board.chat.empty")}</p>}
              {/* Keyed by where each turn stands in the whole conversation, so a
                  turn keeps its row (and what is open in it) when older ones
                  arrive or the live window slides; another conversation's are new rows. */}
              <Fragment key={placed.era}>
              {blocks.flatMap((block, i) => {
                const key = placed.origin + block.index;
                const row = block.kind === "assistant"
                  ? <MemoAssistantBlock key={key} turns={block.turns} provider={provider}
                    ask={steadyAsk && live >= block.index && live < block.index + block.turns.length ? { ...steadyAsk, at: live - block.index } : undefined}
                    todoAt={inBlock(todo, block.index, block.turns.length)}
                    time={i < blocks.length - 1 || !activity ? times.get(block.index) : undefined} />
                  : block.kind === "user" ? <MemoYourMessage key={key} text={block.text} images={block.images} at={block.at} />
                  : block.kind === "command" ? <MemoYourCommand key={key} turn={turns[block.index] as Extract<ChatTurn, { kind: "command" }>} />
                  : <MemoRecordLine key={key} text={block.text} />;
                // Since you looked: before the block that holds the first turn that came since.
                return i === sinceAt && source.since ? [<SinceDivider key="since" since={source.since} />, row] : [row];
              })}
              </Fragment>
            </>
          )}
          {(source.state === "ready" || source.state === "error") && (outgoing && outgoing.state !== "taken" ? [doing, mine, still] : [mine, doing, still])}
        </div>
      </div>
      {!following && source.state === "ready" && source.turns.length > 0 && (
        <button ref={latest} type="button" className="chat-latest btn" onClick={jump}
          aria-label={unread > 0 ? t("board.chat.live.latestNew", { count: unread }) : undefined}>
          <span className="chat-latest-mark" aria-hidden="true"><KitIcon name="chevron-down" /></span>
          <span>{unread > 0 ? t("board.chat.live.unread", { count: unread }) : t("board.chat.latest")}</span>
        </button>
      )}
      </div>
      {decision && <DecisionCard key={decision.model.id} {...decision} />}
      <p key={session} className="chat-sr" role="status" aria-live="polite" aria-atomic="true">{said}</p>
    </div>
  );
}
