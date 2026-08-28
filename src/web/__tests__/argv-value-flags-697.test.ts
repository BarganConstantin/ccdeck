// #697: a flag that takes a value ate the flag after it, and nothing said so.
//
// `--port`, `--workspace` and `--history` consumed the next token with
// `args[++i]` whatever it was, so a flag could swallow a flag. The eaten flag was
// never applied, the eating flag got a nonsense value, and `unknown` stayed
// empty — which meant the parser's one mechanism for saying "you typed something
// I did not use" could not fire, because the token that belonged on that list had
// already been eaten. The deck booted, printed a green tick beside the nonsense,
// and behaved as though the invocation had worked.
//
// Reproduced before the fix, from the module itself:
//
//     ["--workspace","--no-open"] -> {"unknown":[],"workspace":"--no-open"}
//     ["--workspace",""]          -> {"unknown":[],"workspace":""}
//     ["--history","--no-open"]   -> {"unknown":[],"history":"--no-open"}
//     ["--port","--no-open"]      -> {"unknown":[],"port":"--no-open"}
//     ["--workspace"]             -> {"unknown":[]}
//
// and end to end, with a sandboxed HOME:
//
//     $ node bin/deck.js --no-codex --no-open --workspace --no-persist
//       ✓  workspace       …/696-697-sandbox/cwd/--no-persist
//       ✓  server ready    http://127.0.0.1:4473
//     discovery record: "persist": "…/.claude/agent-dag/events.jsonl"
//
// `--no-persist` silently discarded, the deck writing to the machine-wide log it
// had been told not to touch, and scoped to a directory that does not exist so
// it would capture nothing for the rest of its life. Nothing on the "unknown
// option" row, because there was no unknown token.
//
// The likeliest way to hit it is not a typo. `ccdeck --workspace $PROJ
// --no-persist` with `PROJ` unset is, after POSIX word splitting, exactly
// `ccdeck --workspace --no-persist`; PowerShell's `$env:PROJ` drops out the same
// way. Quoting does not help either — `--workspace ""` was accepted and meant
// machine-wide, so the same slip WIDENED the scope instead of narrowing it.
//
// WHAT THIS FILE PINS, and why the sweep is derived rather than listed. The
// table of value-taking flags is read out of the parser's own source, the way
// argv-480 reads the token list out of it, so a fourth value-taking flag added
// later is covered by every case below without anybody remembering to add a row
// — and a flag that stops taking a value fails here rather than quietly
// dropping out of the sweep.
//
// Three groups:
//
//   1. THE PARSER, table-driven: every spelling of every value-taking flag,
//      against every shape of unusable value, and against the real values that
//      must keep working on all three operating systems — a POSIX path, a
//      Windows drive letter (which must never be read as a flag), a UNC share,
//      and a negative number, which is the one leading-dash token that IS a
//      value.
//   2. THE SUPERVISOR, which is what turns this from a startup mistake into a
//      restart that moves the deck: bin/agent-dag.js appends `--port <bound>` to
//      the user's argv so the respawn keeps the port it was bound to, and an
//      argv ending in a bare `--workspace` used to eat it.
//   3. THE BINARY, spawned: the row a user actually reads, and the malformed
//      `--port` that used to die inside `listen` with Node's wording after a
//      page of green ticks.
//
// PLAIN NODE for the first two groups — parseArgs is strings in, a plain object
// out. The two spawns in group 3 run with a sandboxed HOME and `--no-claude
// --no-codex --no-persist`, so no hook is installed, no log is written and the
// real ~/.claude is never read.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPortValue, looksLikeFlag, parseArgs } from "../../server/args.mjs";

const ARGS_MJS = fileURLToPath(new URL("../../server/args.mjs", import.meta.url));
const DECK_JS = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const AGENT_DAG_JS = fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url));

// ── the table, read out of the parser ───────────────────────────────────────

interface ValueFlag {
  /** Every spelling that reaches this branch: `["-p", "--port"]`. */
  spellings: string[];
  /** The key it sets on the parsed object. */
  key: string;
  /** What bin/deck.js prints it expected. */
  expects: string;
}

/**
 * The value-taking flags, from `src/server/args.mjs` itself.
 *
 * Every one of them is a line of the shape
 *
 *     else if (a === "-p" || a === "--port") set("port", "a port number");
 *
 * so the branch condition names the spellings and the call names the key and the
 * expectation. Deriving it is the whole point: a listed table goes stale the
 * first time somebody adds `--sessions <path>`, and a stale table here is a flag
 * that can eat the next one again with nothing failing.
 */
function valueFlags(): ValueFlag[] {
  const source = readFileSync(ARGS_MJS, "utf8");
  const rows: ValueFlag[] = [];
  for (const line of source.split("\n")) {
    const call = /\bset\("(\w+)", "([^"]+)"\)/.exec(line);
    if (!call) continue;
    const spellings = [...line.matchAll(/a === "([^"]+)"/g)].map(m => m[1]);
    if (spellings.length === 0) continue;
    rows.push({ spellings, key: call[1], expects: call[2] });
  }
  return rows;
}

const VALUE_FLAGS = valueFlags();

describe("the sweep below covers every flag that takes a value", () => {
  it("finds all three in the parser, each with a key and an expectation", () => {
    // Three today. The assertion is not the number — it is that the derivation
    // works at all, since a regex that matched nothing would make every
    // table-driven case below vacuously pass.
    expect(VALUE_FLAGS.length).toBeGreaterThanOrEqual(3);
    expect(VALUE_FLAGS.map(f => f.key).sort()).toEqual(["history", "port", "workspace"]);
    expect(VALUE_FLAGS.flatMap(f => f.spellings).sort())
      .toEqual(["--history", "--port", "--workspace", "-p"]);
    for (const f of VALUE_FLAGS) expect(f.expects, f.key).toMatch(/^a \w/);
  });
});

/** Every spelling of every value-taking flag, one row per spelling. */
const EVERY_SPELLING: [flag: string, key: string, expects: string][] =
  VALUE_FLAGS.flatMap(f => f.spellings.map(s => [s, f.key, f.expects] as [string, string, string]));

// ── 1. the parser ───────────────────────────────────────────────────────────

describe("a value-taking flag never swallows the flag after it", () => {
  for (const [flag, key] of EVERY_SPELLING) {
    it(`${flag} leaves --no-persist to be parsed as --no-persist`, () => {
      const got = parseArgs([flag, "--no-persist"]);
      // The eaten flag is applied, which is the whole of the reporter's bug:
      // the deck persisted to the shared events log after being told not to.
      expect(got.noPersist, "the swallowed flag was not applied").toBe(true);
      // And the eating flag is left unset, so the deck falls back to its
      // documented default instead of to a directory named `--no-persist`.
      expect(got[key], `${flag} kept a flag as its value`).toBeUndefined();
    });

    it(`${flag} leaves a token it does not know to reach unknown`, () => {
      // The other half. A typo after a value-taking flag was invisible twice
      // over: not parsed, and not reported either.
      const got = parseArgs([flag, "--prot"]);
      expect(got.unknown).toEqual(["--prot"]);
      expect(got[key]).toBeUndefined();
    });
  }
});

describe("a value-taking flag with no usable value is named, not guessed at", () => {
  for (const [flag, key, expects] of EVERY_SPELLING) {
    // The four shapes that are not a value: the next flag, nothing at all, an
    // empty string, and whitespace. All four used to be silent, and three of
    // the four produced a flag that was "set" to something unusable.
    const shapes: [name: string, argv: string[]][] = [
      ["the next token is a flag", [flag, "--no-open"]],
      ["there is no next token", [flag]],
      ["the value is empty", [flag, ""]],
      ["the value is blank", [flag, "   "]],
    ];
    for (const [name, argv] of shapes) {
      it(`${flag}: ${name}`, () => {
        const got = parseArgs(argv);
        expect(got[key], `${flag} took an unusable value`).toBeUndefined();
        expect(got.incomplete, `${flag} was not reported`)
          .toContainEqual({ flag, expects });
        // Never onto the unknown list: the flag is one the deck knows, and
        // calling it unknown would send the user to --help for a flag that is
        // already in --help.
        expect(got.unknown).not.toContain(flag);
      });
    }

    it(`${flag} says nothing when it does get a value`, () => {
      // The warning that fires on a correct command line is the warning
      // everybody learns to ignore — argv-480's whole argument, still true.
      const got = parseArgs([flag, "value"]);
      expect(got[key]).toBe("value");
      expect(got.incomplete).toEqual([]);
      expect(got.unknown).toEqual([]);
    });
  }

  it("reports each offending flag once, in the order they were typed", () => {
    expect(parseArgs(["--workspace", "--history", "--port"]).incomplete).toEqual([
      { flag: "--workspace", expects: "a path" },
      { flag: "--history", expects: "a path" },
      { flag: "--port", expects: "a port number" },
    ]);
  });

  it("still takes the second spelling when the first had nothing", () => {
    // Not a contrived case: it is what the supervisor produces, below.
    const got = parseArgs(["--workspace", "--workspace", "/srv/proj"]);
    expect(got.workspace).toBe("/srv/proj");
    expect(got.incomplete).toEqual([{ flag: "--workspace", expects: "a path" }]);
  });
});

describe("a real value is still a real value, on all three operating systems", () => {
  // Opaque strings — the parser does not interpret any of them, and neither
  // does this test, so it asserts the same thing on every platform. The Windows
  // shapes are the ones worth stating out loud: a drive letter begins with a
  // LETTER and can never be mistaken for a flag, and a UNC path begins with a
  // backslash, not a dash.
  const PATHS = [
    "/srv/proj", "./sub", "../sibling", "sub", "~/proj", "/",
    "C:\\Users\\John\\proj", "c:/users/john/proj", "C:\\", "\\\\server\\share\\proj",
    "\\\\?\\C:\\proj", "D:\\a\\b\\events.jsonl", "events.jsonl",
  ];

  for (const [flag, key] of EVERY_SPELLING) {
    it(`${flag} keeps every path shape`, () => {
      for (const path of PATHS) {
        const got = parseArgs([flag, path]);
        expect(got[key], `${flag} ${path}`).toBe(path);
        expect(got.incomplete, `${flag} ${path}`).toEqual([]);
        expect(got.unknown, `${flag} ${path}`).toEqual([]);
      }
    });
  }

  it("takes a negative number as a value, and lets the port check judge it", () => {
    // The one leading-dash token that is a value rather than a flag. `--port -1`
    // is a number the user meant; it deserves the port error, which names the
    // flag, rather than a "missing value" one that would not.
    expect(parseArgs(["--port", "-1"])).toEqual({ port: "-1", unknown: [], incomplete: [] });
    expect(isPortValue("-1")).toBe(false);
  });

  it("refuses a bare dash, which is a value nothing here can use", () => {
    expect(parseArgs(["--workspace", "-"]).workspace).toBeUndefined();
    expect(parseArgs(["--workspace", "-"]).incomplete)
      .toEqual([{ flag: "--workspace", expects: "a path" }]);
  });
});

describe("looksLikeFlag, which is the whole of the judgement", () => {
  it("calls a flag a flag", () => {
    for (const t of ["-h", "-p", "--port", "--no-persist", "--prot", "-", "--"]) {
      expect(looksLikeFlag(t), t).toBe(true);
    }
  });

  it("calls a path a path, including every Windows shape", () => {
    for (const t of [
      "/srv/proj", "./-weird", "sub", "~/p", "C:\\Users\\u", "c:/users/u",
      "\\\\srv\\share", "\\\\?\\C:\\p", "events.jsonl", "4500", "0",
    ]) {
      expect(looksLikeFlag(t), t).toBe(false);
    }
  });

  it("calls a negative number a value", () => {
    for (const t of ["-1", "-42", "-0", "-1.5"]) expect(looksLikeFlag(t), t).toBe(false);
  });
});

describe("isPortValue, which is what makes a bad --port name the flag", () => {
  it("takes the ports Node can bind", () => {
    for (const p of ["0", "80", "4317", "65535", 4317]) expect(isPortValue(p), String(p)).toBe(true);
  });

  it("refuses everything Number() would have turned into NaN or worse", () => {
    // `Number()` takes all of these and used to hand the first six straight to
    // `listen`, where they became `NaN` or an out-of-range number.
    for (const p of ["banana", "--no-open", "", "   ", "-1", "65536", "1e3", "0x10e4", "4500.5", "Infinity", null, undefined, {}]) {
      expect(isPortValue(p as never), String(p)).toBe(false);
    }
  });
});

// ── 2. the supervisor ───────────────────────────────────────────────────────

describe("a respawn keeps the port it was bound to", () => {
  it("still appends --port last, which is what makes it win", () => {
    // The mechanism this depends on. If the append moves or stops being last,
    // the assertion below is about a command line the supervisor no longer
    // builds.
    const sup = readFileSync(AGENT_DAG_JS, "utf8");
    expect(sup).toMatch(/args\.push\("--port", String\(boundPort\)\)/);
  });

  it("does not lose the port to an argv that ends in a bare --workspace", () => {
    // `ccdeck --workspace` (the user's argv, with the value lost to an unset
    // variable) + `--port 4317` (the supervisor's). `--workspace` used to eat
    // `--port`, the number landed in `unknown`, and the deck came back on the
    // default port — moving out from under the tab the user was looking at.
    const got = parseArgs(["--workspace", "--port", "4317"]);
    expect(got.port, "the respawn lost its bound port").toBe("4317");
    expect(got.unknown).toEqual([]);
    expect(got.incomplete).toEqual([{ flag: "--workspace", expects: "a path" }]);
  });

  it("keeps the LAST --port when the user named one too", () => {
    // The supervisor's comment: "Appended last so it wins."
    expect(parseArgs(["--port", "4000", "--port", "4317"]).port).toBe("4317");
  });
});

// ── 3. the binary ───────────────────────────────────────────────────────────

// A home the deck cannot recognise. Nothing below installs a hook or writes a
// log — `--no-claude --no-codex --no-persist` — but the sandbox is set anyway,
// because a test that assumes what a binary will not touch is one flag away
// from being wrong.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-697-"));
const ENV = {
  ...process.env,
  NO_COLOR: "1",
  CI: "1",
  HOME: DIR,
  USERPROFILE: DIR,
  CLAUDE_CONFIG_DIR: join(DIR, "claude"),
  CODEX_HOME: join(DIR, "codex"),
  XDG_CONFIG_HOME: join(DIR, "config"),
  // Otherwise a machine with this set would drag the deck onto a real port.
  AGENT_DAG_PORT: "",
};

const alive = new Set<ChildProcess>();
afterAll(() => {
  for (const c of alive) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  rmTempDir(DIR);
});

/** Run bin/deck.js to completion. For invocations that are meant to exit. */
function runDeck(args: string[], env: NodeJS.ProcessEnv = ENV, timeoutMs = 20_000) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [DECK_JS, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    alive.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bin/deck.js ${args.join(" ")} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); alive.delete(child); reject(e); });
    child.on("exit", code => { clearTimeout(timer); alive.delete(child); resolve({ code, out, err }); });
  });
}

/** Start bin/deck.js and read stdout until `want` shows up, then kill it. */
function deckUntil(args: string[], want: RegExp, timeoutMs = 25_000) {
  return new Promise<string>((resolve, reject) => {
    // Spawned directly rather than through bin/agent-dag.js: no supervisor
    // means no respawn, so one kill really is the end of it.
    const child = spawn(process.execPath, [DECK_JS, ...args], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
    alive.add(child);
    let out = "";
    const done = (fn: () => void) => { clearTimeout(timer); child.kill("SIGKILL"); alive.delete(child); fn(); };
    const timer = setTimeout(
      () => done(() => reject(new Error(`never printed ${want}; saw:\n${out}`))),
      timeoutMs,
    );
    child.stdout.on("data", d => { out += d; if (want.test(out)) done(() => resolve(out)); });
    child.on("error", e => done(() => reject(e)));
    child.on("exit", () => done(() => {
      if (want.test(out)) resolve(out);
      else reject(new Error(`exited without printing ${want}; saw:\n${out}`));
    }));
  });
}

describe("the deck says so on the terminal, where the user is looking", () => {
  it("prints a `missing value` row for --workspace and honours --no-persist", async () => {
    // The reporter's command line, with the port pinned to 0 so the run cannot
    // touch a deck that is already up on this machine.
    const out = await deckUntil(
      ["--no-claude", "--no-codex", "--no-persist", "--no-open", "--port", "0", "--workspace"],
      /missing value/,
    );
    expect(out).toMatch(/missing value\s+--workspace .* expected a path/);
    // The consequence, on the row above: machine-wide, not a directory called
    // after the next flag.
    expect(out).toMatch(/workspace\s+\(all\)/);
    expect(out).not.toMatch(/--no-persist/);
  }, 30_000);
});

describe("a malformed --port names the flag and the value", () => {
  it("refuses `--port banana` before it installs anything", async () => {
    // It refused before too, from inside `listen`, after installing hooks and
    // probing for tools: "ccdeck: server failed: options.port should be >= 0
    // and < 65536. Received type number (NaN)." — which names neither the flag
    // nor the value, and arrives under a page of green ticks.
    const { code, out, err } = await runDeck(["--no-claude", "--no-codex", "--no-persist", "--no-open", "--port", "banana"]);
    expect(code).toBe(1);
    expect(err).toContain("--port");
    expect(err).toContain("banana");
    expect(err).toMatch(/not a port number/);
    expect(err).not.toMatch(/NaN/);
    // Nothing was started: no banner, no rows, no server.
    expect(out).toBe("");
  }, 30_000);

  it("names AGENT_DAG_PORT when that is where the bad number came from", async () => {
    // The env var is the other way in, and blaming `--port` for it would send
    // the user looking at a command line that does not contain the mistake.
    const { code, err } = await runDeck(
      ["--no-claude", "--no-codex", "--no-persist", "--no-open"],
      { ...ENV, AGENT_DAG_PORT: "banana" },
    );
    expect(code).toBe(1);
    expect(err).toContain("AGENT_DAG_PORT");
    expect(err).toContain("banana");
    expect(err).not.toContain("--port");
  }, 30_000);

  it("reads an empty AGENT_DAG_PORT as unset rather than as a bad number", async () => {
    // A variable that did not expand is not a request for port zero, and it is
    // certainly not a reason to refuse to boot. Proved by the run above it: the
    // whole of this file spawns with `AGENT_DAG_PORT: ""`, and the `missing
    // value` case booted.
    const { code, err } = await runDeck(
      ["--no-claude", "--no-codex", "--no-persist", "--no-open", "--port", "banana"],
      { ...ENV, AGENT_DAG_PORT: "" },
    );
    expect(code).toBe(1);
    expect(err).toContain("--port");
  }, 30_000);
});

describe("--help says what the parser now does", () => {
  it("tells the reader a value-taking flag will not swallow the next flag", () => {
    const deck = readFileSync(DECK_JS, "utf8");
    expect(deck).toMatch(/never swallows the next flag/);
  });
});
