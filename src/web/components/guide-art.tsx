// The drawings in the two guides, and the steps they belong to.
//
// DRAWN, NOT SCREENSHOTS. A screenshot of the accounts panel is a picture of
// somebody's e-mail addresses — assets/canvas-demo.mjs exists because the
// last one on the front page published exactly that — and it goes stale the
// first time a row changes shape. These are the deck's own shapes at a
// distance: the stripes and their doors, the cards, the terminal beside the
// board, the panes, the account rows. A reader who has looked at a guide
// recognises the place when they open it, which is the whole job.
//
// THE WORDS IN A DRAWING ARE THE DECK'S OWN. A door, a group, a tab or a
// card's state is drawn with the key the deck itself draws it with, so the
// picture names it exactly as the screen does, in every language, and moves
// when the screen's word does. Only what the deck never translates — a
// session's name, a tool, a line Claude Code prints — is written here.
//
// THEMED BY THE SHEET. Every fill and stroke is a class reading the same
// tokens the panels do, so a drawing is right in light and in dark without a
// second copy, and the motion in it answers prefers-reduced-motion from
// styles.css like every other animation in the app.
//
// One 440x200 board for every step, so moving between steps never changes the
// dialog's height under the reader's pointer.
import type { ReactNode } from "react";
import type { GuideStep } from "./GuideModal";
import { t, useT, type MessageKey } from "../i18n";

const FILL = { ok: "ga-ok", warn: "ga-warn", accent: "ga-accent", flight: "ga-flight" } as const;
type Tone = keyof typeof FILL;

function Board({ children }: { children: ReactNode }) {
  return (
    <svg className="guide-art" viewBox="0 0 440 200" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

/** A machine, or a panel on one: a rounded surface with a caption above it. */
function Screen({ x, y = 34, w = 176, h = 132, label }: {
  x: number; y?: number; w?: number; h?: number; label?: string;
}) {
  return (
    <>
      {label && <text x={x + 2} y={y - 9} className="ga-cap">{label}</text>}
      <rect x={x} y={y} width={w} height={h} rx={10} className="ga-screen" />
    </>
  );
}

/** One account row, as the Claude accounts panel draws it: a dot, the address,
 *  the state of the login under it, and the two quota bars when it has any. */
function Account({ x, y, email, state, tone, bars }: {
  x: number; y: number; email: string; state: string; tone: Tone; bars?: [number, number];
}) {
  return (
    <>
      <circle cx={x + 3} cy={y - 4} r={3} className={FILL[tone]} />
      <text x={x + 12} y={y} className="ga-t">{email}</text>
      <text x={x + 12} y={y + 16} className={`ga-s ${FILL[tone]}`}>{state}</text>
      {bars?.map((pct, i) => (
        <g key={i}>
          <text x={x} y={y + 40 + i * 18} className="ga-s">{i ? "7d" : "5h"}</text>
          <rect x={x + 22} y={y + 35 + i * 18} width={96} height={4} rx={2} className="ga-track" />
          <rect x={x + 22} y={y + 35 + i * 18} width={96 * pct / 100} height={4} rx={2} className="ga-accent" />
          <text x={x + 148} y={y + 40 + i * 18} className="ga-s ga-accent" textAnchor="end">{pct}%</text>
        </g>
      ))}
    </>
  );
}

/** The switch every section of the panel wears: a track and a knob. */
function Switch({ x, y, on }: { x: number; y: number; on?: boolean }) {
  return (
    <>
      <rect x={x} y={y} width={30} height={18} rx={9} className={on ? "ga-switch-on" : "ga-switch"} />
      <circle cx={on ? x + 21 : x + 9} cy={y + 9} r={6} className={on ? "ga-knob-on" : "ga-knob"} />
    </>
  );
}

function Peer({ x, y, name, here = true }: { x: number; y: number; name: string; here?: boolean }) {
  return (
    <>
      <circle cx={x + 3} cy={y - 4} r={3} className={here ? "ga-ok" : "ga-dim"} />
      <text x={x + 12} y={y} className={here ? "ga-t" : "ga-s"}>{name}</text>
    </>
  );
}

function Check({ x, y, on }: { x: number; y: number; on?: boolean }) {
  return on ? (
    <>
      <rect x={x} y={y} width={12} height={12} rx={3} className="ga-accent" />
      <path d={`M${x + 3} ${y + 6.2}l2.3 2.3 4-4.6`} className="ga-tick" />
    </>
  ) : <rect x={x + 0.5} y={y + 0.5} width={11} height={11} rx={3} className="ga-box" />;
}

/** One of the panel's own 13px header glyphs, at the drawing's scale. */
function Glyph({ x, y, d }: { x: number; y: number; d: string }) {
  return <path d={d} transform={`translate(${x} ${y})`} className="ga-glyph" />;
}

function Pointer({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y}l0 13 3.4-3 2.4 5.2 2-.9-2.4-5.1 4.6-.2z`} className="ga-pointer" />;
}

/** A login on its way from one machine to another, centred on 0,0 so the
 *  thing moving it only has to say where. */
function KeyGlyph() {
  return (
    <>
      <circle r={9} className="ga-key-bed" />
      <g transform="translate(-6 -6) scale(0.857)" className="ga-key">
        <circle cx={4.6} cy={7} r={2.6} />
        <path d="M7.2 7h5.2M10.6 7v2.2M12.4 7v1.6" />
      </g>
    </>
  );
}

function Chip({ x, y, label, live }: { x: number; y: number; label: string; live?: boolean }) {
  return (
    <>
      <rect x={x} y={y} width={46} height={20} rx={10} className={live ? "ga-chip-live" : "ga-chip"} />
      <text x={x + 23} y={y + 14} className="ga-s ga-mono" textAnchor="middle">{label}</text>
    </>
  );
}

/** The head of the Local network section: its caption and its switch. */
function LanHead({ x, y }: { x: number; y: number }) {
  const t = useT();
  return (
    <>
      <text x={x} y={y} className="ga-cap">{t("shell.art.lan")}</text>
      <Switch x={x + 118} y={y - 13} on />
    </>
  );
}

// ── V4's shapes ─────────────────────────────────────────────────────────────

/** A door on an edge stripe: its glyph and, unless the stripe is drawn
 *  folded, its word. The open one sits on the --selected fill the stripe gives
 *  it (edge-rails.css). `y` is the word's baseline. */
function Door({ x, y, w, label, on }: { x: number; y: number; w: number; label?: string; on?: boolean }) {
  return (
    <>
      {on && <rect x={x + 3} y={y - 12} width={w - 6} height={17} rx={4} className="ga-sel" />}
      <rect x={x + 9} y={y - 7.5} width={8} height={8} rx={2} className={on ? "ga-door-on" : "ga-door"} />
      {label && <text x={x + 23} y={y} className={on ? "ga-t" : "ga-s"}>{label}</text>}
    </>
  );
}

/** An edge stripe: its doors from the top, its foot from the bottom. */
function Stripe({ x, y, w, h, doors, foot = [] }: {
  x: number; y: number; w: number; h: number;
  doors: { label?: string; on?: boolean }[];
  foot?: { label?: string; on?: boolean }[];
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={6} className="ga-stripe" />
      {doors.map((d, i) => <Door key={`d${i}`} x={x} y={y + 22 + i * 21} w={w} {...d} />)}
      {foot.map((d, i) => <Door key={`f${i}`} x={x} y={y + h - 12 - (foot.length - 1 - i) * 21} w={w} {...d} />)}
    </>
  );
}

const CARD = { warn: "ga-card-warn", flight: "ga-card-flight", ok: "ga-screen", accent: "ga-card-on" } as const;

/** A session's card, as the board and the column beside the terminal draw it:
 *  its name, and its state in its colour under it. `on` is the card the
 *  terminal or the Inspector is about. */
function Card({ x, y, w, title, state, tone, on }: {
  x: number; y: number; w: number; title: string; state: string; tone: Tone; on?: boolean;
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={34} rx={6} className={on ? CARD.accent : CARD[tone]} />
      <text x={x + 10} y={y + 14} className="ga-t ga-strong">{title}</text>
      <circle cx={x + 13} cy={y + 24} r={2.5} className={FILL[tone]} />
      <text x={x + 20} y={y + 27.5} className={tone === "warn" ? "ga-s ga-warn" : "ga-s"}>{state}</text>
    </>
  );
}

/** A small card in the Inspector's tree of agents: a name and a line. */
function AgentCard({ x, y, w, title, sub, tone }: {
  x: number; y: number; w: number; title: string; sub: string; tone: Tone;
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={32} rx={6} className="ga-screen" />
      <circle cx={x + 10} cy={y + 11} r={2.5} className={FILL[tone]} />
      <text x={x + 17} y={y + 14} className="ga-t ga-strong">{title}</text>
      <text x={x + 9} y={y + 26} className="ga-s">{sub}</text>
    </>
  );
}

/** A terminal pane at a distance: a head with the session's name, and the
 *  lines it printed as bars, the way a pane reads from across the room. */
function Pane({ x, y, w, h, n, title, tone, on, rows }: {
  x: number; y: number; w: number; h: number; n: number; title: string; tone: Tone; on?: boolean; rows: number[];
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={6} className={on ? "ga-pane-on" : "ga-screen"} />
      <text x={x + 9} y={y + 15} className="ga-s ga-mono">{n}</text>
      <circle cx={x + 24} cy={y + 11} r={2.5} className={FILL[tone]} />
      <text x={x + 31} y={y + 15} className="ga-t ga-strong">{title}</text>
      <line x1={x} y1={y + 22} x2={x + w} y2={y + 22} className="ga-line" />
      {rows.map((pct, i) => (
        <rect key={i} x={x + 9} y={y + 30 + i * 10} width={(w - 18) * pct / 100} height={4} rx={2} className="ga-track" />
      ))}
    </>
  );
}

// ── the welcome ─────────────────────────────────────────────────────────────

/** Sessions open from the left stripe, and the one waiting on you is first,
 *  under Needs you; the board beside it shows the same card waiting. */
function WaitingArt() {
  const t = useT();
  return (
    <Board>
      <Stripe x={14} y={14} w={86} h={172} doors={[
        { label: t("board.rail.sessionList.short"), on: true },
        { label: t("board.rail.accounts") },
      ]} />
      <rect x={108} y={14} width={190} height={172} rx={8} className="ga-screen" />
      <text x={120} y={34} className="ga-t ga-strong">{t("board.rail.sessionList.short")}</text>
      <line x1={108} y1={44} x2={298} y2={44} className="ga-line" />

      <text x={120} y={62} className="ga-s ga-strong ga-warn">{t("board.railGroup.needs")}</text>
      <text x={286} y={62} className="ga-s" textAnchor="end">1</text>
      <rect x={114} y={69} width={178} height={38} rx={6} className="ga-bed-warn" />
      <circle cx={127} cy={83} r={7} className="ga-ring-warn ga-ping" />
      <circle cx={127} cy={83} r={3.5} className="ga-warn" />
      <text x={138} y={87} className="ga-t">api-server</text>
      <text x={138} y={101} className="ga-s ga-warn">{t("shell.art.waitingBash")}</text>

      <text x={120} y={126} className="ga-s ga-strong">{t("board.railGroup.working")}</text>
      <text x={286} y={126} className="ga-s" textAnchor="end">1</text>
      <circle cx={127} cy={141} r={3.5} className="ga-flight" />
      <text x={138} y={145} className="ga-t">docs-site</text>

      <text x={120} y={164} className="ga-s ga-strong">{t("board.railGroup.done")}</text>
      <text x={286} y={164} className="ga-s" textAnchor="end">1</text>
      <circle cx={127} cy={177} r={3.5} className="ga-ok" />
      <text x={138} y={181} className="ga-t">billing</text>

      <rect x={306} y={40} width={120} height={120} rx={10} className="ga-canvas" />
      <Card x={316} y={58} w={100} title="api-server" state={t("board.card.stateWaiting")} tone="warn" />
      <Card x={316} y={104} w={100} title="docs-site" state={t("board.card.stateWorking")} tone="flight" />
    </Board>
  );
}

/** A card pressed, and its terminal beside the board: the board folds to a
 *  column of its cards, New session at its head, and the pane is the session
 *  itself, asking. */
function TerminalArt() {
  const t = useT();
  return (
    <Board>
      <rect x={22} y={16} width={118} height={24} rx={6} className="ga-btn" />
      <path d="M33 28h8M37 24v8" className="ga-glyph" />
      <text x={48} y={32} className="ga-s">{t("board.newSession.title")}</text>
      <Card x={22} y={52} w={118} title="api-server" state={t("board.card.stateWaiting")} tone="warn" on />
      <Card x={22} y={96} w={118} title="docs-site" state={t("board.card.stateWorking")} tone="flight" />
      <Card x={22} y={140} w={118} title="billing" state={t("board.card.stateDone")} tone="ok" />
      <Pointer x={118} y={72} />

      <rect x={152} y={14} width={274} height={172} rx={8} className="ga-screen" />
      <rect x={153} y={41} width={272} height={144} rx={7} className="ga-term" />
      <rect x={153} y={41} width={272} height={10} className="ga-term" />
      <line x1={152} y1={41} x2={426} y2={41} className="ga-line" />
      <circle cx={167} cy={27} r={3.5} className="ga-warn" />
      <text x={177} y={31} className="ga-t ga-strong">api-server</text>
      <text x={246} y={31} className="ga-s ga-warn">{t("shell.art.waitingBash")}</text>
      <Glyph x={406} y={21} d="M2 2l8 8M10 2l-8 8" />

      <circle cx={168} cy={66} r={2.5} className="ga-accent" />
      <text x={177} y={70} className="ga-s ga-mono">Bash(npm test)</text>
      <text x={168} y={96} className="ga-t ga-mono ga-warn">{t("shell.art.allow")}</text>
      <text x={168} y={118} className="ga-s ga-mono">&gt; 1. Yes   2. No</text>
      <rect x={168} y={134} width={7} height={13} className="ga-caret ga-blink" />
    </Board>
  );
}

/** Workspace: the switch at the top, the sessions down the left, and up to
 *  four panes side by side — the fourth arriving, as Shift+Enter or a drag
 *  brings one beside the pane you are in. */
function WorkspaceArt() {
  const t = useT();
  return (
    <Board>
      <rect x={176} y={12} width={52} height={18} rx={4} className="ga-chip" />
      <text x={202} y={25} className="ga-s ga-mono" textAnchor="middle">Ctrl+`</text>
      <rect x={236} y={10} width={190} height={22} rx={6} className="ga-btn" />
      <rect x={332} y={12} width={92} height={18} rx={5} className="ga-sel" />
      <text x={284} y={25} className="ga-s" textAnchor="middle">{t("board.view.board")}</text>
      <text x={378} y={25} className="ga-t" textAnchor="middle">{t("board.view.workspace")}</text>

      <rect x={14} y={40} width={98} height={150} rx={6} className="ga-stripe" />
      {([["api-server", "warn"], ["docs-site", "flight"], ["billing", "ok"], ["tests", "flight"]] as const).map(([name, tone], i) => {
        // The row being dragged onto the fourth pane.
        const dragged = i === 3;
        return (
          <g key={name}>
            {dragged && <rect x={18} y={48 + i * 24} width={90} height={20} rx={4} className="ga-sel" />}
            <circle cx={27} cy={58 + i * 24} r={2.5} className={FILL[tone]} />
            <text x={35} y={62 + i * 24} className={dragged ? "ga-t" : "ga-s"}>{name}</text>
          </g>
        );
      })}

      <Pane x={120} y={40} w={150} h={72} n={1} title="api-server" tone="warn" on rows={[70, 45, 82]} />
      <Pane x={276} y={40} w={150} h={72} n={2} title="docs-site" tone="flight" rows={[55, 88, 30]} />
      <Pane x={120} y={118} w={150} h={72} n={3} title="billing" tone="ok" rows={[64, 40, 72]} />
      <rect x={276} y={118} width={150} height={72} rx={6} className="ga-ghost" />
      <g className="ga-pop">
        <Pane x={284} y={126} w={134} h={56} n={4} title="tests" tone="flight" rows={[60, 38]} />
      </g>
      <Pointer x={380} y={160} />
    </Board>
  );
}

/** The Inspector, open on the card the board has selected: its three tabs,
 *  the session's tokens and cost, and the tree of every agent it started, with
 *  their tools; its door lit at the top of the right stripe. */
function InspectorArt() {
  const t = useT();
  return (
    <Board>
      <rect x={14} y={30} width={124} height={140} rx={10} className="ga-canvas" />
      <text x={24} y={64} className="ga-s">api-server</text>
      <Card x={24} y={72} w={104} title="api-server" state={t("board.card.stateWorking")} tone="flight" on />

      <rect x={146} y={14} width={244} height={172} rx={8} className="ga-screen" />
      <text x={158} y={34} className="ga-t ga-strong">{t("board.inspector.tabAgents")}</text>
      <rect x={158} y={40} width={36} height={2} rx={1} className="ga-accent" />
      <text x={238} y={34} className="ga-s">{t("board.inspector.tabTime")}</text>
      <text x={296} y={34} className="ga-s">{t("board.inspector.tabContext")}</text>
      <line x1={146} y1={44} x2={390} y2={44} className="ga-line" />
      <text x={158} y={64} className="ga-t ga-strong">api-server</text>
      <text x={158} y={79} className="ga-s">{t("shell.art.inOut")}</text>

      <path d="M250 106H262C270 106 270 106 278 106" className="ga-edge ga-flow" />
      <path d="M250 106C264 106 264 146 278 146" className="ga-edge-done" />
      {/* The model under each agent: a product name, the same width in every
          language, where a tool count ran past the card in Japanese. */}
      <AgentCard x={158} y={90} w={92} title="main" sub="Opus 5" tone="accent" />
      <AgentCard x={278} y={90} w={102} title="explore" sub="Haiku" tone="flight" />
      <AgentCard x={278} y={130} w={102} title="tests" sub={t("shell.art.doneSec")} tone="ok" />
      <Chip x={158} y={134} label="Read" />
      <Chip x={208} y={134} label="Bash" live />

      <Stripe x={398} y={14} w={28} h={172} doors={[{ on: true }, {}, {}]} foot={[{}]} />
    </Board>
  );
}

/** The whole deck at a distance, the board quiet in the middle: the left
 *  stripe with Sessions and Accounts, more doors under them, and Settings at
 *  its foot; the right one with the Inspector, Usage and This machine, and
 *  more doors under them. The doors below go unnamed: their words run too
 *  long for the stripe in some languages, and the tip names them. */
function EdgesArt() {
  const t = useT();
  return (
    <Board>
      <line x1={14} y1={22} x2={426} y2={22} className="ga-line" />
      <rect x={14} y={8} width={34} height={8} rx={4} className="ga-track" />
      <rect x={176} y={8} width={88} height={8} rx={4} className="ga-track" />
      <Stripe x={14} y={30} w={106} h={162}
        doors={[{ label: t("board.rail.sessionList.short") }, { label: t("board.rail.accounts") }, {}, {}, {}]}
        foot={[{}, { label: t("board.rail.settings") }]} />
      <Stripe x={320} y={30} w={106} h={162}
        doors={[{ label: t("board.inspector.label") }, { label: t("board.rail.usage") }, { label: t("board.rail.machine.hint") }, {}, {}, {}]} />
      <g className="ga-quiet">
        <rect x={130} y={42} width={180} height={62} rx={8} className="ga-frame" />
        <rect x={140} y={56} width={76} height={34} rx={6} className="ga-card-warn" />
        <rect x={224} y={56} width={76} height={34} rx={6} className="ga-card-flight" />
        <rect x={130} y={116} width={180} height={62} rx={8} className="ga-frame" />
        <rect x={140} y={130} width={76} height={34} rx={6} className="ga-screen" />
      </g>
    </Board>
  );
}

/** The Accounts panel: Claude's and Codex's accounts behind one switch, the
 *  one in use and the one a press away, and Local network at its foot — with
 *  a login crossing to it from the other machine, where it still works. */
function AccountsArt() {
  const t = useT();
  return (
    <Board>
      <rect x={14} y={14} width={176} height={176} rx={10} className="ga-screen" />
      {/* The panel's own head: one switch between the Claude and Codex
          accounts, Claude's picked. Product names, so not translated. */}
      <rect x={22} y={22} width={50} height={18} rx={6} className="ga-track" />
      <text x={47} y={35} className="ga-t ga-strong" textAnchor="middle">Claude</text>
      <text x={84} y={35} className="ga-t ga-dim">Codex</text>
      <line x1={14} y1={46} x2={190} y2={46} className="ga-line" />
      <g className="ga-swap-out">
        <Account x={24} y={66} email="work@team.dev" state={t("shell.art.stateExpired")} tone="warn" />
      </g>
      <g className="ga-swap-in">
        <Account x={24} y={66} email="work@team.dev" state={t("shell.art.stateWorkingAgain")} tone="ok" />
      </g>
      <line x1={14} y1={94} x2={190} y2={94} className="ga-line" />
      <Account x={24} y={114} email="personal@me.dev" state={t("shell.art.stateSignedIn")} tone="ok" />
      {/* Wide enough for the longest translation ("wechseln", "basculer"). */}
      <rect x={128} y={120} width={56} height={18} rx={9} className="ga-chip" />
      <text x={156} y={132} className="ga-s" textAnchor="middle">{t("shell.art.switch")}</text>
      <Pointer x={168} y={133} />
      <line x1={14} y1={146} x2={190} y2={146} className="ga-line" />
      {/* The row at the panel's foot, its count under its name so neither
          runs into the other in a longer language. */}
      <text x={24} y={164} className="ga-t">{t("lan.entry.name")}</text>
      <text x={24} y={180} className="ga-s ga-ok">{t("lan.entry.online", { n: 1 })}</text>

      <Screen x={250} label={t("shell.art.anotherMachineCap")} />
      <Account x={264} y={76} email="work@team.dev" state={t("shell.art.stateWorking")} tone="ok" bars={[24, 61]} />
      <path d="M246 96C234 56 206 56 194 96" className="ga-arc" />
      <g className="ga-travel" transform="translate(220 66)">
        <KeyGlyph />
      </g>
    </Board>
  );
}

/** Where a first session comes from: claude or codex run in any folder, or
 *  New session at the head of the deck's column — and its card arrives. */
function StartArt() {
  const t = useT();
  return (
    <Board>
      <rect x={14} y={40} width={176} height={120} rx={10} className="ga-screen" />
      <text x={28} y={60} className="ga-cap">~/MY-PROJECT</text>
      <line x1={14} y1={70} x2={190} y2={70} className="ga-line" />
      <text x={28} y={100} className="ga-t ga-mono"><tspan className="ga-accent">$</tspan> claude</text>
      <rect x={86} y={90} width={7} height={13} className="ga-caret ga-blink" />
      <text x={28} y={130} className="ga-s ga-mono">{t("shell.art.orCodex")}</text>
      <path d="M200 100H230" className="ga-arc" />
      <path d="M225 95l6 5-6 5" className="ga-arrow" />

      <rect x={242} y={14} width={184} height={172} rx={10} className="ga-screen" />
      <rect x={254} y={26} width={160} height={24} rx={6} className="ga-btn" />
      <path d="M265 38h8M269 34v8" className="ga-glyph" />
      <text x={280} y={42} className="ga-s">{t("board.newSession.title")}</text>
      <g className="ga-pop">
        <Card x={254} y={64} w={160} title="my-project" state={t("board.card.stateWorking")} tone="flight" on />
      </g>
      <Card x={254} y={108} w={160} title="api-server" state={t("board.card.stateDone")} tone="ok" />
    </Board>
  );
}

/** A step whose line and tip are read from the catalog each time the modal
 *  draws, so the same constant is right in whichever language is on show (the
 *  modal re-renders when it changes). guide.test.ts reads them in English. */
function step(art: ReactNode, line: MessageKey, tip?: MessageKey): GuideStep {
  const made: GuideStep = { art, get line() { return t(line); } };
  if (tip) Object.defineProperty(made, "tip", { get: () => t(tip), enumerable: true });
  return made;
}

// The order is the story, told to somebody opening V4 for the first time or
// for the first time since 3.x: what is waiting on you, how you answer it,
// several at once, what happened inside one, where everything else lives, the
// accounts — and last, how to get a session onto the board, because that is
// the step a reader acts on when they press Done. Each line says what the
// reader sees in the common case — the Command Panel on, a desktop window —
// and promises nothing past it; the tip is there only where the line would
// otherwise stop being true.
export const WELCOME_STEPS: GuideStep[] = [
  step(<WaitingArt />, "shell.guide.welcome.waiting.line", "shell.guide.welcome.waiting.tip"),
  step(<TerminalArt />, "shell.guide.welcome.terminal.line", "shell.guide.welcome.terminal.tip"),
  step(<WorkspaceArt />, "shell.guide.welcome.workspace.line", "shell.guide.welcome.workspace.tip"),
  step(<InspectorArt />, "shell.guide.welcome.inspector.line", "shell.guide.welcome.inspector.tip"),
  step(<EdgesArt />, "shell.guide.welcome.edges.line", "shell.guide.welcome.edges.tip"),
  step(<AccountsArt />, "shell.guide.welcome.accounts.line", "shell.guide.welcome.accounts.tip"),
  step(<StartArt />, "shell.guide.welcome.start.line"),
];

// ── local network ───────────────────────────────────────────────────────────

function LanProblemArt() {
  const t = useT();
  return (
    <Board>
      <Screen x={14} label={t("shell.art.thisMachineCap")} />
      <Account x={28} y={64} email="work@team.dev" state={t("shell.art.stateExpired")} tone="warn" />
      <rect x={40} y={94} width={86} height={20} rx={10} className="ga-pill-warn" />
      <text x={83} y={108} className="ga-s ga-warn" textAnchor="middle">{t("shell.art.signInAgain")}</text>
      <line x1={198} y1={100} x2={242} y2={100} className="ga-off" />
      <Screen x={250} label={t("shell.art.anotherMachineCap")} />
      <Account x={264} y={64} email="work@team.dev" state={t("shell.art.stateWorking")} tone="ok" bars={[24, 61]} />
    </Board>
  );
}

function LanPairArt() {
  const t = useT();
  return (
    <Board>
      <Screen x={14} label={t("shell.art.thisMachineCap")} />
      <LanHead x={28} y={60} />
      <Peer x={28} y={92} name="Ana's MacBook" />
      <Peer x={28} y={114} name="Dorin's PC" />
      <Screen x={250} label={t("shell.art.anotherMachineCap")} />
      <LanHead x={264} y={60} />
      <Peer x={264} y={92} name={t("shell.art.yourMacbook")} />
      <Peer x={264} y={114} name="Dorin's PC" />
      <line x1={196} y1={100} x2={244} y2={100} className="ga-arc" />
      <circle cx={220} cy={100} r={10} className="ga-ring ga-ping" />
      <circle cx={220} cy={100} r={10} className="ga-ring ga-ping ga-ping-2" />
      <circle cx={220} cy={100} r={3} className="ga-accent" />
    </Board>
  );
}

function LanShareArt() {
  const t = useT();
  return (
    <Board>
      <rect x={90} y={18} width={260} height={164} rx={10} className="ga-screen" />
      <text x={106} y={42} className="ga-t ga-strong">{t("shell.art.shareTitle")}</text>
      <line x1={90} y1={54} x2={350} y2={54} className="ga-line" />
      <text x={106} y={76} className="ga-cap">{t("shell.art.shareCap")}</text>
      <Check x={106} y={88} on />
      <text x={126} y={98} className="ga-t">work@team.dev</text>
      <Check x={106} y={112} />
      <text x={126} y={122} className="ga-s">personal@me.dev</text>
      <text x={106} y={150} className="ga-cap">{t("shell.art.pairingCap")}</text>
      <text x={106} y={168} className="ga-s">{t("shell.art.sayYes")}</text>
      <Switch x={304} y={157} on />
      <Pointer x={115} y={97} />
    </Board>
  );
}

function LanRepairArt() {
  const t = useT();
  return (
    <Board>
      <Screen x={14} label={t("shell.art.thisMachineCap")} />
      <g className="ga-swap-out">
        <Account x={28} y={64} email="work@team.dev" state={t("shell.art.stateExpired")} tone="warn" />
      </g>
      <g className="ga-swap-in">
        <Account x={28} y={64} email="work@team.dev" state={t("shell.art.stateWorkingAgain")} tone="ok" bars={[24, 61]} />
      </g>
      <Screen x={250} label={t("shell.art.anotherMachineCap")} />
      <Account x={264} y={64} email="work@team.dev" state={t("shell.art.stateWorking")} tone="ok" bars={[24, 61]} />
      <path d="M246 96C234 56 206 56 194 96" className="ga-arc" />
      <g className="ga-travel" transform="translate(220 66)">
        <KeyGlyph />
      </g>
    </Board>
  );
}

export const LAN_STEPS: GuideStep[] = [
  step(<LanProblemArt />, "shell.guide.lan.1.line"),
  step(<LanPairArt />, "shell.guide.lan.2.line", "shell.guide.lan.2.tip"),
  step(<LanShareArt />, "shell.guide.lan.3.line"),
  step(<LanRepairArt />, "shell.guide.lan.4.line"),
];

/** The same story at the size of the panel, for the section while it is off:
 *  one machine whose login died, one whose login works, and the arc between. */
export function LanIntroArt() {
  return (
    <svg className="guide-art" viewBox="0 0 232 60" aria-hidden focusable="false">
      <rect x={1} y={14} width={78} height={42} rx={7} className="ga-screen" />
      <circle cx={13} cy={29} r={3} className="ga-warn" />
      <rect x={21} y={27} width={46} height={4} rx={2} className="ga-track" />
      <rect x={13} y={39} width={40} height={3} rx={1.5} className="ga-track" />
      <rect x={153} y={14} width={78} height={42} rx={7} className="ga-screen" />
      <circle cx={165} cy={29} r={3} className="ga-ok" />
      <rect x={173} y={27} width={46} height={4} rx={2} className="ga-track" />
      <rect x={165} y={39} width={40} height={3} rx={1.5} className="ga-accent" />
      <path d="M150 36C138 6 94 6 82 36" className="ga-arc" />
      <g transform="translate(116 13)"><KeyGlyph /></g>
    </svg>
  );
}
