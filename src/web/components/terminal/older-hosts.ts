// Sessions still running on an older session host (Windows): the one line the
// keys bar says about them, and what the Review dialog shows and does.
//
// WHY THERE ARE ANY. On Windows the sessions run in a session host, which a
// deck update replaces. A host the engine has moved on from keeps its
// sessions running — ending them is the reader's call, never an update's —
// but the Command Panel cannot open them, and while two generations are left
// the engine refuses new sessions (`host-generations`). A security update
// waits on them the same way.
//
// THE READER DECIDES, ON WHAT THEY SAW. End sends exactly the ids the dialog
// listed, with that host's generation; the engine refuses (`consent-outdated`)
// when the host's sessions are no longer those, and the list is read again so
// the reader reviews what is there now. Nothing here retries an end, and
// nothing ends a session the reader did not see.
//
// QUIET WHEN THERE IS NOTHING. Any failure to read — the panel off (404), a
// deck without a session host (`no-terminal`, Linux and macOS), an engine
// that did not answer — hides the line: it is a note about Windows hosts, not
// a state of the panel.
import {
  endHostSessions,
  terminalHosts,
  type ApiFailure,
  type HostsAnswer,
  type HostsEnded,
  type OlderHost,
  type TerminalProvider,
} from "../../terminal-api";

/** The two calls the flow makes, so the suite can answer them. */
export interface HostsApi {
  read(): Promise<HostsAnswer | ApiFailure>;
  end(order: { generation: number; sessions: readonly string[] }): Promise<HostsEnded | ApiFailure>;
}

export const HOSTS_API: HostsApi = {
  read: () => terminalHosts(),
  end: order => endHostSessions(order),
};

/** What the stage knows of the older hosts: those with sessions, and the
 *  engine's sentence while it refuses new ones. */
export interface HostsView {
  hosts: OlderHost[];
  launchesRefused: string | null;
}

/** The hosts as read, or null when there is nothing to say — or no answer. */
export async function readHosts(api: HostsApi): Promise<HostsView | null> {
  const answer = await api.read();
  if (!answer.ok) return null;
  const hosts = answer.hosts.filter(h => h.sessions.length > 0);
  return hosts.length || answer.launchesRefused ? { hosts, launchesRefused: answer.launchesRefused } : null;
}

/** Which sessions a view lists, so a choice to keep them is forgotten the
 *  moment the list is not the one the reader kept. */
export function hostsFingerprint(view: HostsView | null): string {
  return view ? view.hosts.map(h => `${h.generation}:${h.sessions.map(s => s.id).join(",")}`).join(";") : "";
}

const count = (n: number) => (n === 1 ? "1 session" : `${n} sessions`);

/** Appended to the line while the engine refuses new sessions. */
export const REFUSED_UNTIL_THEY_END = "New sessions are refused until they end.";

/**
 * The keys bar's line, or null when it has nothing to say. A host that closes
 * once its sessions end is listed in the dialog, not counted here: it asks
 * nothing of the reader. `kept`: the reader chose Keep them running.
 */
export function hostsLine(view: HostsView | null, kept: boolean): string | null {
  if (!view) return null;
  const listed = view.hosts.filter(h => h.state !== "draining");
  const n = listed.reduce((sum, h) => sum + h.sessions.length, 0);
  if (n === 0) return view.launchesRefused;
  const where = listed.length === 1 ? "an older session host" : "older session hosts";
  const said = kept
    ? `Kept running: the Command Panel cannot open ${n === 1 ? "that session" : `those ${n} sessions`} here.`
    : listed.some(h => h.state === "security")
      ? `A security update is waiting on ${count(n)} on ${where}.`
      : `${count(n)} still ${n === 1 ? "runs" : "run"} on ${where}.`;
  return view.launchesRefused ? `${said} ${REFUSED_UNTIL_THEY_END}` : said;
}

/** The dialog's sentence for why a host is listed. */
export function hostReason(host: OlderHost): string {
  switch (host.state) {
    case "stranded": return "The Command Panel has moved to a newer session host and cannot open these here.";
    case "security": return "A security update replaces this session host once these end.";
    case "draining": return "This session host closes once these end.";
  }
}

/** "Claude's", "Codex's", or both — whose history keeps the conversations. */
function historyOwners(agents: ReadonlySet<TerminalProvider>): string {
  const names = [agents.has("claude") ? "Claude's" : null, agents.has("codex") ? "Codex's" : null].filter(Boolean);
  return names.join(" and ") || "the agent's";
}

/** What ending them costs, and what it leaves: the dialog's two lines. */
export function hostsConsequences(view: HostsView): { ends: string; stays: string } {
  const agents = new Set(view.hosts.flatMap(h => h.sessions.map(s => s.agent)));
  return {
    ends: "Those agents, at once. Work they have not saved is lost.",
    stays: `Each conversation, in ${historyOwners(agents)} own history. On Windows the Command Panel cannot reopen it.`,
  };
}

/** The End button's words for `host`. */
export const endLabel = (host: OlderHost) => `End ${count(host.sessions.length)}`;

/** What an End press came to: the list read again (`view`, when it was),
 *  how many ended, and the sentence for the dialog. */
export interface EndOutcome {
  ended: number;
  /** Present when the list was read again; null then is nothing left. */
  view?: HostsView | null;
  said: string | null;
}

/**
 * Ends exactly the sessions `host` lists. Ended, or refused because the list
 * changed or the host went: the list is read again. Any other refusal is said
 * and the list kept; nothing is asked twice.
 */
export async function endHost(api: HostsApi, host: OlderHost): Promise<EndOutcome> {
  const answer = await api.end({ generation: host.generation, sessions: host.sessions.map(s => s.id) });
  if (answer.ok) return { ended: answer.ended, view: await readHosts(api), said: null };
  if (answer.code === "consent-outdated" || answer.code === "host-gone") {
    return { ended: 0, view: await readHosts(api), said: answer.error };
  }
  return { ended: 0, said: answer.error };
}

/** Whether a view still has sessions for the dialog to list. */
export const reviewable = (view: HostsView | null | undefined): view is HostsView => !!view && view.hosts.length > 0;
