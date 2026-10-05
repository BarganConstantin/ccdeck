// The branch chip on a card: whether a card shows one, what it says, and how a
// long branch name is shortened to fit.
//
// A root card shows the branch of its session's repository. A subagent shows
// one only when it works in a folder of its own — the server sends a subagent
// its own GitObserved only then (src/server/git-watch.mjs), so a subagent with
// `git` set is exactly that case — and its chip takes the place of the folder
// name on the row, the folder moving into the tooltip. A detached HEAD shows
// its short SHA; a folder in no repository shows nothing. A deleted folder may
// still show the branch its session's own log recorded, and says so.
import type { AgentNodeData, GitFacts } from "./types";

export interface BranchChip {
  kind: "branch" | "detached";
  /** What the chip says at full length: the branch, or the short SHA. */
  name: string;
  /** The tooltip: every line a reader might want that the chip has no room for. */
  title: string;
  /** What a screen reader hears, which also says what pressing it does. */
  label: string;
}

/** The chip a card shows, or null for none. */
export function branchChip(a: Pick<AgentNodeData, "kind" | "git" | "cwd">): BranchChip | null {
  const g: GitFacts | undefined = a.git;
  if (!g) return null;
  const fromLog = g.state === "gone" && g.fromLog === true && typeof g.branch === "string" && g.branch !== "";
  if (g.state !== "repo" && !fromLog) return null;
  const detached = g.state === "repo" && g.detached === true;
  const name = detached ? (g.sha ?? "") : (g.branch ?? "");
  if (!name) return null;
  const lines: string[] = [];
  if (a.kind === "subagent" && a.cwd) lines.push(a.cwd);
  lines.push(detached ? `detached HEAD at ${name}` : name);
  if (g.unborn) lines.push("no commits on this branch yet");
  if (g.linkedWorktree && g.name && g.mainName) lines.push(`worktree ${g.name} of ${g.mainName}`);
  else if (g.nameDiffers && g.name) lines.push(`repository ${g.name}`);
  if (fromLog) lines.push("as the session's log last recorded it: its folder no longer exists");
  const said = detached ? `Detached HEAD at ${name}` : `Branch ${name}`;
  return { kind: detached ? "detached" : "branch", name, title: lines.join("\n"), label: `${said}. Open this agent's details` };
}

/**
 * The spellings to try for a branch name, longest first, keeping the part
 * people scan for — the last segment, and in it the ticket when it starts with
 * one:
 *
 *   feature/bargan/VCRM-9090 → feature/…/VCRM-9090 → …/VCRM-9090 → VCRM-9090
 *   …/VCRM-9090-make-the-invoice-builder → VCRM-9090…builder → VCRM-9090…
 *
 * and a last segment with no ticket is cut in its middle, down to six
 * characters. A last segment that is only a ticket is never cut.
 */
export function branchCandidates(name: string): string[] {
  const seg = name.split("/");
  const last = seg[seg.length - 1];
  const out = [name];
  if (seg.length > 2) out.push(`${seg[0]}/…/${last}`);
  if (seg.length > 1) out.push(`…/${last}`, last);
  const ticket = TICKET.exec(last)?.[0];
  if (ticket && ticket.length < last.length) {
    // The ticket stays whole; what follows it is cut from the front.
    for (let tail = last.length - ticket.length - 2; tail >= 3; tail--) out.push(`${ticket}…${last.slice(last.length - tail)}`);
    out.push(`${ticket}…`);
  } else if (!ticket) {
    for (let keep = last.length - 2; keep >= 6; keep -= 2) {
      const head = Math.ceil(keep * 0.6);
      out.push(`${last.slice(0, head)}…${last.slice(last.length - (keep - head))}`);
    }
  }
  return [...new Set(out)];
}

/** A ticket key at the start of a segment: `VCRM-9090`, `ABC-12`, `gh-1960`. */
const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+/;

/** The longest spelling `fits` accepts. When none does, the last segment
 *  whole, for the sheet's ellipsis to end: a cut word cut again reads as
 *  noise, and the start of the last segment is what a reader recognises. */
export function fitBranch(name: string, fits: (text: string) => boolean): string {
  const all = branchCandidates(name);
  return all.find(fits) ?? name.split("/").pop()!;
}

/** How many characters of a name with no ticket a chip keeps at the least. */
const FLOOR_CHARS = 8;

/**
 * The least a chip may say and still be worth reading: the ticket whole (with
 * the ellipsis when more of the segment follows it), or else the shortest
 * spelling that keeps eight characters of the name — the whole last segment
 * when it is shorter than that. Below it the chip asks its row for room
 * (`rowYields`), and with none left keeps its glyph alone.
 */
export function branchFloor(name: string): string {
  const last = name.split("/").pop()!;
  const ticket = TICKET.exec(last)?.[0];
  if (ticket) return ticket.length < last.length ? `${ticket}…` : ticket;
  const kept = (s: string) => s.replace(/…\/?/g, "").length;
  const least = Math.min(FLOOR_CHARS, last.length);
  const spellings = branchCandidates(name).filter(s => kept(s) >= least);
  return spellings[spellings.length - 1] ?? last;
}

/** What on a card's sub row may give way to the branch chip, in the order it
 *  goes: the word "session", which a root card's look already says, and then
 *  the model chip's `+N`, whose models its tooltip names. A subagent keeps its
 *  word — the card's only mark of what it is beside its name. */
export type RowYield = "kind" | "more";
export function rowYields(kind: AgentNodeData["kind"], otherModels: number): RowYield[] {
  const out: RowYield[] = [];
  if (kind === "root") out.push("kind");
  if (otherModels > 0) out.push("more");
  return out;
}

/** What the chip does with the room its row leaves it, in characters of its
 *  name: say the longest spelling that fits, or — when not even the floor
 *  does — ask the row for more room, and only when the row has nothing left
 *  to give, keep its glyph alone. A detached HEAD's short SHA is never cut. */
export type ChipFit = { give: true } | { give: false; label: string; bare: boolean };
export function fitChip(chip: Pick<BranchChip, "kind" | "name">, roomChars: number, canGive: boolean): ChipFit {
  const floor = chip.kind === "detached" ? chip.name : branchFloor(chip.name);
  const roomy = floor.length <= roomChars;
  if (!roomy && canGive) return { give: true };
  if (chip.kind === "detached") return { give: false, label: chip.name, bare: false };
  return { give: false, label: fitBranch(chip.name, text => text.length <= roomChars), bare: !roomy };
}
