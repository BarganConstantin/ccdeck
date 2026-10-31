# V4 frontend handoff: the Command Panel

What a frontend developer needs to start on CCDeck V4 from `next/v4`: how to
run it, what the Command Panel is made of, which parts can be reshaped freely
and which carry a lifecycle or a contract, and what is known not to work yet.

`next/v4` is the V4 line. It is not released: nothing on it goes to npm, to a
tag or to `development`/`main` until the owner says so. Pull requests target
`next/v4`, and a pull request merges only with these eight checks green, on
GitHub-hosted runners: `typecheck`, `floor (node 18)`, `test` on Ubuntu, macOS
and Windows, and `desktop` on the same three.

## What is on the branch

- Everything on `development` up to `500a69bf`, the commit `next/v4` started
  from.
- The Command Panel's public side: the stage (an xterm.js terminal laid over
  the board's right-hand side), its navigator, the Settings switch, the HTTP
  routes and the WebSocket relay, and the adapter that talks to the optional
  local engine (`src/server/pro-engine-*.mjs`, `command-panel-engine.mjs`).
- The UTF-8 relay fixes (whole characters across frames and where xterm.js
  splits a long write) and the CI that runs the real-tmux cases on Linux and
  macOS (`Install tmux` in `publish.yml`).
- Two terminal fixes: the cursor blinks as a native terminal's does, except
  under reduced motion; and the first keyless text after a key was let go
  elsewhere (Ctrl+Shift+X, Alt+Tab, then an emoji panel or dictation) is no
  longer lost (`forgetKeyInFlight`, `use-terminal-session.ts`).

Not on it: image and file drop into the terminal (a separate feature, not
merged), and anything account-related (planned as its own pull requests; no
Free feature will need an account).

## Setup

Requirements: Node 18 or later (CI's floor; 22 or 24 is what most of the work
ran on), npm, and for the Command Panel's real-tmux tests tmux 3.2 or later on
Linux or macOS.

```sh
git clone https://github.com/BarganConstantin/ccdeck.git
cd ccdeck
git switch next/v4
npm ci
npm run typecheck      # tsc --noEmit -p tsconfig.build.json
npm run build
npm test               # the whole vitest suite, about two minutes
```

A development deck that leaves an installed CCDeck alone: its own data folder,
its own port, off the local network.

```sh
# terminal 1: the deck's server on 4318, its state in a scratch folder
CCDECK_HOME="$(mktemp -d)" AGENTS_DECK_NO_LAN=1 AGENT_DAG_PORT=4318 npm run dev:server

# terminal 2: vite with hot reload, proxying /api and the terminal's socket to 4318
CCDECK_DEV_SERVER_PORT=4318 npm run dev:web
# open http://localhost:5174/
```

`npm start` runs the built app the way the package does (`bin/agent-dag.js`).

## Turning the Command Panel on

It is off by default, and with it off the deck is exactly the deck without it:
its routes answer the same 404 as a path that does not exist, its socket is
refused, no engine is looked for and none of the stage's code is loaded.

- In the app: **Settings › Experimental › Command Panel**.
- By hand: `"terminal": true` in `prefs.json` in the deck's data folder
  (`CCDECK_HOME` when set). Only a real `true` counts.

No environment variable or launch flag turns it on, and none points the deck
at an engine (`terminal-flag-off.test.ts` holds that).

### What you will see

The Command Panel's sessions are run by an optional local engine that is not
part of this repository and is not distributed with it. The deck looks for one
only in `<data folder>/engine` and trusts only the Ed25519 keys it ships with,
a list that is empty on this branch (`docs/contracts/pro-engine-host-v1.md`).
So on a checkout of `next/v4`:

| Platform | With the switch on |
| --- | --- |
| Linux, macOS | The stage opens over the board; a session's pane shows "The Command Panel's engine is not installed on this machine." with **Check again** and **Not now** (or "could not be verified" if an `engine` folder exists). |
| Windows | The switch is disabled while off and reads "Not yet available on this platform." |

This is enough to work on the stage's frame: the header and its hue spine, the
state cards, the keys bar, the divider and its column detents, the navigator,
the open and close morph, the Settings section, light and dark themes, narrow
windows and takeover. A **live terminal** (an agent's output streaming in,
typing into it, resize, reconnect) is not reachable from a public checkout
today; see "Live terminal for UI work" under Open items. The component tests
(`terminal-stage-view.test.ts`, `use-terminal-session.test.ts`,
`terminal-stage-model.test.ts`) render and drive those states with stand-ins.

## How it is built

**The first-load rule.** `use-stage.ts` and `components/StageSlots.tsx` are in
the first-load chunk and hold only state and callbacks; the stage, the
navigator, the morph and xterm.js are behind `loadStageShell`'s dynamic
import and `React.lazy`. With the switch off none of it loads
(`terminal-stage-lazy.test.ts`). The stage's CSS (`styles/terminal-stage.css`,
`stage-shell.css`, `board-navigator.css`) is global; only xterm's own sheet is
lazy (`xterm-sheet.ts`).

**Free to restyle or restructure**, with the constraint noted:

| File (`src/web/`) | Role | Keep |
| --- | --- | --- |
| `components/terminal/StageHeader.tsx` | Hue spine and status line | No moving light under reduced motion |
| `components/terminal/StageBody.tsx` | The state cards (waiting, errors, ended) | The xterm host element stays mounted and is only hidden |
| `components/terminal/KeysBar.tsx` | Who has the keys, and the asks | The owner sentence is deliberately not a live region |
| `components/terminal/stage-icons.tsx` | Glyphs | `aria-hidden` |
| `components/terminal/NewSessionPopover.tsx` | The launch form | |
| `components/terminal/HostsDialog.tsx` | Windows older-host review | Portaled to `<body>` (`panel-modal-portal.test.ts`) |
| `components/terminal/Divider.tsx` | The stage's width handle | `role="separator"`, exactly one `tabIndex` (`canvas-keyboard.test.ts`) |
| `components/TerminalSection.tsx` | The Settings switch | |
| `styles/terminal-stage.css`, `stage-shell.css`, `board-navigator.css` | Layout and look | Tokens only, no new hex values |

**Lifecycle- or contract-bound**: change these only with their tests, and
expect review on the behaviour, not the look.

| File (`src/web/`) | What it carries |
| --- | --- |
| `components/terminal/TerminalStage.tsx` | The one door to xterm: focus, type-ahead, the quiet page, the leave guard, the desktop app's keys IPC |
| `components/terminal/StageShell.tsx` | The lazy entry; its prop wiring is pinned |
| `use-terminal-session.ts` | One xterm for the stage's life; reset and seed before reveal; resize settles 120 ms before one SIGWINCH; an ack every 64 KiB against the server's 512 KiB window; reconnect backoff; xterm options pinned by source tests |
| `use-stage.ts`, `components/StageSlots.tsx` | The switch, `inert` on the board under the stage, the lazy door |
| `use-focus-request.ts`, `use-full-stage.ts`, `use-pane-room.ts`, `use-older-hosts.ts` | Focus hand-off, takeover, pane room, Windows hosts |
| `panel-launch.ts`, `codex-launch.ts` | What a launch from the panel started, and the Codex claim |
| `terminal-api.ts`, `terminal-protocol.ts` | The page's half of the contract; `terminal-protocol.ts` imports nothing |
| `terminal-keys.ts`, `terminal-replies.ts`, `terminal-links.ts`, `terminal-palette.ts` | Key routing, terminal replies left to tmux, OSC 8 links, the palette |

The state machines are pure modules with their own tests: `stage-shell.ts`
(closed, waiting, opening, open, closing), `components/terminal/stage-model.ts`
(the `StagePhase` union and its words), `stage-geometry.ts`, `stage-morph.ts`,
`stage-board.ts`, `older-hosts.ts`.

## Contracts the UI depends on

Machine-readable: `docs/contracts/terminal-v1.schema.json` (routes, socket
limits, message kinds; checked by `terminal-v1-contract.test.ts`). The deck's
side of the engine: `docs/contracts/pro-engine-host-v1.md`.

HTTP, all under `/api/terminal/` (`src/server/terminal-routes.mjs`):

| Route | Purpose |
| --- | --- |
| `GET status` | Is tmux here and new enough (no paths) |
| `GET target` | Can this session be attached, and how |
| `GET hosts` | Sessions on an older Windows session host |
| `POST open` | A single-use ticket for the socket, or why not |
| `POST adopt` | Reopen a session started outside the deck, here |
| `POST launch` | Start a new agent in a deck-owned session |
| `POST claim` | Is this new Codex the one a launch started |
| `POST hosts/end` | End the sessions on one older host, as reviewed |

A refusal is `{ ok: false, error, code }`: 409 for a state of this machine the
panel can say (`unsupported`, `not-installed`, `not-verified`, `no-terminal`,
`failed`), 503 for a moment it waits out (`restarting`, `busy`, `no-answer`).
`error` is one sentence with no path in it; the page matches on `code`.

The page never names a pane. It names a session (an id, a provider, a folder);
the server works out which pane, and a ticket's binding stays in the server.

WebSocket `/api/terminal/attach?ticket=` (`src/server/terminal-socket.mjs`,
`src/web/terminal-protocol.ts`): loopback Host and a matching Origin only, at
most four sockets, tickets single-use for 30 s. The server sends `hello`,
`tmux`, `replies`, `reset` followed by one binary seed, `size` and `exit`; the
page sends binary input in chunks of at most 64 KiB and `size`, `paste`,
`colours` and `ack` messages. Messages over 1 MiB are refused.

## Requirements a redesign keeps

- **Themes.** Every xterm colour slot is a design token from the palette
  snapshot (`terminal-palette.ts`); the terminal draws on `--panel`, its font is
  `--font-mono`, and text keeps a 4.5:1 contrast floor in light and dark
  (`terminal-palette.test.ts`).
- **Motion.** Under reduced motion the cursor does not blink, the header's
  light does not travel and the morph takes no time. Otherwise the morph is
  280 ms open, 200 ms close on
  `cubic-bezier(0.32, 0.72, 0, 1)` (`DESIGN.md`, "The one exception is
  distance").
- **Accessibility.** xterm's `screenReaderMode` stays off: streaming agent
  output into a live region is the anti-pattern #372 removed. Changes are
  announced once, through the deck's single `role="status"` region. The board
  is `inert` under the stage. Every control has an accessible name; glyphs are
  `aria-hidden`.
- **Keyboard.** Ctrl+Shift+X gives the keys back to the board
  (`terminal-keys.ts` says why that chord). In the pane: Shift+Enter sends ESC
  CR, which the agents read as a new line, Ctrl+Shift+C copies, macOS Option
  acts as Meta. On the
  board: j/k step through sessions, Enter or i focus the pane, n/w jump to the
  next session that asks.
- **Widths** (`stage-geometry.ts`). Narrow below 1100 px; the width is kept as
  whole columns, with detents at 80, 100, 120 and 160 and at least 80 columns;
  the stage takes the whole cell when the range collapses. Opening the stage
  never resizes the canvas under it.
- **The switch off is the deck unchanged** (decision 9 in the code comments):
  no effect touches the page with it off.

### Tests that pin source text

These read a source file and match it, so a refactor updates them
deliberately in the same pull request. Never delete or loosen one to make a
change pass; change the expectation to the new truth and say why.

`terminal-stage-lazy.test.ts`, `terminal-stage-view.test.ts`,
`use-terminal-session.test.ts` (xterm options, middle-click paste, the cursor,
the key in flight, xterm's own source), `quiet-page.test.ts`,
`tab-keys.test.ts`, `desktop-terminal-keys.test.ts`,
`terminal-stage-glyph-weight.test.ts`, `stage-shell.test.ts`,
`terminal-palette.test.ts`, `terminal-protocol.test.ts`,
`canvas-keyboard.test.ts`, `render-path-cost-612-613.test.ts`.

## Known limits

- **Right to left.** Arabic, Persian and Hebrew arrive and are kept exactly,
  but are drawn left to right with letters unjoined: xterm.js 6 has no bidi.
- **Widths.** For Thai, Hindi and some emoji lines xterm.js (Unicode 15
  graphemes) and tmux count different widths, so a cursor drawn after such
  text can sit off by the difference, for example after a pane is reopened.
- **Windows.** No production Command Panel on Windows yet; the session host
  path exists only as a test preview (`preview/command-panel-windows.mjs`, not
  shipped). The words switch from tmux to "session host" when
  `terminalWindows` is true.
- **Manual acceptance.** The Linux stage passes its automated browser checks;
  manual acceptance on physical macOS and Windows desktops has not been done.

## Open items

- **Live terminal for UI work.** A frontend developer cannot see a live pane
  from a public checkout. The JS backend that the engine is checked against
  (`src/server/terminal-js-routes.mjs`, tests only) could serve a development
  preview outside the shipped files, as the Windows preview does; that is an
  owner decision, because it is a way to run the panel without the engine.
- **Release blockers** (V4 is not released while any is open): the real-agent
  acceptance programme stands at 25 of 38 scenarios (M-24), and that is a
  blocker, not a pass; the calibration against real agents is not ready;
  manual platform acceptance (above); signing, the installer and the updater
  for a build that carries the engine; licensing.
- **Accounts** are planned separately: no Free feature will need an account.
