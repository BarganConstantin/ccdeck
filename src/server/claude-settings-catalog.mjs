// Settings › Claude Code: the Claude Code settings the deck offers a control
// for, in its own words, and how each one is written to the user's
// settings.json.
//
// ONE TABLE FOR BOTH ENDS. The server checks every write against it
// (claude-settings.mjs) and the page draws one row per entry and indexes them
// for search (ClaudeCodeSettings.tsx, settings-search.ts), so a row can never
// offer a value the server would refuse, and a key the server does not know
// is never written.
//
// A SHORT LIST ON PURPOSE. Claude Code reads some two hundred and fifty keys
// (claude-settings-index.json lists them all, read-only). These are the ones
// a person running several sessions from the deck is likely to want and is
// unlikely to have found: plain switches and choices whose every value is
// safe to write. Permission modes, hooks, sandboxing, credentials and anything
// shaped as an object stay out, because a wrong press there is not undone by
// pressing again.
//
// THE DEFAULT IS AN ABSENT KEY. Choosing the value Claude Code uses when the
// key is unset removes the key rather than writing that value, so the file
// keeps only what the person changed, and a later change of default in Claude
// Code reaches them.
//
// ONLY A ROW THAT DOES WHAT IT SAYS. A key whose effect depends on the model
// is not here: `effortLevel` in the user file is ignored by Opus 5.5 and every
// model after it, which read `modelSettings` instead, and
// `alwaysThinkingEnabled: false` does nothing on a model that always thinks.
// Both are better changed where Claude Code shows the model, with /effort and
// /model.

export const CLAUDE_SETTINGS_DOCS = "https://code.claude.com/docs/en/settings-reference";

/** The captions the rows are drawn under, in the order they are drawn. */
export const CLAUDE_SETTING_GROUPS = [
  { id: "sessions", title: "Your sessions" },
  { id: "memory", title: "Memory and history" },
  { id: "git", title: "Git" },
  { id: "terminal", title: "Terminal" },
  { id: "updates", title: "Updates" },
];

/**
 * kind:
 *   switch      a Boolean key; `unset` is what Claude Code does without it
 *   choice      a string key from `options`; `null` is the absent key
 *   days        a whole number of days from `options`
 *   allowTool   a bare tool name in permissions.deny; on is "not denied"
 *   attribution `attribution: false` when off, the key absent when on
 *
 * since: the oldest Claude Code that reads the value the row writes. Older
 *   ones ignore it, or for `attribution: false` skip the whole settings file
 *   over it, so the row is not written while the version cannot be read.
 *
 * overrides: environment variables Claude Code's reference says outrank the
 *   key, each with the value that does (`on`: 1, true, yes; `off`: 0, false,
 *   no) and what it makes of the row. Read from the `env` block of the files
 *   the deck reads, and from the deck's own environment.
 *
 * legacy: a value an older Claude Code kept in ~/.claude.json still applies
 *   while no settings file sets the key.
 */
export const CLAUDE_SETTINGS = [
  {
    id: "crossSessionInbound", key: "crossSessionInbound", group: "sessions", kind: "choice", since: "2.1.224",
    label: "Messages from other sessions",
    note: "What a session does when another of your Claude Code sessions sends it a message.",
    options: [
      { value: null, label: "Claude Code decides" },
      { value: "accept", label: "Accept" },
      { value: "hold", label: "Ask me first" },
      { value: "refuse", label: "Refuse" },
    ],
    keywords: ["peers", "cross-session", "sendmessage", "inbox", "other sessions", "messaging"],
  },
  {
    id: "listAgents", key: "permissions.deny", tool: "ListAgents", group: "sessions", kind: "allowTool", since: "2.1.224",
    label: "Let sessions find each other",
    note: "On, Claude can list your other sessions, with each one's folder and whether it is busy. Off adds a deny rule for ListAgents.",
    keywords: ["listagents", "peers", "see other sessions", "privacy", "isolation", "list agents"],
  },
  {
    id: "isolatePeerMachines", key: "isolatePeerMachines", group: "sessions", kind: "switch", unset: false, since: "2.1.224",
    label: "Ask before messaging other machines",
    note: "Claude asks you before a message leaves this computer for a session on another machine or in the cloud.",
    keywords: ["remote control", "cloud", "cross-machine", "approval"],
  },
  {
    id: "autoMemoryEnabled", key: "autoMemoryEnabled", group: "memory", kind: "switch", unset: true,
    label: "Auto memory",
    note: "Claude keeps notes it learns while working and reads them in later sessions. Off, it does neither.",
    overrides: [
      { env: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", when: "on", effect: "Off" },
      { env: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", when: "off", effect: "On" },
    ],
    keywords: ["memory", "remember", "notes", "memory.md"],
  },
  {
    id: "autoCompactEnabled", key: "autoCompactEnabled", group: "memory", kind: "switch", unset: true,
    label: "Compact automatically",
    note: "Claude summarizes a long conversation when it nears the context limit, so the session can go on.",
    overrides: [{ env: "DISABLE_AUTO_COMPACT", when: "on", effect: "Off" }],
    keywords: ["compact", "context", "summarize", "context window"],
  },
  {
    id: "cleanupPeriodDays", key: "cleanupPeriodDays", group: "memory", kind: "days", unset: 30,
    label: "Keep conversations",
    note: "Older conversations are deleted without a message and leave the resume list.",
    options: [7, 14, 30, 90, 180, 365, 3650],
    keywords: ["transcripts", "history", "retention", "delete", "resume", "cleanup"],
  },
  {
    id: "fileCheckpointingEnabled", key: "fileCheckpointingEnabled", group: "memory", kind: "switch", unset: true,
    label: "Checkpoints for rewind",
    note: "Claude keeps a copy of each file before editing it, so a change can be rewound.",
    overrides: [{ env: "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", when: "on", effect: "Off" }],
    keywords: ["rewind", "checkpoint", "restore", "revert"],
  },
  {
    id: "attribution", key: "attribution", group: "git", kind: "attribution", since: "2.1.281",
    label: "Credit Claude in commits and pull requests",
    note: "Off, Claude adds no Co-Authored-By line to commits and no attribution line to pull requests.",
    keywords: ["co-authored-by", "co-author", "trailer", "generated with", "commit message", "pull request", "attribution"],
  },
  {
    id: "spinnerTipsEnabled", key: "spinnerTipsEnabled", group: "terminal", kind: "switch", unset: true,
    label: "Tips while Claude works",
    note: "The tip under the spinner while a turn is running.",
    keywords: ["spinner", "tips", "hints"],
  },
  {
    id: "showTurnDuration", key: "showTurnDuration", group: "terminal", kind: "switch", unset: true, legacy: true,
    label: "Show how long a turn took",
    note: "The line after each turn that says how long Claude worked.",
    keywords: ["duration", "time", "timer"],
  },
  {
    id: "prefersReducedMotion", key: "prefersReducedMotion", group: "terminal", kind: "switch", unset: false,
    label: "Reduce motion",
    note: "Fewer animations in the terminal, such as the spinner, shimmer and flash effects.",
    keywords: ["animation", "motion", "accessibility", "spinner"],
  },
  {
    id: "autoUpdatesChannel", key: "autoUpdatesChannel", group: "updates", kind: "choice",
    label: "Update channel",
    note: "Stable follows a version about a week old and skips releases with major regressions.",
    overrides: [
      { env: "DISABLE_UPDATES", when: "on", effect: "Updates are off" },
      { env: "DISABLE_AUTOUPDATER", when: "on", effect: "Background updates are off" },
    ],
    options: [
      // `claude install latest` writes the default out, so it reads as this.
      { value: null, label: "Latest", also: "latest" },
      { value: "stable", label: "Stable" },
    ],
    keywords: ["updates", "release channel", "stable", "latest", "version"],
  },
];

/** The entry for an id, or undefined for any id the table does not hold. */
export function claudeSettingById(id) {
  return CLAUDE_SETTINGS.find(entry => entry.id === id);
}

/** The label a `days` row shows for a number of days. */
export function daysLabel(days) {
  if (days === 3650) return "10 years";
  if (days === 365) return "1 year";
  return days === 1 ? "1 day" : `${days} days`;
}
