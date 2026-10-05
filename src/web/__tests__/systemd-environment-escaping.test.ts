// The login item's Environment= lines carry every value whole.
//
// unitFor writes each variable as `Environment="NAME=value"`, which is right —
// unquoted, systemd splits the assignment on whitespace — but it escaped only
// `%` inside the quotes. systemd.syntax(7) reads C escapes there too, so a `"`
// in the value closes the quotes early and a `\` starts an escape. Handed to
// systemd 259's own parser (`systemd-analyze verify`, offline, on a unit in a
// temp folder):
//
//   Environment="CLAUDE_CONFIG_DIR=/home/ana/a "quote/.claude"
//     -> Invalid syntax, ignoring
//   Environment="CODEX_HOME=/home/ana/trailing\"
//     -> Invalid syntax, ignoring
//
// and a balanced pair, or `\s` in `back\slash`, is rewritten without a word:
// the deck then starts at login keyed to a config dir that is not the shell's.
//
// The cases read the line back the way systemd does — one word, quotes
// removed, C escapes undone inside them, `%%` a `%` — and require the value
// that went in.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const { unitFor } = await import("../../server/login-service.mjs");

/** One Environment= setting as systemd reads it: the NAME and the value. */
function readAssignment(setting: string): [string, string] {
  let word = "";
  let quoted = false;
  for (let i = 0; i < setting.length; i++) {
    const c = setting[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (c === "\\") {
      // An escape that ends the line is the unbalanced case systemd refuses.
      if (i + 1 >= setting.length) throw new Error(`systemd would refuse ${JSON.stringify(setting)}`);
      const next = setting[++i];
      if (!quoted) { word += next; continue; }
      if (next === "\\" || next === '"') { word += next; continue; }
      throw new Error(`systemd would read \\${next} as an escape in ${JSON.stringify(setting)}`);
    }
    if (!quoted && /\s/.test(c)) throw new Error(`systemd would split ${JSON.stringify(setting)} into words`);
    word += c;
  }
  if (quoted) throw new Error(`systemd would refuse unbalanced quotes in ${JSON.stringify(setting)}`);
  if (/%(?!%)/.test(word.replace(/%%/g, ""))) throw new Error(`systemd would expand a specifier in ${JSON.stringify(word)}`);
  const plain = word.replace(/%%/g, "%");
  const eq = plain.indexOf("=");
  return [plain.slice(0, eq), plain.slice(eq + 1)];
}

const environment = (unit: string) =>
  [...unit.matchAll(/^Environment=(.*)$/gm)].map(m => readAssignment(m[1]));

describe("the systemd unit's Environment= lines", () => {
  const job = { execPath: "/usr/bin/node", script: "/opt/ccdeck/bin/agent-dag.js", logPath: "/home/ana/deck.log", args: ["--no-open"] };

  it("keep a double quote and a backslash in a value as part of it", () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/home/ana/a "quote/.claude',
      CODEX_HOME: "/home/ana/back\\slash/.codex",
      AGENTS_DECK_HOME: "/home/ana/trailing\\",
      XDG_STATE_HOME: '/home/ana/say "hi" \\ 100%done $HOME',
    };
    expect(Object.fromEntries(environment(unitFor({ ...job, env }))))
      .toEqual({ AGENTS_DECK_DETACHED: "1", ...env });
  });

  it("leaves an ordinary value as it was written", () => {
    const unit = unitFor({ ...job, env: { CLAUDE_CONFIG_DIR: "/home/ana/.claude" } });
    expect(unit).toContain('Environment="CLAUDE_CONFIG_DIR=/home/ana/.claude"');
  });
});
