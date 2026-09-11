// The drawings in the two guides, and the steps they belong to.
//
// DRAWN, NOT SCREENSHOTS. A screenshot of the accounts panel is a picture of
// somebody's e-mail addresses — assets/canvas-demo.mjs exists because the
// last one on the front page published exactly that — and it goes stale the
// first time a row changes shape. These are the deck's own shapes at a
// distance: the dot, the address, the state under it, the switch, the bar.
// A reader who has looked at a guide recognises the panel when they open it,
// which is the whole job.
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
      <text x={x + 12} y={y} className="ga-t ga-mono">{email}</text>
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

/** An agent on the canvas: a card, a stripe in its state's colour, a name. */
function Node({ x, y, w, title, sub, tone }: {
  x: number; y: number; w: number; title: string; sub: string; tone: Tone;
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={40} rx={8} className="ga-screen" />
      <rect x={x + 6} y={y + 10} width={3} height={20} rx={1.5} className={FILL[tone]} />
      <text x={x + 16} y={y + 17} className="ga-t ga-strong">{title}</text>
      <text x={x + 16} y={y + 31} className="ga-s">{sub}</text>
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
  return (
    <>
      <text x={x} y={y} className="ga-cap">LOCAL NETWORK</text>
      <Switch x={x + 118} y={y - 13} on />
    </>
  );
}

// ── the welcome ─────────────────────────────────────────────────────────────

function WaitingArt() {
  return (
    <Board>
      <rect x={14} y={14} width={206} height={172} rx={10} className="ga-screen" />
      <text x={28} y={38} className="ga-t ga-strong">Sessions</text>
      <text x={206} y={38} className="ga-s ga-warn" textAnchor="end">1 waiting</text>
      <rect x={20} y={50} width={194} height={42} rx={6} className="ga-bed-warn" />
      <circle cx={33} cy={64} r={7} className="ga-ring-warn ga-ping" />
      <circle cx={33} cy={64} r={3.5} className="ga-warn" />
      <text x={44} y={68} className="ga-t">api-server</text>
      <text x={44} y={83} className="ga-s ga-warn">waiting 6m · Bash</text>
      <circle cx={33} cy={108} r={3.5} className="ga-flight" />
      <text x={44} y={112} className="ga-t">docs-site</text>
      <text x={44} y={127} className="ga-s">running · 12 tools</text>
      <circle cx={33} cy={150} r={3.5} className="ga-ok" />
      <text x={44} y={154} className="ga-t">billing</text>
      <text x={44} y={169} className="ga-s">done · $0.84</text>

      <path d="M216 71C234 71 230 100 244 100" className="ga-arc" />
      <path d="M239 96l5 4-5 4" className="ga-arrow" />

      <rect x={248} y={44} width={178} height={112} rx={10} className="ga-screen" />
      <text x={262} y={64} className="ga-cap">API-SERVER</text>
      <line x1={248} y1={74} x2={426} y2={74} className="ga-line" />
      <text x={262} y={96} className="ga-s ga-mono">Bash(npm test)</text>
      <text x={262} y={116} className="ga-t ga-mono ga-warn">Allow this command?</text>
      <text x={262} y={136} className="ga-s ga-mono">&gt; 1. Yes   2. No</text>
    </Board>
  );
}

function TreeArt() {
  return (
    <Board>
      <path d="M136 100C166 100 166 38 196 38" className="ga-edge ga-flow" />
      <path d="M136 100H196" className="ga-edge ga-flow" />
      <path d="M136 100C166 100 166 162 196 162" className="ga-edge-done" />
      <path d="M308 38H326M308 100H326" className="ga-edge" />
      <Node x={20} y={80} w={116} title="main" sub="Opus 5 · 9 tools" tone="accent" />
      <Node x={196} y={18} w={112} title="explore" sub="Haiku · 14 tools" tone="flight" />
      <Node x={196} y={80} w={112} title="tests" sub="Sonnet · 6 tools" tone="flight" />
      <Node x={196} y={142} w={112} title="review" sub="done · 38s" tone="ok" />
      <Chip x={326} y={28} label="Read" />
      <Chip x={380} y={28} label="Grep" live />
      <Chip x={326} y={90} label="Bash" live />
    </Board>
  );
}

function Quota({ x, y, label, pct, note }: { x: number; y: number; label: string; pct: number; note: string }) {
  return (
    <>
      <text x={x} y={y} className="ga-s">{label}</text>
      <text x={x + 194} y={y} className="ga-s ga-accent" textAnchor="end">{pct}%</text>
      <rect x={x} y={y + 7} width={194} height={5} rx={2.5} className="ga-track" />
      <rect x={x} y={y + 7} width={194 * pct / 100} height={5} rx={2.5} className="ga-accent" />
      <text x={x} y={y + 26} className="ga-s">{note}</text>
    </>
  );
}

function CostArt() {
  return (
    <Board>
      <rect x={14} y={30} width={172} height={140} rx={10} className="ga-screen" />
      <text x={30} y={56} className="ga-cap">THIS SESSION</text>
      <text x={30} y={98} className="ga-big">$3.66</text>
      <text x={30} y={122} className="ga-s">Opus 5 · 1.2M tokens</text>
      <text x={30} y={150} className="ga-s">$21.40 today</text>
      <rect x={200} y={30} width={226} height={140} rx={10} className="ga-screen" />
      <text x={216} y={56} className="ga-cap">CLAUDE QUOTA</text>
      <Quota x={216} y={80} label="5-hour window" pct={24} note="resets in 53m" />
      <Quota x={216} y={124} label="7-day window" pct={61} note="resets in 4d" />
    </Board>
  );
}

function StartArt() {
  return (
    <Board>
      <rect x={14} y={40} width={188} height={120} rx={10} className="ga-screen" />
      <text x={28} y={60} className="ga-cap">~/MY-PROJECT</text>
      <line x1={14} y1={70} x2={202} y2={70} className="ga-line" />
      <text x={28} y={100} className="ga-t ga-mono"><tspan className="ga-accent">$</tspan> claude</text>
      <rect x={86} y={90} width={7} height={13} className="ga-caret ga-blink" />
      <text x={28} y={130} className="ga-s ga-mono">or: codex</text>
      <path d="M210 100H238" className="ga-arc" />
      <path d="M233 95l6 5-6 5" className="ga-arrow" />
      <rect x={250} y={40} width={176} height={120} rx={10} className="ga-canvas" />
      <g className="ga-pop">
        <Node x={278} y={80} w={120} title="my-project" sub="Opus 5 · live" tone="accent" />
      </g>
    </Board>
  );
}

function AccountsArt() {
  return (
    <Board>
      {/* Sized to hold the second row's state line — the panel used to end at
          180 with that line drawn at 182, and the word poked out under the
          card. Reported from a screenshot. */}
      <Screen x={14} y={16} w={232} h={170} />
      <text x={28} y={40} className="ga-t ga-strong">Claude accounts</text>
      <Glyph x={196} y={33} d="M7 2.2v9.6M2.2 7h9.6" />
      <Glyph x={220} y={33} d="M3.3 10.7L10.7 3.3M5.2 3.3h5.5v5.5" />
      <line x1={14} y1={52} x2={246} y2={52} className="ga-line" />
      <Account x={28} y={74} email="work@team.dev" state="working" tone="ok" bars={[24, 61]} />
      <rect x={190} y={62} width={44} height={18} rx={9} className="ga-accent" />
      <text x={212} y={74} className="ga-s ga-on-accent" textAnchor="middle">active</text>
      <line x1={14} y1={140} x2={246} y2={140} className="ga-line" />
      <Account x={28} y={160} email="personal@me.dev" state="signed in" tone="ok" />
      <rect x={188} y={148} width={46} height={18} rx={9} className="ga-chip" />
      <text x={211} y={160} className="ga-s" textAnchor="middle">switch</text>
      <Pointer x={221} y={161} />

      <path d="M250 40C270 40 262 78 282 78" className="ga-arc" />
      <path d="M277 74l5 4-5 4" className="ga-arrow" />
      <Screen x={282} y={62} w={144} h={64} label="ANOTHER MACHINE" />
      <g className="ga-pop">
        <Account x={296} y={92} email="work@team.dev" state="shared here" tone="ok" />
      </g>
    </Board>
  );
}

/** The last picture of the Local network guide, told as the welcome's sixth:
 *  both switches on, and a login crossing to the machine that lost it. */
function LanSyncArt() {
  return (
    <Board>
      <Screen x={14} label="THIS MACHINE" />
      <LanHead x={28} y={60} />
      <g className="ga-swap-out">
        <Account x={28} y={98} email="work@team.dev" state="login expired" tone="warn" />
      </g>
      <g className="ga-swap-in">
        <Account x={28} y={98} email="work@team.dev" state="working again" tone="ok" bars={[24, 61]} />
      </g>
      <Screen x={250} label="ANOTHER MACHINE" />
      <LanHead x={264} y={60} />
      <Account x={264} y={98} email="work@team.dev" state="working" tone="ok" bars={[24, 61]} />
      <path d="M246 120C234 80 206 80 194 120" className="ga-arc" />
      <g className="ga-travel ga-travel-low" transform="translate(220 90)">
        <KeyGlyph />
      </g>
    </Board>
  );
}

export const WELCOME_STEPS: GuideStep[] = [
  { art: <WaitingArt />, line: "Sessions waiting on you rise to the top, longest wait first." },
  { art: <TreeArt />, line: "Every agent and subagent is a node. Tool calls light up as they run." },
  { art: <CostArt />, line: "What each session costs, and how much quota is left." },
  { art: <StartArt />, line: "Run claude or codex in any folder. It shows up here on its own." },
  { art: <AccountsArt />, line: "Several Claude accounts: switch, add one, share one to another machine." },
  {
    art: <LanSyncArt />,
    line: "Your machines repair each other's expired logins over the local network.",
    tip: "Local network is the last section of the Claude accounts panel.",
  },
];

// ── local network ───────────────────────────────────────────────────────────

function LanProblemArt() {
  return (
    <Board>
      <Screen x={14} label="THIS MACHINE" />
      <Account x={28} y={64} email="work@team.dev" state="login expired" tone="warn" />
      <rect x={40} y={94} width={86} height={20} rx={10} className="ga-pill-warn" />
      <text x={83} y={108} className="ga-s ga-warn" textAnchor="middle">sign in again</text>
      <line x1={198} y1={100} x2={242} y2={100} className="ga-off" />
      <Screen x={250} label="ANOTHER MACHINE" />
      <Account x={264} y={64} email="work@team.dev" state="working" tone="ok" bars={[24, 61]} />
    </Board>
  );
}

function LanPairArt() {
  return (
    <Board>
      <Screen x={14} label="THIS MACHINE" />
      <LanHead x={28} y={60} />
      <Peer x={28} y={92} name="Ana's MacBook" />
      <Peer x={28} y={114} name="Dorin's PC" />
      <Screen x={250} label="ANOTHER MACHINE" />
      <LanHead x={264} y={60} />
      <Peer x={264} y={92} name="Your MacBook" />
      <Peer x={264} y={114} name="Dorin's PC" />
      <line x1={196} y1={100} x2={244} y2={100} className="ga-arc" />
      <circle cx={220} cy={100} r={10} className="ga-ring ga-ping" />
      <circle cx={220} cy={100} r={10} className="ga-ring ga-ping ga-ping-2" />
      <circle cx={220} cy={100} r={3} className="ga-accent" />
    </Board>
  );
}

function LanShareArt() {
  return (
    <Board>
      <rect x={90} y={18} width={260} height={164} rx={10} className="ga-screen" />
      <text x={106} y={42} className="ga-t ga-strong">This deck on the network</text>
      <line x1={90} y1={54} x2={350} y2={54} className="ga-line" />
      <text x={106} y={76} className="ga-cap">SHARE THESE ACCOUNTS</text>
      <Check x={106} y={88} on />
      <text x={126} y={98} className="ga-t ga-mono">work@team.dev</text>
      <Check x={106} y={112} />
      <text x={126} y={122} className="ga-s ga-mono">personal@me.dev</text>
      <text x={106} y={150} className="ga-cap">PAIRING</text>
      <text x={106} y={168} className="ga-s">Say yes to every deck that asks</text>
      <Switch x={304} y={157} on />
      <Pointer x={115} y={97} />
    </Board>
  );
}

function LanRepairArt() {
  return (
    <Board>
      <Screen x={14} label="THIS MACHINE" />
      <g className="ga-swap-out">
        <Account x={28} y={64} email="work@team.dev" state="login expired" tone="warn" />
      </g>
      <g className="ga-swap-in">
        <Account x={28} y={64} email="work@team.dev" state="working again" tone="ok" bars={[24, 61]} />
      </g>
      <Screen x={250} label="ANOTHER MACHINE" />
      <Account x={264} y={64} email="work@team.dev" state="working" tone="ok" bars={[24, 61]} />
      <path d="M246 96C234 56 206 56 194 96" className="ga-arc" />
      <g className="ga-travel" transform="translate(220 66)">
        <KeyGlyph />
      </g>
    </Board>
  );
}

export const LAN_STEPS: GuideStep[] = [
  { art: <LanProblemArt />, line: "A login can expire on one machine while it still works on another." },
  {
    art: <LanPairArt />,
    line: "Turn this on, on both machines. They find each other and pair.",
    tip: "Not showing up? The + in the section reaches a machine by address or invite.",
  },
  { art: <LanShareArt />, line: "Tick which logins this machine may hand out. Nothing is shared until you do." },
  { art: <LanRepairArt />, line: "An expired login is copied from a paired machine within a minute." },
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
