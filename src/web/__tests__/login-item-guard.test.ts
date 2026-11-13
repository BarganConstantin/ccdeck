// The login item once `npm uninstall -g ccdeck` has taken its script away.
//
// It used to run `node <package>/bin/agent-dag.js` bare: a "Cannot find module"
// stack in deck.log and a failed unit at every login on Linux and macOS, and a
// console window with the same stack on Windows. It now goes through a guard
// that ends 0 and says nothing when the script is gone, and runs the same
// command as before when it is there.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs module, no types
const svc = await import("../../server/login-service.mjs");
const { unitFor, plistFor, taskXmlFor, guardedItemText, refreshLoginItem, LOGIN_GUARD } = svc as {
  unitFor: (o: Record<string, unknown>) => string;
  plistFor: (o: Record<string, unknown>) => string;
  taskXmlFor: (o: Record<string, unknown>) => string;
  guardedItemText: (t: string, p: string) => string | null;
  refreshLoginItem: (o: Record<string, unknown>) => Promise<boolean>;
  LOGIN_GUARD: string;
};

// A POSIX shell is what runs these on Linux and macOS; Windows has its own test below.
const posix = (name: string, body: () => void) => it(name, () => { if (process.platform !== "win32") body(); });

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
      if (c === '"') { quote = c; continue; }
      if (c === " ") break;
      word += c;
    }
    words.push(word.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  }
  return words;
}
const unitWords = (unit: string) => execWords(/^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "");
const plistWords = (plist: string) => {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
};

const dir = mkdtempSync(join(tmpdir(), "ccdeck-login-guard-"));
// An install path with a space and a `$`, which has to stay one argument.
const root = join(dir, "My $Deck");
mkdirSync(join(root, "bin"), { recursive: true });
const PRESENT = join(root, "bin", "agent-dag.js");
writeFileSync(PRESENT, "console.log('deck ran: ' + process.argv.slice(2).join(' '));\n");
const ABSENT = join(dir, "removed", "bin", "agent-dag.js");

const job = (script: string) => ({
  execPath: process.execPath, script, logPath: join(dir, "deck.log"), args: ["--no-open", "--at-login"],
});
const run = (words: string[]) => spawnSync(words[0], words.slice(1), { encoding: "utf8" });

describe("the login item with its script missing", () => {
  posix("systemd: ExecStart runs the deck when the script is there", () => {
    const words = unitWords(unitFor(job(PRESENT)));
    expect(words.slice(0, 4)).toEqual(["/bin/sh", "-c", LOGIN_GUARD, "ccdeck-login"]);
    const r = run(words);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("deck ran: --no-open --at-login\n");
  });

  posix("systemd: ExecStart ends 0 with no output when the script is gone", () => {
    const r = run(unitWords(unitFor(job(ABSENT))));
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  posix("launchd: ProgramArguments run the deck when the script is there", () => {
    const words = plistWords(plistFor(job(PRESENT)));
    expect(words.slice(0, 4)).toEqual(["/bin/sh", "-c", LOGIN_GUARD, "ccdeck-login"]);
    const r = run(words);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("deck ran: --no-open --at-login\n");
  });

  posix("launchd: ProgramArguments end 0 with no output when the script is gone", () => {
    const r = run(plistWords(plistFor(job(ABSENT))));
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("Windows: the task goes through cmd.exe and runs nothing when the script is missing", () => {
    const xml = taskXmlFor({
      execPath: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\a b\\npm\\ccdeck\\bin\\agent-dag.js",
      args: ["--no-open", "--at-login"],
    });
    expect(xml).toContain("<Command>cmd.exe</Command>");
    // XML text, so every quote is &quot;; cmd.exe sees the decoded line.
    const q = "&quot;";
    expect(xml).toContain(`<Arguments>/d /s /c ${q}if exist ${q}C:\\Users\\a b\\npm\\ccdeck\\bin\\agent-dag.js${q} `
      + `(${q}C:\\Program Files\\nodejs\\node.exe${q} ${q}C:\\Users\\a b\\npm\\ccdeck\\bin\\agent-dag.js${q} --no-open --at-login)${q}</Arguments>`);
    // no else branch: a missing script runs nothing and the task ends 0.
    expect(xml).not.toContain("else");
  });
});

describe("an item an older deck wrote", () => {
  // What every deck before the guard wrote: the guard's four words are not there.
  const oldUnit = (script: string) => unitFor(job(script)).replace(/^ExecStart=.*? ccdeck-login /m, "ExecStart=");
  const oldPlist = (script: string) => plistFor(job(script))
    .replace(/(<array>\n)(?: {6}<string>[^\n]*<\/string>\n){4}/, "$1");

  it("is rewritten to exactly what this version writes, and only once", () => {
    for (const script of [PRESENT, ABSENT]) {
      expect(oldUnit(script)).not.toBe(unitFor(job(script)));
      expect(guardedItemText(oldUnit(script), "linux")).toBe(unitFor(job(script)));
      expect(guardedItemText(oldPlist(script), "darwin")).toBe(plistFor(job(script)));
    }
    expect(guardedItemText(unitFor(job(PRESENT)), "linux")).toBeNull();
    expect(guardedItemText(plistFor(job(PRESENT)), "darwin")).toBeNull();
    expect(guardedItemText("anything", "win32")).toBeNull();
  });

  it("is rewritten on disk, in place, and left alone when it is not ours", async () => {
    const home = join(dir, "home");
    const file = join(home, ".config", "systemd", "user", "ccdeck.service");
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(file, oldUnit(PRESENT));
    expect(await refreshLoginItem({ platform: "linux", home, env: {} })).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(unitFor(job(PRESENT)));
    expect(await refreshLoginItem({ platform: "linux", home, env: {} })).toBe(false);

    const foreign = "[Service]\nExecStart=/usr/bin/other --thing\n";
    writeFileSync(file, foreign);
    expect(await refreshLoginItem({ platform: "linux", home, env: {} })).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(foreign);
    // Windows keeps its task in the scheduler, not in a file.
    expect(await refreshLoginItem({ platform: "win32", home, env: {} })).toBe(false);
  });
});
