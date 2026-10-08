// tmux-control.mjs without tmux: the pure codecs, and the connection driven by
// a fake `tmux -C` that speaks the protocol from a script.
//
// The terminal panel's fidelity rests on details no screen comparison would
// point at directly: that `%output` is decoded as bytes and reassembled across
// chunk boundaries, that a reply is matched to its command by order and ended
// only by its own guard, that output before a seed's capture is dropped and
// output after it is not — even when both sit in one chunk — and that a
// `%pause` closes the stream until a new capture. Each is pinned here against a
// peer whose every byte the test chose, on every operating system, with no
// tmux installed. tmux-control-tmux.test.ts proves the same module against the
// real thing.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
// @ts-expect-error — plain .mjs server module, no types
import * as tc from "../../server/tmux-control.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { liveChildPids } from "../../server/exec-children.mjs";

const bytes = (s: string) => Buffer.from(s, "latin1");
const tick = () => new Promise(r => setImmediate(r));
async function until(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("unescapeOutput", () => {
  it("turns tmux's octal escapes back into the control bytes the pane wrote", () => {
    const out = tc.unescapeOutput(bytes("\\033[1mhi\\015\\012\\007"));
    expect([...out], "ESC, CR, LF and BEL arrive as \\ooo and must leave as one byte each")
      .toEqual([0x1b, 0x5b, 0x31, 0x6d, 0x68, 0x69, 0x0d, 0x0a, 0x07]);
  });

  it("decodes an escaped backslash, and only that one", () => {
    expect(tc.unescapeOutput(bytes("a\\134b\\134\\134")).toString("latin1"), "\\134 is the backslash itself")
      .toBe("a\\b\\\\");
  });

  it("passes UTF-8 and any other byte through untouched, as bytes", () => {
    const raw = Buffer.concat([Buffer.from("世界 🚀 é → ", "utf8"), Buffer.from([0xff, 0xfe])]);
    const out = tc.unescapeOutput(raw);
    expect(out.equals(raw), "nothing above 0x1f except the backslash is escaped, so nothing else may change").toBe(true);
    expect(out, "a line with no escape is returned as it is, without a copy").toBe(raw);
  });

  it("keeps a backslash that is not followed by three octal digits rather than guessing", () => {
    expect(tc.unescapeOutput(bytes("\\9x \\01 \\08z \\")).toString("latin1"), "tmux never writes these, so they stay literal")
      .toBe("\\9x \\01 \\08z \\");
  });
});

describe("parseControlLine", () => {
  it("decodes %output into the pane and its bytes", () => {
    const m = tc.parseControlLine(bytes("%output %12 a b\\015\\012"));
    expect(m.type).toBe("output");
    expect(m.pane, "the pane id is the first word").toBe("%12");
    expect(m.data.toString("latin1"), "the value keeps its spaces and is unescaped").toBe("a b\r\n");
  });

  it("reads %extended-output the same way, skipping the reserved words up to the lone colon", () => {
    const m = tc.parseControlLine(bytes("%extended-output %3 250 future words : x : y\\033"));
    expect([m.type, m.pane, m.age], "pause-after switches tmux to this form").toEqual(["output", "%3", 250]);
    expect(m.data.toString("latin1"), "only the FIRST \" : \" is the separator; the value may contain more").toBe("x : y\x1b");
  });

  it("splits block guards into time, number and flags, and keeps the whole guard", () => {
    expect(tc.parseControlLine("%begin 1791442090 282 1")).toEqual(
      { type: "begin", time: "1791442090", number: "282", flags: "1", guard: "1791442090 282 1" });
    expect(tc.parseControlLine("%error 1 2 0").type).toBe("error");
    expect(tc.parseControlLine("%end 1 2 0").flags).toBe("0");
  });

  it("names the pane in %pause and %continue, and the reason in %exit when tmux gives one", () => {
    expect(tc.parseControlLine("%pause %7")).toEqual({ type: "pause", pane: "%7" });
    expect(tc.parseControlLine("%continue %7")).toEqual({ type: "continue", pane: "%7" });
    expect(tc.parseControlLine("%exit")).toEqual({ type: "exit", reason: "" });
    expect(tc.parseControlLine("%exit server exited")).toEqual({ type: "exit", reason: "server exited" });
  });

  it("reads the layout, window closes, session changes and subscriptions the client acts on", () => {
    expect(tc.parseControlLine("%layout-change @0 fadd,50x8,0,0,0 fadd,50x8,0,0,0 *")).toEqual(
      { type: "layout-change", window: "@0", layout: "fadd,50x8,0,0,0", visibleLayout: "fadd,50x8,0,0,0", flags: "*" });
    expect(tc.parseControlLine("%window-close @4")).toEqual({ type: "window-close", window: "@4" });
    expect(tc.parseControlLine("%unlinked-window-close @4").type).toBe("unlinked-window-close");
    expect(tc.parseControlLine("%session-changed $1 my session")).toEqual({ type: "session-changed", session: "$1", name: "my session" });
    expect(tc.parseControlLine("%subscription-changed ccdeck-dead $0 @2 2 %2 : 1")).toEqual(
      { type: "subscription-changed", name: "ccdeck-dead", session: "$0", window: "@2", index: "2", pane: "%2", value: "1" });
  });

  it("returns every other notification by name, and a line without % as text", () => {
    expect(tc.parseControlLine("%window-renamed @0 bash")).toEqual({ type: "notification", name: "window-renamed", args: "@0 bash" });
    expect(tc.parseControlLine("%sessions-changed")).toEqual({ type: "notification", name: "sessions-changed", args: "" });
    expect(tc.parseControlLine("hello 世界")).toEqual({ type: "line", text: "hello 世界" });
  });
});

describe("quoteTmuxArg", () => {
  it("double-quotes, so spaces, semicolons, hashes and braces are inert", () => {
    expect(tc.quoteTmuxArg("a b; c #{x} {y}"), "inside double quotes tmux does not split or start a new command")
      .toBe("\"a b; c #{x} {y}\"");
  });

  it("escapes the characters tmux would otherwise expand or end the string on", () => {
    expect(tc.quoteTmuxArg("say \"hi\" \\ $HOME ${X} ~/x"), "quote and backslash end or start an escape; $ and ~ expand even in quotes")
      .toBe("\"say \\\"hi\\\" \\\\ \\$HOME \\${X} \\~/x\"");
  });

  it("writes newlines and other controls as escapes, because control mode reads one command per line", () => {
    expect(tc.quoteTmuxArg("a\nb\r\tc\x01\x1b\x7f")).toBe("\"a\\nb\\r\\tc\\001\\033\\177\"");
    expect(tc.quoteTmuxArg("x\ny"), "a literal newline would end the command").not.toContain("\n");
  });

  it("passes non-ASCII through as itself", () => {
    expect(tc.quoteTmuxArg("héllo 世界 🚀 —")).toBe("\"héllo 世界 🚀 —\"");
  });

  it("refuses a NUL instead of dropping it silently", () => {
    expect(() => tc.quoteTmuxArg("a\0b"), "tmux arguments are C strings").toThrow(TypeError);
  });
});

describe("the commands input and paste become", () => {
  it("types raw bytes as send-keys -H, at most INPUT_CHUNK bytes a command", () => {
    expect(tc.sendKeysCommands("%3", Buffer.from("\x1b[A é", "utf8"))).toEqual(["send-keys -t %3 -H 1b 5b 41 20 c3 a9"]);
    const many = tc.sendKeysCommands("%3", Buffer.alloc(tc.INPUT_CHUNK * 2 + 1, 0x61));
    expect(many.length, "two full chunks and a remainder").toBe(3);
    expect(many[0].split(" ").length - 4, "each command carries one chunk").toBe(tc.INPUT_CHUNK);
    expect(many[2], "the remainder is its own command").toBe("send-keys -t %3 -H 61");
  });

  it("stages a paste in the client's buffer and pastes it bracketed-if-asked, deleting the buffer", () => {
    const cmds = tc.pasteCommands("%3", "one\r\ntwo\0 $x", "ccdeck-paste-ab12");
    expect(cmds).toEqual([
      "set-buffer -b ccdeck-paste-ab12 -- \"one\\ntwo \\$x\"",
      "paste-buffer -p -d -b ccdeck-paste-ab12 -t %3",
    ]);
    expect(tc.pasteCommands("%3", "", "b"), "an empty paste sends nothing").toEqual([]);
  });

  it("appends a long paste in pieces and never splits a surrogate pair between them", () => {
    const text = `${"a".repeat(tc.PASTE_CHUNK - 1)}🚀${"b".repeat(10)}`;
    const cmds = tc.pasteCommands("%1", text, "buf");
    expect(cmds.length, "two set-buffer pieces and the paste").toBe(3);
    expect(cmds[0].startsWith("set-buffer -b buf -- "), "the first piece replaces the buffer").toBe(true);
    expect(cmds[1].startsWith("set-buffer -a -b buf -- "), "the next appends to it").toBe(true);
    expect(cmds[1], "the emoji moved whole into the second piece").toContain("🚀");
    expect(cmds[0], "and left no half of itself behind").not.toMatch(/[\ud800-\udfff]/);
  });
});

describe("layoutPanes", () => {
  it("finds every pane and its size in a nested layout", () => {
    expect(tc.layoutPanes("fadd,50x8,0,0,0")).toEqual([{ pane: "%0", cols: 50, rows: 8 }]);
    expect(tc.layoutPanes("1a2b,200x50,0,0{100x50,0,0,1,99x50,101,0[99x25,101,0,2,99x24,101,26,7]}")).toEqual([
      { pane: "%1", cols: 100, rows: 50 }, { pane: "%2", cols: 99, rows: 25 }, { pane: "%7", cols: 99, rows: 24 },
    ]);
  });
});

/** A parseSeedInfo answer with the fields a test cares about. */
function info(over: Record<string, unknown> = {}) {
  return { ...tc.parseSeedInfo("pane_width=10 pane_height=3 cursor_flag=1 wrap_flag=1 scroll_region_upper=0 scroll_region_lower=2"), ...over };
}

describe("buildSeed", () => {
  it("reads the display-message answer by name, so a variable an old tmux lacks shifts nothing", () => {
    const i = tc.parseSeedInfo("alternate_on=1 cursor_x=4 cursor_y=2 pane_width=80 pane_height=24 cursor_flag=0 cursor_shape= mouse_all_flag=1 mouse_sgr_flag=1 scroll_region_upper=0 scroll_region_lower=23");
    expect([i.alternate, i.cursorX, i.cursorY, i.cols, i.rows, i.cursorVisible, i.mouseAll, i.mouseSgr, i.cursorShape])
      .toEqual([true, 4, 2, 80, 24, false, true, true, ""]);
  });

  it("writes history then the visible rows top to bottom, and puts the cursor last", () => {
    const s = tc.buildSeed({ info: info({ cursorX: 2, cursorY: 1 }), lines: ["h1", "h2", "r1", "r2", "r3"] }).toString("utf8");
    expect(s.startsWith("\x1bc"), "a full reset first, so the seed is right even on a used emulator").toBe(true);
    expect(s, "five lines, four newlines: two scroll into history, three stay on screen")
      .toContain("h1\r\nh2\r\nr1\r\nr2\r\nr3\x1b[0m");
    expect(s.endsWith("\x1b[2;3H\x1b[?25h"), "the cursor is 0-based in tmux and 1-based in CUP").toBe(true);
  });

  it("scrolls on the default background so a coloured line end does not paint the next row", () => {
    const s = tc.buildSeed({ info: info(), lines: ["\x1b[41mred", "still red", "\x1b[0mplain"] }).toString("utf8");
    expect(s, "the background is switched off for the newline and then restated")
      .toContain("\x1b[41mred\x1b[49m\r\n\x1b[41mstill red\x1b[49m\r\n\x1b[41m\x1b[0mplain");
  });

  it("tracks the background through every SGR form capture-pane writes", () => {
    expect(tc.trailingBackground("\x1b[48;5;123mx")).toBe("\x1b[48;5;123m");
    expect(tc.trailingBackground("\x1b[1;48;2;1;2;3;4mx"), "a truecolour background with an attribute either side").toBe("\x1b[48;2;1;2;3m");
    expect(tc.trailingBackground("\x1b[38;2;9;9;9;44m"), "a truecolour FOREGROUND does not swallow the background after it").toBe("\x1b[44m");
    expect(tc.trailingBackground("\x1b[48:5:9m"), "the colon form").toBe("\x1b[48:5:9m");
    expect(tc.trailingBackground("\x1b[49m", "\x1b[41m")).toBe("");
    expect(tc.trailingBackground("\x1b[m", "\x1b[41m"), "an empty SGR is a reset").toBe("");
    expect(tc.trailingBackground("no codes", "\x1b[102m"), "nothing said, nothing changed").toBe("\x1b[102m");
  });

  it("on the alternate screen, rebuilds the saved normal screen first, then enters the alternate one", () => {
    const s = tc.buildSeed({
      info: info({ alternate: true, rows: 3, cursorX: 0, cursorY: 0 }),
      lines: ["old", "A1", "A2", "A3"],
      saved: ["$ ls", "$ claude", ""],
    }).toString("utf8");
    const enter = s.indexOf("\x1b[?1049h");
    expect(enter, "the alternate screen is entered").toBeGreaterThan(0);
    expect(s.slice(0, enter), "history and the saved screen go into the normal buffer")
      .toContain("old\r\n$ ls\r\n$ claude\r\n");
    expect(s.slice(0, enter), "the cursor the TUI returns to is the line after the shell's last output")
      .toMatch(/\x1b\[3;1H$/);
    expect(s.slice(enter), "the alternate rows are placed by row").toContain("\x1b[1;1HA1\x1b[2;1HA2\x1b[3;1HA3");
  });

  it("restates the modes no %output will repeat, scroll region and origin before the cursor", () => {
    const s = tc.buildSeed({
      info: info({ rows: 10, scrollTop: 2, scrollBottom: 7, origin: true, cursorY: 5, cursorX: 1, cursorVisible: false,
        keypadCursor: true, keypad: true, mouseButton: true, mouseAll: true, mouseSgr: true, insert: true, wrap: false,
        cursorShape: "bar", cursorBlinking: false }),
      lines: [],
    }).toString("utf8");
    const tail = s.slice(s.lastIndexOf("\x1b[0m") + 4);
    expect(tail).toBe("\x1b[3;8r\x1b[?6h\x1b[4h\x1b[?7l\x1b[?1h\x1b=\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[4;2H\x1b[?25l\x1b[6 q");
  });
});

// ── the connection, against a scripted peer ─────────────────────────────────

type Reply = { ok?: boolean; lines?: string[] } | null;
interface FakeOpts { respond?: (line: string) => Reply; attach?: string | null; pid?: number }

/**
 * A `tmux -C` that answers each command line with `respond`'s block, or, when
 * that returns null, leaves it for the test to answer by hand. Its stdout is a
 * stream the test can also write notifications into, in any chunking it likes.
 */
function fakeTmux({ respond = () => ({}), attach = null, pid = 40_000 + Math.floor(Math.random() * 1000) }: FakeOpts = {}) {
  const written: string[] = [];
  let n = 100;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as string | null, stdout, stderr,
    stdin: null as unknown as Writable, kill: (sig?: string) => { end(null, sig ?? "SIGTERM"); return true; } });
  const send = (text: string | Buffer) => stdout.write(text);
  const reply = (lines: string[] = [], ok = true, flags = 1) => {
    const g = `1791 ${++n} ${flags}`;
    send(`%begin ${g}\n${lines.map(l => `${l}\n`).join("")}%${ok ? "end" : "error"} ${g}\n`);
  };
  function end(code: number | null, sig: string | null = null) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = sig;
    setImmediate(() => { child.emit("exit", code, sig); child.emit("close", code, sig); });
  }
  let partial = "";
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      partial += chunk.toString("utf8");
      let i;
      while ((i = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, i);
        partial = partial.slice(i + 1);
        written.push(line);
        const r = respond(line);
        if (r) reply(r.lines ?? [], r.ok !== false);
      }
      cb();
    },
    // End of input is how a real control client is told to detach.
    final(cb) { send("%exit\n"); end(0); cb(); },
  });
  let argv: string[] = [];
  const spawn = (_file: string, a: string[]) => {
    argv = a;
    // attach-session's own reply is the first block, before any command's.
    if (attach === null) send("%begin 1791 1 0\n%end 1791 1 0\n%session-changed $0 s\n");
    else { send(`%begin 1791 1 0\n${attach}\n%error 1791 1 0\n%exit\n`); end(1); }
    return child;
  };
  return { child, written, send, reply, spawn, end, argv: () => argv };
}

/** The default answers: the pane is %0 in @0 of $0, 120x40, alive. */
const PANE_INFO = "$0 @0 %0 120 40 0";
const answers = (extra: (line: string) => Reply = () => undefined as unknown as Reply) => (line: string): Reply => {
  const own = extra(line);
  if (own !== undefined) return own;
  if (line.startsWith("display-message -p") && line.includes("#{session_id} #{window_id}")) return { lines: [PANE_INFO] };
  return {};
};

function open(fake: ReturnType<typeof fakeTmux>, opts: Record<string, unknown> = {}) {
  return tc.openControl({ tmux: "/fake/tmux", socket: { name: "ccdeck-test-fake" }, target: "s", spawn: fake.spawn, ...opts });
}

const SEED_INFO = "alternate_on=0 cursor_x=0 cursor_y=0 pane_width=120 pane_height=40 cursor_flag=1 wrap_flag=1 scroll_region_upper=0 scroll_region_lower=39";

describe("the control client, against a fake tmux", () => {
  it("takes the first block as attach's own reply, then answers commands in the order sent", async () => {
    const fake = fakeTmux({ respond: answers(l => (l === "show-options -g status" ? { lines: ["status on"] } : undefined as unknown as Reply)) });
    const c = open(fake);
    const early = c.cmd("show-options -g status");
    const info = await c.ready;
    expect(info, "ready is the pane the client streams").toEqual({ pane: "%0", window: "@0", session: "$0", cols: 120, rows: 40, dead: false });
    expect(await early, "a command sent before tmux had attached still gets its own reply, not attach's")
      .toEqual({ ok: true, lines: ["status on"] });
    expect(fake.argv(), "attach carries the client flags and an exact-match session name")
      .toEqual(["-L", "ccdeck-test-fake", "-u", "-C", "attach-session", "-f", "pause-after=2", "-t", "=s"]);
    expect(fake.written[1], "the pane's death is watched through the %* subscription")
      .toBe("refresh-client -B \"ccdeck-dead:%*:#{pane_dead}\"");
    await c.close();
  });

  it("answers an %error reply as not ok, with tmux's words", async () => {
    const fake = fakeTmux({ respond: answers(l => (l === "nosuchcmd" ? { ok: false, lines: ["parse error: unknown command: nosuchcmd"] } : undefined as unknown as Reply)) });
    const c = open(fake);
    expect(await c.cmd("nosuchcmd")).toEqual({ ok: false, lines: ["parse error: unknown command: nosuchcmd"] });
    await c.close();
  });

  it("does not take a hook's block (flags 0) for the reply to its own command", async () => {
    const fake = fakeTmux({ respond: answers(l => (l === "list-buffers" ? null : undefined as unknown as Reply)) });
    const c = open(fake);
    await c.ready;
    const p = c.cmd("list-buffers");
    await until(() => fake.written.includes("list-buffers"), "the command");
    fake.reply(["from a hook"], true, 0);
    fake.reply(["mine"]);
    expect(await p, "flags 0 marks a command that did not come from this client's stdin").toEqual({ ok: true, lines: ["mine"] });
    await c.close();
  });

  it("is not fooled by command output that looks like another block's end", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.startsWith("capture-pane") ? null : undefined as unknown as Reply)) });
    const c = open(fake);
    await c.ready;
    const p = c.cmd("capture-pane -p");
    await until(() => fake.written.includes("capture-pane -p"), "the command");
    fake.send("%begin 9 50 1\n%end 9 49 1\n%error 1 2 1\nlast\n%end 9 50 1\n");
    expect(await p, "only the begin's own guard ends the block").toEqual({ ok: true, lines: ["%end 9 49 1", "%error 1 2 1", "last"] });
    await c.close();
  });

  it("rejects ready and reports 'ended' when tmux cannot find the session", async () => {
    const fake = fakeTmux({ attach: "can't find session: gone" });
    const c = open(fake);
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await expect(c.ready).rejects.toThrow("can't find session: gone");
    expect(exits, "exactly one exit, saying what tmux said").toEqual([{ reason: "ended", message: "can't find session: gone" }]);
    expect(await c.cmd("anything"), "a command after the end is answered, not left hanging").toMatchObject({ ok: false });
    await c.close();
  });

  it("drops pane output until the seed's capture is answered, and hands over what follows in order, even within one chunk", async () => {
    const manual = (l: string) => (l.includes("alternate_on=") || l.startsWith("capture-pane") ? null : undefined as unknown as Reply);
    const fake = fakeTmux({ respond: answers(manual) });
    const c = open(fake);
    const got: string[] = [];
    c.on("output", (d: Buffer) => got.push(d.toString("latin1")));
    await c.ready;
    fake.send("%output %0 before-seed\n");
    const seeded = c.seed({ history: 0 });
    await until(() => fake.written.filter(l => l.startsWith("capture-pane")).length === 2, "the seed's captures");
    expect(fake.written.slice(-3), "one display and two captures, sent together").toEqual([
      expect.stringMatching(/^display-message -p -t %0 "alternate_on=#\{alternate_on\} /),
      "capture-pane -p -e -N -t %0",
      "capture-pane -p -e -N -a -q -t %0",
    ]);
    // One write: output before, between and after the three replies.
    fake.send([
      "%output %0 old-1", "%begin 1 1 1", SEED_INFO, "%end 1 1 1",
      "%output %0 old-2", "%begin 1 2 1", "screen row", "%end 1 2 1",
      "%output %0 old-3", "%begin 1 3 1", "", "%end 1 3 1",
      "%output %0 new-1", "%output %9 other-pane", "%output %0 new-2\\015\\012", "",
    ].join("\n"));
    const seed = await seeded;
    const text = seed.bytes.toString("utf8");
    expect(text, "the captured row is in the seed").toContain("screen row");
    expect(text.includes("old-"), "output up to the last capture's reply is already in the capture").toBe(false);
    expect(text.endsWith("new-1new-2\r\n"), "output read in the same chunk, before the seed could be delivered, ends the seed")
      .toBe(true);
    expect(got, "so no listener saw it ahead of the seed it belongs after").toEqual([]);
    expect([seed.cols, seed.rows, seed.cursor, seed.alternate]).toEqual([120, 40, [0, 0], false]);
    fake.send("%output %0 later\n");
    await until(() => got.length > 0, "the next output");
    expect(got, "from then on, output is streamed").toEqual(["later"]);
    await c.close();
  });

  it("asks for a reseed when the pane changes size between the capture and the seed's delivery", async () => {
    const manual = (l: string) => (l.includes("alternate_on=") || l.startsWith("capture-pane") ? null : undefined as unknown as Reply);
    const fake = fakeTmux({ respond: answers(manual) });
    const c = open(fake);
    const events: string[] = [];
    c.on("output", () => events.push("output"));
    c.on("size", () => events.push("size"));
    c.on("reseed", () => events.push("reseed"));
    await c.ready;
    const seeded = c.seed({ history: 0 });
    await until(() => fake.written.filter(l => l.startsWith("capture-pane")).length === 2, "the captures");
    fake.send([
      "%begin 1 1 1", SEED_INFO, "%end 1 1 1", "%begin 1 2 1", "%end 1 2 1", "%begin 1 3 1", "%end 1 3 1",
      "%output %0 at-old-size", "%layout-change @0 aaaa,90x30,0,0,0 aaaa,90x30,0,0,0 *", "%output %0 at-new-size", "",
    ].join("\n"));
    const seed = await seeded;
    expect(seed.cols, "the seed is what was captured").toBe(120);
    expect(events, "no event could be placed against a seed not yet delivered, so the seed is replaced instead")
      .toEqual(["reseed"]);
    expect(c.size, "the size tmux reported is kept for the next seed").toEqual({ cols: 90, rows: 30 });
    fake.send("%output %0 still-shut\n");
    await tick();
    await tick();
    expect(events, "the stream stays shut until that next seed").toEqual(["reseed"]);
    await c.close();
  });

  it("reassembles an %output line split across chunks, mid-escape and mid-character", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.includes("alternate_on=") ? { lines: [SEED_INFO] } : undefined as unknown as Reply)) });
    const c = open(fake);
    const got: Buffer[] = [];
    c.on("output", (d: Buffer) => got.push(d));
    await c.seed({ history: 0 });
    const line = Buffer.concat([Buffer.from("%output %0 A\\033[1m世", "utf8"), Buffer.from("\n")]);
    const cut1 = line.indexOf("\\033") + 2;          // inside the escape
    const cut2 = line.length - 3;                    // inside 世 (three bytes)
    fake.send(line.subarray(0, cut1));
    await tick();
    fake.send(line.subarray(cut1, cut2));
    await tick();
    expect(got.length, "nothing is emitted until the line is whole").toBe(0);
    fake.send(line.subarray(cut2));
    await until(() => got.length === 1, "the output");
    expect(got[0].equals(Buffer.from("A\x1b[1m世", "utf8")), "the bytes are exactly the pane's").toBe(true);
    await c.close();
  });

  it("answers %pause with a continue and a 'reseed', and keeps the stream shut until the next seed", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.includes("alternate_on=") ? { lines: [SEED_INFO] } : undefined as unknown as Reply)) });
    const c = open(fake);
    const events: string[] = [];
    c.on("output", (d: Buffer) => events.push(`out ${d.toString("latin1")}`));
    c.on("reseed", () => events.push("reseed"));
    await c.seed({ history: 0 });
    fake.send("%output %0 a\n%pause %9\n%output %0 b\n%pause %0\n%output %0 lost\n");
    await until(() => events.includes("reseed"), "the reseed");
    await tick();
    expect(fake.written.at(-1), "the pane is continued, quoted for the parser").toBe("refresh-client -A \"%0:continue\"");
    expect(events, "another pane's pause is not ours; after ours, nothing until a new seed")
      .toEqual(["out a", "out b", "reseed"]);
    await c.seed({ history: 0 });
    fake.send("%output %0 fresh\n");
    await until(() => events.length === 4, "the resumed output");
    expect(events.at(-1)).toBe("out fresh");
    await c.close();
  });

  it("does not let a seed that was in flight when the pause landed reopen the stream", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.includes("alternate_on=") || l.startsWith("capture-pane") ? null : undefined as unknown as Reply)) });
    const c = open(fake);
    const got: string[] = [];
    c.on("output", (d: Buffer) => got.push(d.toString("latin1")));
    await c.ready;
    const stale = c.seed({ history: 0 });
    await until(() => fake.written.filter(l => l.startsWith("capture-pane")).length === 2, "the captures");
    fake.send(`%pause %0\n%begin 1 1 1\n${SEED_INFO}\n%end 1 1 1\n%begin 1 2 1\n%end 1 2 1\n%begin 1 3 1\n%end 1 3 1\n%output %0 after-stale-seed\n`);
    const s = await stale;
    fake.send("%output %0 later\n");
    await tick();
    await tick();
    expect(got, "that capture predates the continue, so what follows it has a hole in it").toEqual([]);
    expect(s.bytes.toString("latin1").includes("after-stale-seed"), "nor is it folded into the stale seed").toBe(false);
    await c.close();
  });

  it("reports the pane's size from %layout-change, at its place in the stream", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.includes("alternate_on=") ? { lines: [SEED_INFO] } : undefined as unknown as Reply)) });
    const c = open(fake, { ignoreSize: true });
    const events: string[] = [];
    c.on("output", (d: Buffer) => events.push(`out ${d.toString("latin1")}`));
    c.on("size", (s: { cols: number; rows: number }) => events.push(`size ${s.cols}x${s.rows}`));
    await c.seed({ history: 0 });
    fake.send([
      "%output %0 old", "%layout-change @0 1a2b,200x50,0,0{100x50,0,0,0,99x50,101,0,4} 1a2b,200x50,0,0{100x50,0,0,0,99x50,101,0,4} *",
      "%layout-change @7 ffff,10x10,0,0,9 ffff,10x10,0,0,9 *", "%output %0 new",
      "%layout-change @0 1a2b,200x50,0,0{100x50,0,0,0,99x50,101,0,4} 1a2b,200x50,0,0{100x50,0,0,0,99x50,101,0,4} *", "",
    ].join("\n"));
    await until(() => events.length === 3, "the events");
    expect(events, "between the two outputs, once, and never for another window").toEqual(["out old", "size 100x50", "out new"]);
    expect(c.size).toEqual({ cols: 100, rows: 50 });
    expect(await c.resize(80, 24), "the user's terminal owns the size, so resize answers without asking tmux")
      .toEqual({ ok: true, lines: [] });
    expect(fake.written.some(l => l.startsWith("refresh-client -C")), "no refresh-client -C was sent").toBe(false);
    expect(fake.argv(), "ignore-size is a flag of the attach itself").toContain("pause-after=2,ignore-size");
    await c.close();
  });

  it("resizes a dock-owned client with refresh-client -C and refuses a nonsense size", async () => {
    const fake = fakeTmux({ respond: answers() });
    const c = open(fake);
    expect(await c.resize(100, 30)).toEqual({ ok: true, lines: [] });
    expect(fake.written).toContain("refresh-client -C 100x30");
    expect(await c.resize(0, 30)).toMatchObject({ ok: false });
    await c.close();
  });

  it("reports a dead pane as 'ended' from the subscription, and keeps the client to read the last frame", async () => {
    const fake = fakeTmux({ respond: answers(l => (l.includes("alternate_on=") ? { lines: [SEED_INFO] } : undefined as unknown as Reply)) });
    const c = open(fake);
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await c.ready;
    fake.send("%subscription-changed ccdeck-dead $0 @0 0 %0 : 0\n%subscription-changed ccdeck-dead $0 @1 1 %3 : 1\n");
    await tick();
    expect(exits, "another pane dying is not ours").toEqual([]);
    fake.send("%subscription-changed ccdeck-dead $0 @0 0 %0 : 1\n%subscription-changed ccdeck-dead $0 @0 0 %0 : 1\n");
    await until(() => exits.length > 0, "the exit");
    expect(exits).toEqual([{ reason: "ended" }]);
    expect((await c.seed({ history: 0 })).cols, "a dead pane can still be captured").toBe(120);
    await c.close();
    expect(exits, "exit is emitted once, close() included").toHaveLength(1);
  });

  it("checks the pane when the stream says it may be gone, and reports what it finds", async () => {
    // Each case: a notification, then what tmux says about the pane when asked.
    const cases: Array<[string, Reply, unknown[], { cols: number; rows: number } | null]> = [
      ["%window-close @0", { ok: false, lines: ["can't find pane: %0"] }, [{ reason: "ended" }], null],
      ["%layout-change @0 bbbb,80x24,0,0,9 bbbb,80x24,0,0,9 *", { lines: ["1 80 24 @0 $0"] }, [{ reason: "ended" }], null],
      // break-pane moved it to a new window of the same session: follow it.
      ["%layout-change @0 bbbb,80x24,0,0,9 bbbb,80x24,0,0,9 *", { lines: ["0 70 20 @5 $0"] }, [], { cols: 70, rows: 20 }],
      // This client was switched to another session; the pane lives on where it was.
      ["%session-changed $9 elsewhere", { lines: ["0 120 40 @0 $0"] }, [{ reason: "detached" }], null],
      ["%unlinked-window-close @3", null, [], null],
    ];
    for (const [note, answer, want, size] of cases) {
      let asked = false;
      const fake = fakeTmux({ respond: answers(l => (l.startsWith("display-message -p -t %0 \"#{pane_dead}") ? (asked = true, answer) : undefined as unknown as Reply)) });
      const c = open(fake);
      const exits: unknown[] = [];
      const sizes: unknown[] = [];
      c.on("exit", (e: unknown) => exits.push(e));
      c.on("size", (s: unknown) => sizes.push(s));
      await c.ready;
      fake.send(`${note}\n`);
      if (answer) await until(() => asked && (exits.length > 0 || sizes.length > 0), `the answer to ${note}`);
      else { await tick(); await tick(); }
      expect(exits, `${note} → ${JSON.stringify(answer)}`).toEqual(want);
      if (size) expect(sizes, "the moved pane's size").toEqual([size]);
      if (!answer) expect(asked, "another window closing is none of its business").toBe(false);
      await c.close();
    }
  });

  it("sends input as send-keys -H chunks once the pane is known, and refuses it when read-only", async () => {
    const fake = fakeTmux({ respond: answers() });
    const c = open(fake);
    const p = c.input(new Uint8Array([0x1b, 0x5b, 0x41]));
    expect(await p).toEqual({ ok: true, lines: [] });
    expect(fake.written, "sent after attach, with the pane tmux named").toContain("send-keys -t %0 -H 1b 5b 41");
    expect(await c.input(""), "nothing to send is not an error").toEqual({ ok: true, lines: [] });
    await c.close();
    const ro = fakeTmux({ respond: answers() });
    const r = open(ro, { readOnly: true });
    expect(await r.input("x")).toEqual({ ok: false, lines: ["read-only"] });
    expect(await r.paste("x")).toEqual({ ok: false, lines: ["read-only"] });
    expect(ro.written.some(l => l.startsWith("send-keys") || l.startsWith("set-buffer")), "nothing reached tmux").toBe(false);
    await r.close();
  });

  it("pastes through a buffer of its own, bracketed only if the pane asked", async () => {
    const fake = fakeTmux({ respond: answers() });
    const c = open(fake);
    expect(await c.paste("a\nb")).toEqual({ ok: true, lines: [] });
    const set = fake.written.find(l => l.startsWith("set-buffer")) ?? "";
    const name = /-b (ccdeck-paste-[0-9a-f]{8}) /.exec(set)?.[1];
    expect(name, "a per-client buffer, so two panels pasting at once cannot swap text").toBeTruthy();
    expect(fake.written.at(-1)).toBe(`paste-buffer -p -d -b ${name} -t %0`);
    await c.close();
  });

  it("refuses a command line that would be two commands, or none", async () => {
    const fake = fakeTmux({ respond: answers() });
    const c = open(fake);
    await c.ready;
    const before = fake.written.length;
    expect(await c.cmd("list-sessions\nkill-server")).toMatchObject({ ok: false });
    expect(await c.cmd("   "), "an empty line would detach the client").toMatchObject({ ok: false });
    expect(fake.written.length, "neither reached tmux").toBe(before);
    await c.close();
  });

  it("attaches to a pane's session rather than the pane, so the user's current window stays put", async () => {
    const fake = fakeTmux({ respond: answers() });
    const asked: string[][] = [];
    const execFile = (_f: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
      asked.push(args);
      cb(null, "$3\n");
    };
    const c = tc.openControl({ tmux: { path: "/fake/tmux" }, socket: { path: "/tmp/user-sock" }, target: "%5", ignoreSize: true, spawn: fake.spawn, execFile });
    await c.ready;
    expect(asked[0], "the session is looked up first, on the user's socket").toEqual(["-S", "/tmp/user-sock", "display-message", "-p", "-t", "%5", "#{session_id}"]);
    expect(fake.argv().slice(-2), "and attached by id").toEqual(["-t", "$3"]);
    expect(fake.written[0], "the pane named is the pane streamed").toMatch(/^display-message -p -t %5 /);
    await c.close();
  });

  it("tells a detach from an ending by asking whether the pane outlived the client", async () => {
    for (const [answer, reason] of [["0\n", "detached"], ["1\n", "ended"], [null, "ended"]] as const) {
      const fake = fakeTmux({ respond: answers() });
      const asked: string[][] = [];
      const execFile = (_f: string, a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
        asked.push(a);
        return answer === null ? cb(new Error("can't find session: $0"), "") : cb(null, answer);
      };
      const c = open(fake, { execFile });
      const exits: unknown[] = [];
      c.on("exit", (e: unknown) => exits.push(e));
      await c.ready;
      fake.send("%exit\n");
      fake.end(0);
      await until(() => exits.length > 0, "the exit");
      await tick();
      expect(exits, `pane_dead ${JSON.stringify(answer)} → ${reason}`).toEqual([{ reason }]);
      expect(asked[0], "the session first — a killed session's pane can still look alive for a moment")
        .toEqual(["-L", "ccdeck-test-fake", "has-session", "-t", "$0", ";", "display-message", "-p", "-t", "%0", "#{pane_dead}"]);
      expect(c.closed).toBe(true);
    }
  });

  it("settles what was pending and says 'error' when tmux dies without a word", async () => {
    const fake = fakeTmux({ respond: answers(l => (l === "list-panes" ? null : undefined as unknown as Reply)) });
    const c = open(fake);
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await c.ready;
    const p = c.cmd("list-panes");
    await until(() => fake.written.includes("list-panes"), "the command");
    fake.child.stderr.write("lost server\n");
    await tick();
    fake.end(1);
    expect(await p, "a command in flight is answered, never left hanging").toMatchObject({ ok: false });
    await until(() => exits.length > 0, "the exit");
    expect(exits).toEqual([{ reason: "error", message: "lost server" }]);
  });

  it("keeps the tmux child in the reaped set while it runs, and closes by ending its input", async () => {
    const fake = fakeTmux({ respond: answers() });
    const c = open(fake);
    const exits: unknown[] = [];
    c.on("exit", (e: unknown) => exits.push(e));
    await c.ready;
    expect(liveChildPids(), "shutdown's killLiveChildren must be able to reach it").toContain(fake.child.pid);
    await c.close();
    expect(fake.child.exitCode, "end of input detached it; nothing had to be killed").toBe(0);
    expect(liveChildPids(), "and it leaves the set once it has gone").not.toContain(fake.child.pid);
    expect(exits).toEqual([{ reason: "closed" }]);
    expect(c.closed).toBe(true);
  });

  it("needs a socket, so it can never fall back to the user's default tmux server", () => {
    const fake = fakeTmux();
    expect(() => tc.openControl({ tmux: "/fake/tmux", target: "s", spawn: fake.spawn }), "no socket").toThrow(TypeError);
    expect(() => tc.openControl({ tmux: "/fake/tmux", socket: {}, target: "s", spawn: fake.spawn }), "an empty one").toThrow(TypeError);
  });
});
