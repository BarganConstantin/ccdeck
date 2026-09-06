// Passing a string as argv is not the same as it being treated as data.
//
// `notify()` on darwin runs osascript with the script in `-e` and the title and
// body as positional operands, and the comment above it said that was what made
// an attacker-chosen host name safe — "neither string is interpolated into the
// source". Interpolation was never the only way in. osascript's option parser
// reads any LEADING-DASH operand as an option, so a title beginning with `-e`
// was not an argument at all: it was a second script chunk, handed to the
// compiler.
//
// THE REACH IS WHAT MAKES IT SERIOUS. The title is `basename(cwd) — ccdeck`
// (block-notify.mjs), `cwd` arrives in the body of `POST /api/event`, and that
// route is in `OPEN_MUTATIONS` — no deck token, no browser identity, no tab.
// That is exactly the caller the gate comments in index.mjs describe: "a
// sandboxed subprocess denied the credential store but allowed loopback
// egress". The desktop notifier fires when no page is connected, which is the
// state such a caller can simply wait for.
//
// VERIFIED WITHOUT A PAYLOAD, on Darwin 25.5. Handing osascript a leading `-e`
// operand answers `syntax error: The run handler is specified more than once`
// — the compiler reporting on the operand, which is the whole proof: data does
// not produce syntax errors. With `--` in front, the same string comes back as
// `item 1 of argv`. Neither probe runs anything.
//
// The fix is one argument, and the cases below are about keeping it. They read
// the argv the module builds rather than running osascript, because the defect
// is in what is handed over and a machine without osascript must still be able
// to fail this file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs server module, no types
const { notify, closeTab, quitBrowser } = await import("../../server/browser-react.mjs");

/** Records the argv a reaction builds, and answers success so the caller's own
 *  error handling is not what is being measured. */
function spy() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    run: (cmd: string, args: string[]) => { calls.push({ cmd, args }); return Promise.resolve({ ok: true, stdout: "", stderr: "" }); },
  };
}

/** Where the user's strings begin in an argv: everything after the separator. */
function operands(args: string[]): string[] {
  const at = args.indexOf("--");
  expect(at, `no "--" separator in: ${JSON.stringify(args)}`).toBeGreaterThanOrEqual(0);
  return args.slice(at + 1);
}

describe("the desktop notification's argv", () => {
  it("puts the separator before the title and the body", async () => {
    const s = spy();
    await notify("paycore — ccdeck", "needs your input", "darwin", { run: s.run });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].cmd).toBe("osascript");
    expect(operands(s.calls[0].args)).toEqual(["paycore — ccdeck", "needs your input"]);
  });

  it("keeps a title that begins with a dash on the data side of it", async () => {
    // The shape of the defect, with an inert string rather than a payload: what
    // matters is which side of `--` it lands on, and that osascript can only
    // read it as an operand from there.
    const s = spy();
    await notify("-e something", "-e also", "darwin", { run: s.run });
    const args = s.calls[0].args;
    expect(operands(args)).toEqual(["-e something", "-e also"]);
    // And nothing dash-leading sits in front of the separator except the script
    // flag itself — a second `-e` before `--` would be the bug back.
    const before = args.slice(0, args.indexOf("--"));
    expect(before.filter(a => a === "-e")).toHaveLength(1);
  });

  it("does the same on the Linux path", async () => {
    // notify-send parses a leading dash as an option too. The consequence is
    // smaller — a suppressed or misdirected notification, not a compiler — but
    // a rule with an exception is one somebody applies to the wrong call next.
    const s = spy();
    await notify("-x title", "body", "linux", { run: s.run });
    expect(s.calls[0].cmd).toBe("notify-send");
    expect(operands(s.calls[0].args)).toEqual(["-x title", "body"]);
  });

  it("leaves the Windows path alone, which never had the problem", async () => {
    // PowerShell gets both strings through `$env:`, so they are read at runtime
    // as data and never reach a parser. Asserted so that a later "consistency"
    // edit does not move them onto a command line to match the others.
    const s = spy();
    await notify("-e title", "body", "win32", { run: s.run });
    expect(s.calls[0].cmd).toBe("powershell.exe");
    expect(s.calls[0].args.join(" ")).not.toContain("-e title");
  });
});

describe("the other two osascript reactions", () => {
  it("separates the url the close-tab script is given", async () => {
    const s = spy();
    await closeTab("chrome", "https://example.com/a", "darwin", { run: s.run });
    expect(operands(s.calls[0].args)).toEqual(["https://example.com/a"]);
  });

  it("separates the application name the quit script is given", async () => {
    const s = spy();
    await quitBrowser("chrome", "darwin", { run: s.run });
    expect(operands(s.calls[0].args)).toEqual(["Google Chrome"]);
  });
});

describe("the rule, stated where the next caller will read it", () => {
  it("has no osascript or notify-send call left without a separator", () => {
    // The general form, because the four call sites are not the interesting
    // number — the fifth one somebody adds is. Any argv handed to either
    // program must carry `--` before whatever came from outside this process.
    const src = readFileSync(fileURLToPath(new URL("../../server/browser-react.mjs", import.meta.url)), "utf8");
    for (const m of src.matchAll(/exec\((?:"|')(osascript|notify-send)(?:"|'),\s*\[([\s\S]*?)\]\)/g)) {
      expect(m[2], `${m[1]} called with no "--" separator: ${m[2].replace(/\s+/g, " ").slice(0, 90)}`)
        .toContain('"--"');
    }
  });
});
