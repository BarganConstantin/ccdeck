// Every value the systemd unit carries has to reach systemd as written.
//
// systemd expands `%` specifiers in a unit's settings — `%b` is the boot ID,
// `%d` the credentials directory, `%h` the home — and `$NAME` in ExecStart.
// unitFor escaped `%` in the Environment= lines only, with this very path as
// its own example: `/home/ana/100%backup`. StandardOutput=, StandardError= and
// ExecStart were written raw, so a deck home or an install path with a `%` in
// it named somewhere else by the time systemd used it. Measured against
// systemd 259's own parser (`systemd-analyze verify`, offline):
//
//   StandardOutput=append:/tmp/100%Qbackup/deck.log
//     -> Failed to resolve unit specifiers in /tmp/100%Qbackup/deck.log, ignoring
//   ExecStart=/bin/true /tmp/100%Qbackup
//     -> Failed to resolve unit specifiers … Unit configuration has fatal error
//
// and a specifier systemd DOES know, such as %b, is substituted without a word.
//
// The cases read the unit back the way systemd does — `%%` is a `%`, any other
// `%` is a specifier, `$$` is a `$`, words split on unquoted whitespace with C
// escapes — and require the paths that went in.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const { unitFor } = await import("../../server/login-service.mjs");

/** A value as systemd resolves it, or an error naming the specifier it would expand. */
function resolved(value: string): string {
  const lone = /%(?!%)/.exec(value.replace(/%%/g, ""));
  if (lone) throw new Error(`systemd would expand a specifier in ${JSON.stringify(value)}`);
  return value.replace(/%%/g, "%");
}

/** ExecStart's words as systemd splits and unescapes them. */
function execWords(line: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " ") i++;
    if (i >= line.length) break;
    let word = "";
    let quote: string | null = null;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") { word += line[++i]; continue; }
      if (quote) { if (c === quote) quote = null; else word += c; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === " ") break;
      word += c;
    }
    const loneDollar = /\$(?!\$)/.exec(word.replace(/\$\$/g, ""));
    if (loneDollar) throw new Error(`systemd would expand a variable in ${JSON.stringify(word)}`);
    words.push(resolved(word).replace(/\$\$/g, "$"));
  }
  return words;
}

const setting = (unit: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(unit)?.[1] ?? "";

describe("the systemd unit", () => {
  const job = {
    execPath: "/home/ana/100%tools/node/bin/node",
    script: "/home/ana/100%backup/ccdeck/bin/agent-dag.js",
    logPath: "/home/ana/100%backup/.claude/agent-dag/deck.log",
    args: ["--no-open", "--at-login"],
  };

  it("names the deck's own log, `%` and all, for both output streams", () => {
    const unit = unitFor(job);
    for (const key of ["StandardOutput", "StandardError"]) {
      const value = setting(unit, key);
      expect(value.startsWith("append:")).toBe(true);
      expect(resolved(value.slice("append:".length)), key).toBe(job.logPath);
    }
  });

  it("starts the node and the script it was given, `%` and all", () => {
    expect(execWords(setting(unitFor(job), "ExecStart"))).toEqual([job.execPath, job.script, ...job.args]);
  });

  it("keeps a `$`, a space, a quote and a backslash in a path as part of it", () => {
    const odd = { ...job, script: "/home/ana/$work/My \"Deck\"/back\\slash/agent-dag.js" };
    expect(execWords(setting(unitFor(odd), "ExecStart"))).toEqual([odd.execPath, odd.script, ...odd.args]);
  });

  it("leaves an ordinary path exactly as it was written", () => {
    const plain = { execPath: "/usr/bin/node", script: "/opt/ccdeck/bin/agent-dag.js", logPath: "/home/u/deck.log", args: ["--no-open"] };
    const unit = unitFor(plain);
    expect(setting(unit, "ExecStart")).toBe("/usr/bin/node /opt/ccdeck/bin/agent-dag.js --no-open");
    expect(setting(unit, "StandardOutput")).toBe("append:/home/u/deck.log");
  });
});
