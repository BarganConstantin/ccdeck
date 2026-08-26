// How the browser NAMES the CLIs it watches. providers.ts holds the fact; this
// holds the words, and derives them from that fact instead of asserting them.
//
// Every string here replaces one that was written when the deck watched a single
// CLI and was never revisited when the second one landed (#404). The worst of
// them was the empty-state hint, which told a Codex user to install hooks: the
// deck stopped installing Codex hooks in the very commit that introduced Codex
// support, `installHooks` throws on that provider now, and the file the copy
// named — ~/.codex/hooks.json — is opened by nothing but the uninstaller. So a
// user whose canvas was empty for one of the three real reasons (started with
// --no-codex, no rollout written yet, CODEX_HOME pointing at another tree)
// hand-wrote a file the deck never reads and then hunted for a trust prompt that
// no longer exists.
//
// The fix is not to soften those sentences until they are true of everything.
// A deck that is not watching Codex can say so — /api/health reports `providers`
// since #402 — and "Codex capture is off" is both true and the one sentence that
// ends the search. Vagueness would have been the other way out and it helps
// nobody: a hint that names no path, no flag and no variable is a hint a user
// cannot act on.
//
// Kept out of App.tsx for the same reason scope.ts and providers.ts are: these
// branches can then be read and tested without rendering React, and the branch
// that matters most is the one nobody exercises by hand — a Codex-only machine.
import type { Providers } from "./providers";

/**
 * The CLIs this deck watches, named for the middle of a sentence.
 *
 * `null` when it watches neither — `--no-claude --no-codex`, which is a legal
 * pair of flags. Naming a CLI there would be a claim about logs this deck is
 * not reading, so the caller drops the qualifier instead.
 */
function providerNames(p: Providers): string | null {
  if (p.claude && p.codex) return "Claude Code and Codex";
  if (p.claude) return "Claude Code";
  if (p.codex) return "Codex";
  return null;
}

/**
 * The names ccusage's own agent ids do not title-case into.
 *
 * ccusage reports one lowercase id per CLI it read — `claude`, `codex`,
 * `opencode`, `amp`, `droid`, `gemini` and a dozen more — and the deck prints
 * them beside dollar figures, so they have to be the names the products go by.
 * Only the ones a title-case cannot reach are listed: `claude` and `codex`
 * because this deck has always called them Claude Code and Codex, and the four
 * that carry an internal capital or a suffix in ccusage's own table. Everything
 * else — Amp, Droid, Goose, Gemini, Grok, Kilo, Kimi, Qwen, Codebuff, Hermes —
 * title-cases correctly and is deliberately NOT enumerated here: an id this
 * deck has never seen is far likelier to be a CLI ccusage learned about after
 * this line was written than a mistake, and printing it title-cased is a better
 * answer than dropping it or shipping a table that goes stale in silence.
 */
const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  copilot: "GitHub Copilot",
  pi: "pi-agent",
};

/** One of ccusage's agent ids, as a name to print. Unknown ids are title-cased
 *  rather than passed through raw, so a CLI added to ccusage after this build
 *  still reads as a product name; an empty id comes back empty.
 *
 *  `hasOwn` rather than truthiness (#474). The id is whatever ccusage put in its
 *  JSON, and an inherited member is truthy: `AGENT_NAMES["constructor"]` is a
 *  function, which would be printed beside a dollar figure instead of a name. */
export function agentLabel(id: string): string {
  const key = id.toLowerCase();
  if (Object.hasOwn(AGENT_NAMES, key)) return AGENT_NAMES[key];
  return key ? key[0].toUpperCase() + key.slice(1) : "";
}

/** A list of names for the middle of a sentence: "A", "A and B", "A, B and C".
 *  No Oxford comma, matching providerNames above, which has said "Claude Code
 *  and Codex" since it was written. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the usage-history modal says it is showing, under its title.
 *
 * The line used to be the constant "via ccusage · local Claude / Codex logs",
 * and #431 is about the gap between its two halves: it named two CLIs and the
 * chart below then added them together, so the subtitle promised a distinction
 * the panel refused to make. It was also wrong in a second direction nobody had
 * noticed — ccusage reads sixteen CLIs, not two, so a machine running OpenCode
 * had its spend in that number under a subtitle that denied it existed.
 *
 * So the line is derived, and from the run when there is one. `found` is the
 * agent ids the range actually came back with, which is a MEASUREMENT of whose
 * logs are in the figures on screen; `providers` is what the deck was started
 * to watch, which is a different fact and can honestly disagree — a deck run
 * with `--no-codex` still gets Codex spend out of ccusage, because ccusage
 * reads the logs on the machine rather than the deck's flags.
 *
 * The measurement wins when it exists, and `providers` is the fallback for
 * every state where there is nothing to measure: the first render, a run still
 * going, a run that failed, an empty range, and a ccusage too old to report the
 * split at all. That is the case #402 put `providers` in /api/health for — it
 * is the only thing that can keep a Claude-only machine from being told about
 * Codex, and a Codex-only machine from being told about Claude Code, before any
 * data exists to say otherwise.
 *
 * A deck watching neither CLI names none, for the same reason providerNames
 * returns null there: "local logs" claims nothing that can turn out to be
 * false.
 */
export function usageSubtitle(p: Providers, found: readonly string[] = []): string {
  const names = found.length ? joinNames(found.map(agentLabel)) : providerNames(p);
  return names ? `via ccusage · local ${names} logs` : "via ccusage · local agent logs";
}

/** One run of the hint sentence. `code` marks the runs that render in <code>,
 *  which is every path, flag and variable in it — the parts a user retypes. */
export interface HintSpan {
  text: string;
  code?: boolean;
}

/** What the empty canvas is allowed to say about one capture path. */
export interface CaptureHint {
  /** Which path this line is about, and the React key for it. */
  provider: "claude" | "codex";
  /** False when this deck is not watching that CLI at all, which is the case
   *  the old copy could not express and the one that ends the search fastest. */
  watching: boolean;
  spans: HintSpan[];
}

/**
 * Why the canvas may still be empty, one line per capture path.
 *
 * Each line names what that path actually depends on, so the two never trade
 * advice: Claude Code depends on a hook entry in settings.json, and Codex
 * depends on nothing being installed at all — the server tails the rollout tree
 * itself. The three real reasons a Codex canvas stays empty are the flag, the
 * missing tree, and CODEX_HOME; none of them is a hook, and none of them was
 * named before.
 */
export function captureHints(p: Providers): CaptureHint[] {
  const claude: CaptureHint = p.claude
    ? {
        provider: "claude",
        watching: true,
        spans: [
          { text: "Claude Code sends its events through a hook in " },
          { text: "~/.claude/settings.json", code: true },
          { text: " — or in " },
          { text: "$CLAUDE_CONFIG_DIR/settings.json", code: true },
          { text: " when you have that set — which the deck installs on first run." },
        ],
      }
    : {
        provider: "claude",
        watching: false,
        spans: [
          { text: "Claude Code capture is off: no Claude Code was found on this machine, or the deck was started with " },
          { text: "--no-claude", code: true },
          { text: "." },
        ],
      };

  const codex: CaptureHint = p.codex
    ? {
        provider: "codex",
        watching: true,
        spans: [
          { text: "Codex installs nothing and needs no trust prompt — the deck reads " },
          { text: "~/.codex/sessions/", code: true },
          { text: " itself, so an empty canvas means no rollout has been written there yet, or that " },
          { text: "$CODEX_HOME", code: true },
          { text: " points at a different tree." },
        ],
      }
    : {
        provider: "codex",
        watching: false,
        spans: [
          { text: "Codex capture is off: no " },
          { text: "~/.codex/", code: true },
          { text: " was found — set " },
          { text: "$CODEX_HOME", code: true },
          { text: " if yours lives elsewhere — or the deck was started with " },
          { text: "--no-codex", code: true },
          { text: "." },
        ],
      };

  return [claude, codex];
}

/** What the finish-sound switch knows about itself. Read from localStorage
 *  and from the AudioContext, since #704 — there is no endpoint behind it. */
export interface FinishSoundState {
  /** Whether this tab is set to play the tones. Local to the tab since #704 —
   *  the deck plays them itself, so there is no settings.json entry to report. */
  on: boolean;
  /** True while the browser has not yet let this page make a sound. The
   *  autoplay rules hold an AudioContext suspended until the page has been
   *  interacted with, and a switch that says "on" over silence is the report
   *  this feature exists to stop generating. */
  locked: boolean;
}

/**
 * The finish-sound switch's tooltip — including the turns it does NOT cover.
 *
 * The switch used to be one line in Claude Code's settings.json: a `Stop` hook
 * running a script the deck installed, which Claude Code executed at the end of
 * a turn. Nothing about that reached Codex — the deck installs no Codex hooks,
 * it tails the rollout JSONL files instead — so a Codex user turned this on,
 * watched turn after turn finish in silence, and had nothing anywhere to read it
 * against (#394). An unqualified "Sound on turn finish" was the whole of the
 * problem: the silence was correct behaviour and indistinguishable from a broken
 * toggle, so the sentence had to name the mechanism and not just the limit.
 *
 * #704 replaced the mechanism, and the limit moved with it. The tones are
 * synthesized in the tab from the envelopes the deck already receives, so what
 * they follow is the EVENT: a Codex `task_complete` is mapped to a synthetic
 * `Stop` (#395) and gets the finish tone like any other. Codex has no
 * `Notification` equivalent, so the second tone — Claude is waiting for you —
 * stays Claude Code's, and that asymmetry is said out loud rather than left for
 * a user to infer from a sound that never comes.
 *
 * What the change costs is one line and it is stated where the switch is: the
 * hook fired with no browser open, because it ran on the machine. A tab cannot.
 * For a dashboard whose normal state is left open that is a good trade, it was
 * weighed rather than overlooked (see finish-sound-scope.test.ts, which used to
 * argue the other side), and the same tab brings a second limit with it —
 * autoplay policy keeps an AudioContext suspended until the page has been
 * interacted with, so "on" over silence is a real state the copy has to name.
 */
export function finishSoundTitle(p: Providers, s: FinishSoundState): string {
  // The key in parentheses is how every other control on this bar names its own.
  const lead = s.on
    ? "Sound: on — a tone when a turn finishes, another when Claude asks for you (M)"
    : "Sound: off — click for a tone when a turn finishes (M)";

  // Since #704 the deck plays the tones itself, from the events it already
  // receives, so this no longer says "Claude Code turns only" — a Codex rollout
  // emits a Stop the same way and gets the same tone. What Codex has no
  // equivalent of is Notification, so the asking tone stays Claude Code's, and
  // that is worth saying on a machine that runs both rather than leaving the
  // user to notice the asymmetry on their own.
  const scope = p.codex
    ? "\n\nBoth CLIs get the finish tone. The second tone — Claude is waiting for you — " +
      "has no Codex equivalent to fire on, so it only ever plays for Claude Code."
    : "";

  // The autoplay rules, stated where the switch is rather than left as silence
  // the user has to explain to themselves. A browser will not make a sound
  // until the page has been interacted with, so a reloaded tab nobody has
  // touched is armed and mute — and "on, but nothing happened" is exactly the
  // report that used to arrive about the old hook.
  const locked = s.on && s.locked
    ? "\n\nWaiting for a click: this browser plays no sound until the page has been " +
      "used at least once. Anything you press unlocks it."
    : "";

  return lead + scope + locked;
}
