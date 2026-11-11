// Paths in narrow places were cut at their END, so the file's name went first:
// the Inspector's cwd read "/home/constantin/.claude/jobs…" and every Tool calls
// row "Read /home/constantin/.claude/job…", all alike. One shared display now:
// read from the session's folder, "~" for a home folder, cut in the middle by
// CSS so the last segment stays, the whole path in the hover.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { displayPath, homeFolded, insideFolder, splitPath } from "../path-display";
import PathText from "../components/PathText";
import Detail from "../components/Detail";
import { ToolBlock } from "../components/ToolModal";
import { TimeBody } from "../components/InspectorTime";
import { ContextView } from "../components/ContextModal";
import { argIsPath, callArg, spanTable, type SessionTurn } from "../inspector-time";
import { toolView } from "../tool-view";
import type { AgentNodeData, ToolCall } from "../types";
import { sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rule whose selector list is exactly `selector`. */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1];
};

describe("where a path is read from", () => {
  const CWD = "/home/me/work/ccdeck";
  it("reads a path inside the session's folder from there", () => {
    expect(displayPath("/home/me/work/ccdeck/README.md", CWD)).toBe("README.md");
    expect(displayPath("/home/me/work/ccdeck/src/web/app.ts", CWD)).toBe("src/web/app.ts");
    expect(displayPath("/home/me/work/ccdeck/src/web/app.ts", `${CWD}/`)).toBe("src/web/app.ts");
  });
  it("does not take a sibling folder that shares the name's start for the session's", () => {
    expect(insideFolder("/home/me/work/ccdeck-site/index.html", CWD)).toBeNull();
    expect(displayPath("/home/me/work/ccdeck-site/index.html", CWD)).toBe("~/work/ccdeck-site/index.html");
  });
  it("writes the home folder as ~, the session's folder itself included", () => {
    expect(displayPath(CWD)).toBe("~/work/ccdeck");
    expect(displayPath(CWD, CWD)).toBe("~/work/ccdeck");
    expect(displayPath("/home/me/.claude/CLAUDE.md", CWD)).toBe("~/.claude/CLAUDE.md");
    expect(displayPath("/Users/me/Desktop/notes.md")).toBe("~/Desktop/notes.md");
    expect(displayPath("/root/x.txt")).toBe("~/x.txt");
    expect(homeFolded("/home/me")).toBe("~");
    expect(homeFolded("/rootfs/x")).toBeNull();
    expect(homeFolded("/home")).toBeNull();
  });
  it("leaves a path outside both as it is", () => {
    expect(displayPath("/etc/hosts", CWD)).toBe("/etc/hosts");
    expect(displayPath("/tmp/build/out.log", CWD)).toBe("/tmp/build/out.log");
    expect(displayPath("src/relative.ts", CWD)).toBe("src/relative.ts");
  });
  it("reads nothing from a root folder, where every path is inside", () => {
    expect(displayPath("/etc/hosts", "/")).toBe("/etc/hosts");
    expect(displayPath("C:\\data\\x.csv", "C:\\")).toBe("C:\\data\\x.csv");
  });
});

describe("a Windows path", () => {
  const CWD = "C:\\Users\\me\\work\\app";
  it("is read from the session's folder with its backslashes kept", () => {
    expect(displayPath("C:\\Users\\me\\work\\app\\src\\index.ts", CWD)).toBe("src\\index.ts");
    expect(displayPath("C:\\Users\\me\\work\\app\\README.md", `${CWD}\\`)).toBe("README.md");
  });
  it("matches the folder whatever the case of its letters and its slashes", () => {
    expect(displayPath("c:/users/ME/work/app/README.md", CWD)).toBe("README.md");
    expect(displayPath("C:\\USERS\\me\\Work\\App\\src\\a.ts", CWD)).toBe("src\\a.ts");
  });
  it("writes the home folder as ~", () => {
    expect(displayPath("C:\\Users\\me\\work")).toBe("~\\work");
    expect(displayPath("c:/Users/me/.claude/CLAUDE.md")).toBe("~/.claude/CLAUDE.md");
  });
  it("leaves another drive and a share as they are, and reads a share's folder", () => {
    expect(displayPath("D:\\data\\x.csv", CWD)).toBe("D:\\data\\x.csv");
    expect(displayPath("\\\\srv\\share\\a\\b.txt", "\\\\srv\\share")).toBe("a\\b.txt");
  });
});

describe("the split: a head that gives way and a last segment that stays", () => {
  it("keeps the last segment with the separator before it", () => {
    expect(splitPath("src/web/app.ts")).toEqual({ head: "src/web", tail: "/app.ts" });
    expect(splitPath("~/x")).toEqual({ head: "~", tail: "/x" });
    expect(splitPath("src\\index.ts")).toEqual({ head: "src", tail: "\\index.ts" });
    expect(splitPath("C:\\x.txt")).toEqual({ head: "C:", tail: "\\x.txt" });
    expect(splitPath("/home/me/work/ccdeck")).toEqual({ head: "/home/me/work", tail: "/ccdeck" });
  });
  it("draws a path of one segment as the tail alone", () => {
    for (const p of ["README.md", "/etc", "~", "/", ""]) expect(splitPath(p)).toEqual({ head: "", tail: p });
  });
  it("counts a trailing separator in the last segment", () => {
    expect(splitPath("src/web/")).toEqual({ head: "src", tail: "/web/" });
  });
  it("keeps more segments when asked, for files that all share one name", () => {
    expect(splitPath("~/work/app/CLAUDE.md", 2)).toEqual({ head: "~/work", tail: "/app/CLAUDE.md" });
    expect(splitPath("~/.claude/CLAUDE.md", 2)).toEqual({ head: "~", tail: "/.claude/CLAUDE.md" });
    expect(splitPath("CLAUDE.md", 2)).toEqual({ head: "", tail: "CLAUDE.md" });
  });
  it("moves and drops no character: the head and the tail are the path, in order", () => {
    for (const p of ["src/web/app.ts", "/etc/hosts", "C:\\a\\b\\c.txt", "~/x/", "a//b", "**/*.ts", "\\\\srv\\s\\f"]) {
      for (const keep of [1, 2, 3]) {
        const { head, tail } = splitPath(p, keep);
        expect(head + tail).toBe(p);
      }
    }
  });
});

describe("PathText", () => {
  const html = (props: Parameters<typeof PathText>[0]) => renderToStaticMarkup(createElement(PathText, props));
  it("draws the head and the tail as two spans, left to right, the whole path in the hover", () => {
    expect(html({ path: "/home/me/work/ccdeck/src/web/app.ts", cwd: "/home/me/work/ccdeck", className: "tool-arg" }))
      .toBe('<span class="path-text tool-arg" dir="ltr" title="/home/me/work/ccdeck/src/web/app.ts"><span class="path-head">src/web</span><span class="path-tail">/app.ts</span></span>');
  });
  it("draws no head for a path of one segment, and no title where the row has one", () => {
    expect(html({ path: "/home/me/work/ccdeck/README.md", cwd: "/home/me/work/ccdeck", hint: false }))
      .toBe('<span class="path-text" dir="ltr"><span class="path-tail">README.md</span></span>');
  });
});

describe("the sheet cuts the middle and follows the width", () => {
  it("lets the head shrink to nothing with its own ellipsis", () => {
    const head = rule(".path-head");
    expect(head).toMatch(/flex: 0 1 auto/);
    expect(head).toMatch(/min-width: 0/);
    expect(head).toMatch(/overflow: hidden/);
    expect(head).toMatch(/text-overflow: ellipsis/);
  });
  it("keeps the tail's width, and cuts it at its end only past the whole box", () => {
    const tail = rule(".path-tail");
    expect(tail).toMatch(/flex: none/);
    expect(tail).toMatch(/max-width: 100%/);
    expect(tail).toMatch(/text-overflow: ellipsis/);
  });
  it("sets the path in mono on one line, and never sets a direction", () => {
    const box = rule(".path-text");
    expect(box).toMatch(/display: inline-flex/);
    expect(box).toMatch(/min-width: 0/);
    expect(box).toMatch(/white-space: nowrap/);
    expect(box).toMatch(/font-family: var\(--font-mono\)/);
    expect(css).not.toMatch(/\.path-(?:text|head|tail)[^{]*\{[^}]*(?:^|[^-])direction\s*:/);
  });
  it("keeps the Time tab's argument at the right as a path too", () => {
    expect(rule(".insp-time-arg.path-text > :first-child")).toMatch(/margin-left: auto/);
  });
});

const A = (over: Partial<AgentNodeData> = {}) => ({
  id: "s", sessionId: "s-0123456789abcdef", label: "ccdeck", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, prompts: [], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;
const CWD = "/home/me/work/ccdeck";
const read = (id: string, file: string): ToolCall =>
  ({ id, name: "Read", input: { file_path: file }, inputPreview: JSON.stringify({ file_path: file }).slice(0, 80), startedAt: 1100, endedAt: 1200, ok: true }) as ToolCall;
const bash = { id: "b", name: "Bash", input: { command: "npm test" }, inputPreview: '{"command":"npm test"}', startedAt: 1300, endedAt: 1400, ok: true } as ToolCall;

describe("the Inspector's Identity and Tool calls", () => {
  const agent = A({ cwd: CWD, tools: [read("r1", `${CWD}/README.md`), read("r2", `${CWD}/src/web/app.ts`), read("r3", "/etc/hosts"), bash] });
  const out = renderToStaticMarkup(createElement(Detail, { agent, now: 2000 }));
  it("shows the cwd from ~, cut in the middle, the whole folder in the hover", () => {
    expect(out).toContain(`<span class="k">cwd</span><span class="path-text v" dir="ltr" title="${CWD}"><span class="path-head">~/work</span><span class="path-tail">/ccdeck</span></span>`);
  });
  it("keeps the session id row as it was", () => {
    expect(out).toContain('<span class="v">s-0123456789…</span>');
  });
  it("reads each call's file from the session's folder, so the rows differ by name", () => {
    expect(out).toContain('<span class="path-text tool-arg" dir="ltr"><span class="path-tail">README.md</span></span>');
    expect(out).toContain('<span class="path-text tool-arg" dir="ltr"><span class="path-head">src/web</span><span class="path-tail">/app.ts</span></span>');
    expect(out).toContain('<span class="path-text tool-arg" dir="ltr"><span class="path-head">/etc</span><span class="path-tail">/hosts</span></span>');
  });
  it("puts the whole path in the row's hover, and leaves a command as it was", () => {
    expect(out).toContain(`<button class="tool clickable" title="${CWD}/src/web/app.ts">`);
    expect(out).toContain('<button class="tool clickable" title="{&quot;command&quot;:&quot;npm test&quot;}">');
    expect(out).toContain('<span class="tool-arg">npm test</span>');
  });
});

describe("which arguments are paths", () => {
  it("is a file tool's path, whole", () => {
    const r = read("r", `${CWD}/a.ts`);
    expect(argIsPath(r, callArg(r))).toBe(true);
    expect(argIsPath(bash, callArg(bash))).toBe(false);
    const grep = { id: "g", name: "Grep", input: { pattern: "a/b", path: CWD }, startedAt: 0 } as ToolCall;
    expect(argIsPath(grep, callArg(grep))).toBe(false);
  });
  it("is not a preview that was cut short, nor a word with no folder in it", () => {
    const released = { id: "r", name: "Read", inputPreview: `{"file_path":"${CWD}/a/very/long/folder/that/is/cut…`, startedAt: 0 } as ToolCall;
    expect(argIsPath(released, callArg(released))).toBe(false);
    const bare = { id: "r", name: "Read", inputPreview: "Read arg", startedAt: 0 } as ToolCall;
    expect(argIsPath(bare, callArg(bare))).toBe(false);
  });
});

describe("the Time tab's rows", () => {
  const root = A({ cwd: CWD, prompts: [{ at: 1000, text: "go" }] as never, tools: [read("r1", `${CWD}/src/web/app.ts`), bash] });
  const table = spanTable({ agents: new Map([["s", root]]), sessionId: "s-0123456789abcdef", start: 1000, end: 2000, now: 2000 });
  it("marks a path and carries the session's folder", () => {
    expect(table.cwd).toBe(CWD);
    expect(table.rows.map(r => r.path ?? false)).toEqual([true, false]);
  });
  it("draws a path argument through PathText and a command as before", () => {
    const turn: SessionTurn = { open: false, totalMs: 1000, claudeMs: 600, machineMs: 400, youMs: 0 };
    const out = renderToStaticMarkup(createElement(TimeBody, { turn, table, now: 2000 }));
    expect(out).toContain(`<span class="path-text insp-time-arg" dir="ltr" title="${CWD}/src/web/app.ts"><span class="path-head">src/web</span><span class="path-tail">/app.ts</span></span>`);
    expect(out).toContain('<span class="insp-time-arg" title="npm test">npm test</span>');
  });
});

describe("the tool call dialog", () => {
  it("draws the input's file from the session's folder, and a range as before", () => {
    const view = toolView("Read", { file_path: `${CWD}/src/web/app.ts`, offset: 1, limit: 10 }, undefined);
    const file = renderToStaticMarkup(createElement(ToolBlock, { block: view.input[0], cwd: CWD }));
    expect(file).toContain(`<span class="path-text" dir="ltr" title="${CWD}/src/web/app.ts"><span class="path-head">src/web</span><span class="path-tail">/app.ts</span></span>`);
    expect(file).not.toContain("<code>");
    const range = renderToStaticMarkup(createElement(ToolBlock, { block: view.input[1], cwd: CWD }));
    expect(range).toContain("<code>1–10</code>");
  });
  it("draws a file outside every folder it knows as it is, still cut in the middle", () => {
    const view = toolView("Write", { file_path: "/tmp/out/report.md", content: "x" }, undefined);
    const file = renderToStaticMarkup(createElement(ToolBlock, { block: view.input[0] }));
    expect(file).toContain('<span class="path-head">/tmp/out</span><span class="path-tail">/report.md</span>');
  });
});

describe("the context breakdown's memory files", () => {
  const agent = A({
    cwd: CWD,
    context: {
      msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: 1000,
      memoryFiles: [{ path: `${CWD}/CLAUDE.md`, bytes: 100 }, { path: "/home/me/work/CLAUDE.md", bytes: 200 }, { path: "/home/me/.claude/CLAUDE.md", bytes: 300 }],
    },
  } as Partial<AgentNodeData>);
  const out = renderToStaticMarkup(createElement(ContextView, { agent }));
  it("reads each from the session's folder or from ~, keeping the folder above the name", () => {
    expect(out).toContain('<span class="path-text ctx-md-path" dir="ltr" title="/home/me/work/ccdeck/CLAUDE.md"><span class="path-tail">CLAUDE.md</span></span>');
    expect(out).toContain('<span class="path-head">~</span><span class="path-tail">/work/CLAUDE.md</span>');
    expect(out).toContain('<span class="path-head">~</span><span class="path-tail">/.claude/CLAUDE.md</span>');
  });
});
