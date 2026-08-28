// What a child process really receives from a Windows command line.
//
// NOT A TEST FILE. It carries no describe/it and vitest's include pattern only
// collects `*.test.ts`, so it is loaded by the file that imports it and by
// nothing else — the same arrangement spawned-argv.ts uses, and it is
// deliberately not a `.test.ts` for a second reason: skip-gates.mjs scans this
// directory for gate sites by filename, and a helper is not a gate site.
//
// ── why ──────────────────────────────────────────────────────────────────────
//
// `shellQuoteArg(arg, "win32")` in src/server/exec.mjs produces the two strings
// this deck WRITES INTO the user's settings.json as `{type:"command"}` hooks,
// which the host CLI then runs through a shell on every tool call. Until #624
// the whole Windows half of that escaper was asserted against four literals
// somebody typed — which is a check that the escaper agrees with itself, and no
// check at all that it agrees with Windows.
//
// It matters because the Windows answer is not one rule, it is two, and they
// belong to different programs:
//
//   cmd.exe reads the line to find where the command ends. It has NO escape for
//   a quote; a `"` simply toggles "inside quotes", and `&`, `|`, `<`, `>`, `^`,
//   `(` and `)` are syntax only while outside. It expands `%VAR%` — inside
//   quotes too — and, when delayed expansion is on, `!VAR!` as well. Then it
//   hands the rest of the line to the target program AS TEXT.
//
//   The target program splits that text into `argv` itself. For node, that is
//   the UCRT parser, and the UCRT parser DOES treat `\` as an escape in front
//   of a quote: 2n backslashes before a `"` mean n backslashes and a quote that
//   toggles, 2n+1 mean n backslashes and a LITERAL quote.
//
// So `""` for an embedded quote is an MSVCRT convention that cmd.exe knows
// nothing about, and a rule that is right for one of the two parsers can be
// wrong for the other. Only running the line settles it. This module is how:
// on Windows `throughCmd` executes it through the real cmd.exe and reports what
// the child actually received, and on Linux and macOS it answers from the model
// below instead, so the same assertion is made on every leg rather than only on
// the one that can execute it — see the note on `authority`.
//
// The model is written from the two documented rules above, not from the
// escaper, which is the only way it can disagree with the escaper. And it is
// not asked to be trusted: on the Windows leg every case compares the model's
// answer against the real one, so the model that the other two legs rely on is
// itself checked by execution once per CI run.
import { execFileSync } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything cmd.exe reads as syntax while it is outside a quoted region. */
export const CMD_METACHARACTERS = "&|<>^()";

/**
 * cmd.exe's variable expansion, which is the one thing a command line has no
 * escape for.
 *
 * `%NAME%` is replaced wherever it appears — inside quotes as much as outside,
 * which is the whole of the residual exec.mjs documents — and left alone when
 * no variable of that name is set, which is what makes `%foo%` in a path
 * harmless in practice. Names are matched case-insensitively because that is
 * how the Windows environment block works.
 *
 * `!NAME!` is the same thing under delayed expansion, which is off for `cmd /c`
 * unless the machine turns it on in the registry or the caller passes `/v:on`.
 * It is modelled here so that the limit can be stated as an executable claim
 * rather than as a sentence in a comment.
 */
export function expandCmdVariables(
  line: string,
  env: Record<string, string | undefined>,
  { delayedExpansion = false } = {},
): string {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (v !== undefined) lookup.set(k.toLowerCase(), v);
  const substitute = (whole: string, name: string) => lookup.get(name.toLowerCase()) ?? whole;
  const expanded = line.replace(/%([^%]*)%/g, substitute);
  return delayedExpansion ? expanded.replace(/!([^!]*)!/g, substitute) : expanded;
}

/**
 * The metacharacters cmd.exe would read as syntax in `line`, in order.
 *
 * Empty is the answer a correctly quoted line has to give: everything the
 * escaper wraps must land inside a quoted region, or the command ends early and
 * the tail of it runs as a second command. Counting quotes is the whole of the
 * rule — cmd.exe has no escape for one, so every `"` toggles, including the
 * `""` an escaper emits for a literal quote (two toggles, no net change, which
 * is exactly why `""` is safe HERE even though it means something else to the
 * child).
 */
export function cmdUnquotedMetacharacters(line: string): string[] {
  const loose: string[] = [];
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && CMD_METACHARACTERS.includes(ch)) loose.push(ch);
  }
  return loose;
}

/**
 * The UCRT command-line parser — how node itself turns the text cmd.exe handed
 * it into `process.argv`.
 *
 * The three rules, from the CRT's own `parse_cmdline`:
 *
 *   2n backslashes followed by `"` → n backslashes, and the quote toggles.
 *   2n+1 backslashes followed by `"` → n backslashes and a LITERAL quote.
 *   Backslashes not followed by `"` are literal, however many there are.
 *
 * plus the one that makes `""` work: while inside quotes, a `"` immediately
 * followed by another `"` is a literal quote rather than the end of the quoted
 * region.
 *
 * Whitespace outside quotes separates arguments; an empty quoted region is
 * still an argument.
 */
export function parseWindowsArgv(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (started) { argv.push(current); current = ""; started = false; }
      i++;
      continue;
    }
    started = true;
    let slashes = 0;
    while (line[i] === "\\") { slashes++; i++; }
    if (line[i] === '"') {
      if (slashes % 2 === 0) {
        if (inQuotes && line[i + 1] === '"') {
          current += "\\".repeat(slashes / 2) + '"';
          i += 2;
          continue;
        }
        current += "\\".repeat(slashes / 2);
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      current += "\\".repeat((slashes - 1) / 2) + '"';
      i++;
      continue;
    }
    current += "\\".repeat(slashes);
    if (i < line.length) { current += line[i]; i++; }
  }
  if (started) argv.push(current);
  return argv;
}

// ── the harness the real cmd.exe runs ───────────────────────────────────────

/**
 * A node script that writes its own arguments back, NUL-separated.
 *
 * A file rather than `node -e`, and the reason is worth writing down: after
 * `-e <script>` node goes on reading node options, so a payload argument
 * spelled `--provider` — which is one of the three arguments in the very
 * command line this exists to check — is answered with `node: bad option`
 * instead of being carried. A script path ends node's own option parsing, so
 * everything after it is the child's to keep.
 *
 * Written as a Buffer because the corpus is not ASCII and the point of the
 * exercise is bytes.
 */
const PRINT_ARGV = [
  "const argv = process.argv.slice(2).join(String.fromCharCode(0));",
  'process.stdout.write(Buffer.from(argv, "utf8"));',
].join("\n");

let harness: { node: string; script: string } | null = null;

/** The `<node> <script>` prefix, created once per run. */
function printArgvHarness(): { node: string; script: string } {
  if (harness) return harness;
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-624-"));
  const script = join(dir, "print-argv.mjs");
  writeFileSync(script, PRINT_ARGV, "utf8");
  // The harness is not the thing under test, so it must not need the thing
  // under test to be spelled correctly. Wrapping a path in bare quotes is
  // sound for exactly the paths that contain neither a quote nor a trailing
  // backslash — which is the naive rule this whole exercise found wanting, so
  // the two properties that make it sound here are asserted rather than
  // assumed. `mkdtemp` under the system temp directory gives both.
  for (const part of [process.execPath, script]) {
    if (part.includes('"') || /\\$/.test(part)) {
      throw new Error(`the round-trip harness cannot quote its own path naively: ${part}`);
    }
  }
  // A test that leaves a directory behind on every run is a test that fills a
  // CI runner's temp space over a few hundred builds. `process.on("exit")`
  // rather than an afterAll hook because this module has no describe block to
  // hang one off, and it must not force its importers to remember.
  process.on("exit", () => {
    try { rmTempDir(dir); } catch { /* already gone */ }
  });
  harness = { node: process.execPath, script };
  return harness;
}

/** Where the answer came from. `"cmd.exe"` means a real process really ran. */
export type Authority = "cmd.exe" | "model";

export type RoundTrip = {
  /** The command line as cmd.exe would have it after variable expansion. */
  line: string;
  /** What the child received, from the strongest authority this OS has. */
  argv: string[];
  /** What the model says the child receives — always computed, on every leg. */
  modelArgv: string[];
  /** Metacharacters cmd.exe would read as syntax. Empty, or the quoting leaks. */
  unquoted: string[];
  authority: Authority;
};

/**
 * Run `tail` as the arguments of a real (or modelled) Windows command line and
 * report what the child received.
 *
 * `tail` is the already-quoted argument text — the part of a produced command
 * line that follows the program — and the program is replaced by a node script
 * that prints its own `argv` back. That substitution is the same one the POSIX
 * half of no-shell-hook-commands.test.ts makes with `printf`: the produced line
 * names a node that does not exist on this machine, and what is being checked
 * is the arguments rather than the program.
 *
 * On Windows this is `cmd.exe /d /s /c "<line>"` with verbatim arguments —
 * character for character the shape viaCmd builds and the shape
 * `child_process.exec` uses, so the answer is the one a persisted hook would
 * get. Everywhere else it is the model above, and `authority` says which, so a
 * caller can assert that the real one really ran where it was supposed to.
 */
export function throughCmd(tail: string, {
  env = {} as Record<string, string | undefined>,
  delayedExpansion = false,
} = {}): RoundTrip {
  const { node, script } = printArgvHarness();
  const line = `"${node}" "${script}" ${tail}`;
  const childEnv = { ...process.env, ...env };

  const expanded = expandCmdVariables(line, childEnv, { delayedExpansion });
  const unquoted = cmdUnquotedMetacharacters(expanded);
  // The harness contributes the first two tokens — the node and the script —
  // which node itself consumes, so the model drops them to line up with the
  // child's own `process.argv.slice(2)`.
  const modelArgv = parseWindowsArgv(expanded).slice(2);

  if (process.platform !== "win32") {
    return { line: expanded, argv: modelArgv, modelArgv, unquoted, authority: "model" };
  }

  const comspec = process.env.comspec || process.env.ComSpec || "cmd.exe";
  const flags = delayedExpansion ? ["/d", "/v:on", "/s", "/c"] : ["/d", "/s", "/c"];
  const out = execFileSync(comspec, [...flags, `"${line}"`], {
    // Verbatim, or Node quotes the already-quoted command line a second time —
    // the same reason viaCmd sets it.
    windowsVerbatimArguments: true,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: "buffer",
    maxBuffer: 1 << 20,
  });
  const text = out.toString("utf8");
  const argv = text === "" ? [] : text.split("\0");
  return { line: expanded, argv, modelArgv, unquoted, authority: "cmd.exe" };
}
