// cmd.exe's "no such command" verdict, recognised on a Windows that is not in
// English (#552).
//
// A `.cmd` or `.bat` candidate is launched THROUGH cmd.exe, and cmd.exe always
// exists — so a missing tool is not a spawn error at all. It is a healthy shell
// exiting non-zero after printing a sentence. `looksMissing` is the only thing
// that turns that into `code: "ENOENT"`, and until #552 it knew three English
// strings and nothing else:
//
//     'cswap' is not recognized as an internal or external command,
//     operable program or batch file.
//     the system cannot find the path specified.
//
// Windows ships cmd.exe in every language it ships in. On a German install with
// cswap genuinely absent it prints
//
//     Der Befehl "cswap" ist entweder falsch geschrieben oder konnte nicht
//     gefunden werden.
//
// so `looksMissing` answered false, `run` resolved `{ ok: false, code: 1 }`, and
// three things went wrong at once: claude-accounts.mjs picked
// `reason: "switch_failed"` over `"no_cswap"` so the panel's install affordance
// never appeared; cswap-admin.mjs's `failureText` fell through to `firstUseful`,
// which takes the LAST line and therefore put half a translated sentence on
// screen by itself — #457's exact symptom, reproduced for every non-English
// locale; and the candidate loop stopped early, so a tool installed as `.bat`
// after a missing `.cmd` was never reached.
//
// ── why this file is shaped the way it is ───────────────────────────────────
//
// Adding the German sentence, and then the French and the Japanese ones, is not
// a fix — it is the same defect with a longer list, and the list can never be
// finished. So the cases below are about the two signals that are NOT human
// sentences:
//
//   the exit status  9009 is cmd.exe's own errorlevel for a command token it
//                    could not resolve, and it is the same number in Frankfurt
//                    as in Seattle;
//   the shape        cmd.exe QUOTES the command it could not find, in every
//                    locale, and prints that instead of running anything — so
//                    the output is one short sentence naming our own spelling.
//
// and about the direction that must not move: a message about somebody ELSE's
// command. That is the trap #457 documented — believing it discards a real
// error, calls a tool absent that is not, and sends the candidate loop back
// round to RE-RUN the command, which for `cswap remove 3` means asking to delete
// an account a second time. It now has a second door, because a `.cmd` shim that
// exists in front of an interpreter that does not forwards both the sentence
// about python AND the 9009 that came with it.
//
// Nothing here spawns anything and nothing here reads process.platform. The
// launch spelling is produced by the real `candidateSpec` with its Windows
// lookup injected, exactly as exec-shim-callers.test.ts does it, so every case
// runs on all three CI legs rather than the one that could execute cmd.exe.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { candidateSpec, looksMissing, notFoundExit } from "../../server/exec.mjs";
// @ts-expect-error — .mjs server module, no types
import { failureText } from "../../server/cswap-admin.mjs";

/**
 * What cmd.exe prints when it cannot find `name`, in the languages Windows
 * ships. The quote character is the only part that is not a translation —
 * English and French use `'…'`, the rest use `"…"` — and the whole message is
 * one sentence, wrapped at most once.
 */
const LOCALES: Array<[string, (name: string) => string]> = [
  ["English", n => `'${n}' is not recognized as an internal or external command,\noperable program or batch file.`],
  ["German", n => `Der Befehl "${n}" ist entweder falsch geschrieben oder konnte nicht gefunden werden.`],
  ["French", n => `'${n}' n'est pas reconnu en tant que commande interne\nou externe, un programme exécutable ou un fichier de commandes.`],
  ["Spanish", n => `"${n}" no se reconoce como un comando interno o externo,\nprograma o archivo por lotes ejecutable.`],
  ["Italian", n => `"${n}" non è riconosciuto come comando interno o esterno,\n un programma eseguibile o un file batch.`],
  ["Portuguese", n => `"${n}" não é reconhecido como um comando interno\nou externo, um programa operável ou um arquivo em lotes.`],
  ["Polish", n => `"${n}" nie jest rozpoznawany jako polecenie wewnętrzne lub zewnętrzne,\nprogram wykonywalny lub plik wsadowy.`],
  ["Russian", n => `"${n}" не является внутренней или внешней\nкомандой, исполняемой программой или пакетным файлом.`],
  ["Japanese", n => `'${n}' は、内部コマンドまたは外部コマンド、\n操作可能なプログラムまたはバッチ ファイルとして認識されていません。`],
  ["Chinese", n => `'${n}' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。`],
];

const SHIM = "C:\\Users\\dorin\\AppData\\Roaming\\Python\\Python312\\Scripts\\cswap.cmd";

/**
 * The spelling cmd.exe is ACTUALLY GIVEN for a bare `cswap.cmd`, out of the real
 * candidateSpec with a Windows PATH described rather than possessed.
 *
 * Not a string typed here: since #457 the launch spelling is the shim's absolute
 * path whenever shimPath can find one, and looksMissing is compared against
 * THAT. A fixture that hard-coded `cswap.cmd` would go on passing after the
 * coupling broke.
 */
const launchOf = (raw: string, present: string | null) =>
  candidateSpec(raw, ["--version"], "win32", {
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    pathEnv: "C:\\Users\\dorin\\AppData\\Roaming\\Python\\Python312\\Scripts;C:\\Windows\\System32",
    exists: (p: string) => p === present,
  }).launch;

describe("the launch spelling every rule below is compared against", () => {
  it("is the absolute shim path when PATH has one", () => {
    expect(launchOf("cswap.cmd", SHIM)).toBe(SHIM);
  });

  it("falls back to the bare candidate when nothing answers to the name", () => {
    // `?? raw` in candidateSpec. cmd.exe echoes back whatever token it was
    // handed, so the comparison has to follow it either way.
    expect(launchOf("cswap.cmd", null)).toBe("cswap.cmd");
  });
});

describe("cmd.exe's verdict, in every language Windows ships it in", () => {
  for (const [language, message] of LOCALES) {
    it(`is recognised in ${language}`, () => {
      // The exit status is 1 here, not 9009: the shape alone has to carry this,
      // because some Windows builds answer a bare `cmd /c missing` with a plain
      // 1 and a fix that needed the status would be a fix for half of them.
      const launch = launchOf("cswap.cmd", SHIM);
      expect(looksMissing(message(launch), launch, 1)).toBe(true);
    });

    it(`is refused in ${language} when it names some other command`, () => {
      // A `.cmd` shim that exists in front of an interpreter that does not:
      // cmd.exe's sentence is about python, and the shim hands it straight up.
      // Believed, this discards the real error and re-runs the command.
      const launch = launchOf("cswap.cmd", SHIM);
      expect(looksMissing(message("python"), launch, 1)).toBe(false);
    });
  }

  it("is recognised for the bare candidate too, before any shim was found", () => {
    // The first spelling the loop tries on a machine where nothing is installed
    // at all — no absolute path exists to be echoed back.
    const launch = launchOf("cswap.cmd", null);
    for (const [, message] of LOCALES) {
      expect(looksMissing(message("cswap.cmd"), launch, 1), message("cswap.cmd")).toBe(true);
    }
  });
});

describe("the exit status, which is the same number in every language", () => {
  it("recognises 9009 and nothing that merely looks like it", () => {
    expect(notFoundExit(9009)).toBe(true);
    expect(notFoundExit("9009")).toBe(true);   // a string exit code from a close event
    expect(notFoundExit(1)).toBe(false);
    expect(notFoundExit(0)).toBe(false);
    expect(notFoundExit("ENOENT")).toBe(false);
    expect(notFoundExit(null)).toBe(false);
    expect(notFoundExit(undefined)).toBe(false);
  });

  it("carries the answer on its own when the text says nothing this can read", () => {
    // The point of having a signal that is not a sentence: a locale nobody
    // wrote a fixture for, a message the formatter mangled, a cmd.exe that
    // printed to a stream the caller did not capture.
    const launch = launchOf("cswap.cmd", SHIM);
    expect(looksMissing("", launch, 9009)).toBe(true);
    expect(looksMissing("Bir sey bulunamadi.", launch, 9009)).toBe(true);
  });

  it("is vetoed by a message about somebody else's command", () => {
    // The second door into #457's trap, and the reason the status is not read
    // first. A shim forwards its child's errorlevel along with its child's
    // sentence, so 9009 arrives beside a message about python.
    const launch = launchOf("cswap.cmd", SHIM);
    for (const [language, message] of LOCALES) {
      expect(looksMissing(message("python"), launch, 9009), language).toBe(false);
    }
  });
});

describe("the failures that must keep their own message", () => {
  const launch = launchOf("cswap.cmd", SHIM);

  it("leaves a tool's own error alone, however short it is", () => {
    expect(looksMissing("Error: No active Claude account found.", launch, 1)).toBe(false);
    expect(looksMissing('Error: "account-9" does not exist', launch, 1)).toBe(false);
  });

  it("leaves a traceback alone even when it quotes the shim we launched", () => {
    // cmd.exe prints its verdict INSTEAD of running anything, so more than one
    // sentence means something ran and this is its report. cswap is a Python
    // CLI and a traceback names every file it passed through.
    const traceback = [
      "Traceback (most recent call last):",
      `  File "${SHIM}", line 1, in <module>`,
      "    os.replace(src, dst)",
      "FileNotFoundError: [WinError 2] The system cannot find the file specified",
    ].join("\n");
    expect(looksMissing(traceback, launch, 1)).toBe(false);
    // And with the status that would otherwise be believed, since a shim can
    // forward one.
    expect(looksMissing(traceback, launch, 9009)).toBe(false);
  });

  it("refuses a localized sentence when there is no candidate to check it against", () => {
    // The deliberate limit. Without `name` the shape rule has nothing to hold
    // on to: one line with a quoted token in it is also what half the CLIs in
    // the world print when they fail, and reading one as an absence is the
    // direction that re-runs `cswap remove 3`. `run` always has the name, which
    // is why the user-visible path is fixed regardless.
    for (const [language, message] of LOCALES.filter(([l]) => l !== "English")) {
      expect(looksMissing(message("cswap.cmd")), language).toBe(false);
    }
  });
});

describe("what the accounts panel ends up telling a non-English user", () => {
  const german = LOCALES.find(([l]) => l === "German")![1];

  it("says the actionable sentence when cmd.exe reported its own errorlevel", () => {
    // failureText is the one caller with no candidate spelling to compare
    // against, so the STATUS is all it has on a translated Windows. Without it
    // the panel showed `gefunden werden.` — the tail of a sentence, alone.
    const out = failureText({ ok: false, code: 9009, stderr: german("cswap.cmd"), stdout: "" }, "cswap export");
    expect(out).toMatch(/not on PATH/);
    expect(out).toMatch(/AGENTS_DECK_CSWAP/);
    expect(out).not.toMatch(/gefunden werden/);
  });

  it("says it for the claude CLI too, which has its own environment variable", () => {
    const out = failureText({ ok: false, code: 9009, stderr: german("claude.cmd"), stdout: "" }, "claude auth login");
    expect(out).toMatch(/claude CLI/);
    expect(out).toMatch(/AGENTS_DECK_CLAUDE/);
  });

  it("gets there through run()'s ENOENT on the ordinary path, whatever the status was", () => {
    // The real chain, and the reason the status is a backstop rather than the
    // fix: `run` knows the launch spelling, so the SHAPE rule fires there and
    // the result reaching failureText already carries `code: "ENOENT"`. That is
    // also what claude-accounts.mjs keys `reason: "no_cswap"` off.
    const launch = launchOf("cswap.cmd", SHIM);
    expect(looksMissing(german(launch), launch, 1)).toBe(true);
    const out = failureText({ ok: false, code: "ENOENT", stderr: german(launch), stdout: "" }, "cswap export");
    expect(out).toMatch(/not on PATH/);
  });

  it("still quotes a tool that ran and failed, in any language", () => {
    // The other half of failureText's job, unchanged: a real failure keeps its
    // own words even when the exit status is non-zero and the words are not
    // English.
    const out = failureText({ ok: false, code: 1, stderr: "Fehler: Konto 9 existiert nicht\n" }, "cswap remove");
    expect(out).toBe("Fehler: Konto 9 existiert nicht");
  });
});
