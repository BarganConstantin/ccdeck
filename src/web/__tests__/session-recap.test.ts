// Claude Code's recap, from the transcript line to the three places it is drawn.
//
// Once a finished turn has sat for three minutes with the terminal out of
// focus, Claude Code writes one line into the session's transcript — the
// "※ recap:" the terminal prints when you come back. It is written for exactly
// the person who is looking at the deck instead of the terminal, so the deck
// reads it and draws it: a note beside the resting card that opens by itself
// behind a ※ on the card, three lines in the session list, all of it in the
// detail panel.
//
// These pin the parse, the rule for when a recap stops being true (half of it
// in the transcript, half on the client), the watch that finds it while no
// hook is firing, and where it lands. session-recap-server.test.ts drives the
// same thing through a real server.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RECAP_MARK, cleanRecap, foldRecapLine, recapOf } from "../../server/session-recap.mjs";
import { createOutputWatch } from "../../server/output-watch.mjs";
import { applyEvent, initialState } from "../reducer";
import { recapShown } from "../session-recap";
import { dismissRecap, isRecapDismissed, isRecapNoteId, recapKey, recapNoteId, toggleRecapDismissed } from "../recap-note";
import { autoLayout } from "../layout";
import { liveNodeIds, measuredNodeIds } from "../prune";
import { clusterBounds } from "../components/SessionClusters";
import { buildRows } from "../components/SessionList";
import type { HookEnvelope, HookPayload, SessionRecap } from "../types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SHEET = read("../styles.css");

const T0 = Date.parse("2026-09-14T11:09:28.646Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const SAID = "VCRM-8867 is planned: a SupremeAdmin-only Report Usage page that audits every report run. Next: say go and I will create the worktree.";

/** A recap line in the shape Claude Code 2.1.270 writes it, copied from a real
 *  transcript on this machine with the content shortened. */
const RECAP = (content: string, at = T0, extra: Record<string, unknown> = {}) => JSON.stringify({
  parentUuid: "1dd34dfd", isSidechain: false, type: "system", subtype: "away_summary",
  content, timestamp: iso(at), uuid: "f468ef23", isMeta: false, userType: "external",
  entrypoint: "cli", sessionId: "7c3bb0ea", version: "2.1.270", ...extra,
});
const ASSISTANT = (at: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", timestamp: iso(at), message: { content: [{ type: "text", text: "on it" }] }, ...extra,
});
const SYSTEM = (subtype: string, at: number) => JSON.stringify({ type: "system", subtype, timestamp: iso(at) });

describe("the recap line in a transcript", () => {
  it("reads the sentence and the moment Claude Code wrote it", () => {
    expect(recapOf(RECAP(`${SAID} (disable recaps in /config)`))).toEqual({ text: SAID, at: T0 });
  });

  it("takes the terminal's opt-out hint off the end, and nothing else", () => {
    // It is on every recap, it is advice about the terminal, and on a 260px
    // card it is a tenth of the room.
    expect(cleanRecap("Done. (disable recaps in /config)")).toBe("Done.");
    // A recap that ends on a bracket of its own keeps it.
    expect(cleanRecap("Waiting on the review (two comments left)")).toBe("Waiting on the review (two comments left)");
    expect(cleanRecap("  one   sentence,\n  two lines  ")).toBe("one sentence, two lines");
    expect(cleanRecap(42)).toBe("");
  });

  it("bounds what a malformed line could put on a card, above Claude Code's own 400", () => {
    const long = cleanRecap("x".repeat(5000));
    expect(long.length).toBe(600);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanRecap("y".repeat(400))).toBe("y".repeat(400));
  });

  it("is nothing on a line that is not the main chain's, not a recap, or cannot be dated", () => {
    expect(recapOf(RECAP(SAID, T0, { isSidechain: true })), "a subagent's sidechain").toBeNull();
    // The mark in the CONTENT of some other line is not a recap line.
    expect(recapOf(JSON.stringify({ type: "system", subtype: "turn_duration", content: "away_summary" }))).toBeNull();
    expect(recapOf(RECAP(SAID, T0, { timestamp: "not a time" })), "no usable time").toBeNull();
    expect(recapOf(RECAP("   (disable recaps in /config)")), "nothing left to say").toBeNull();
    // The file is being appended to while it is read; a torn line is ordinary.
    expect(recapOf(RECAP(SAID).slice(0, 60))).toBeNull();
    expect(recapOf("")).toBeNull();
  });

  it("is found by the mark the watch's tap looks for, and ordinary lines are not", () => {
    expect(RECAP(SAID)).toContain(RECAP_MARK);
    expect(ASSISTANT(T0)).not.toContain(RECAP_MARK);
    expect(SYSTEM("turn_duration", T0)).not.toContain(RECAP_MARK);
  });
});

describe("when a recap stops being true: the transcript's half", () => {
  const fold = (...lines: string[]) => {
    const out: { recap: SessionRecap | null } = { recap: null };
    for (const line of lines) foldRecapLine(out, line);
    return out.recap;
  };

  it("stands from the moment it is written", () => {
    expect(fold(ASSISTANT(T0 - 4 * MIN), SYSTEM("turn_duration", T0 - 4 * MIN), RECAP(SAID)))
      .toEqual({ text: SAID, at: T0 });
  });

  it("is retired by the model's next turn", () => {
    expect(fold(RECAP(SAID), ASSISTANT(T0 + MIN))).toBeNull();
  });

  it("is not retired by a subagent's sidechain, or by the system lines around a turn", () => {
    expect(fold(RECAP(SAID), ASSISTANT(T0 + MIN, { isSidechain: true }))).toEqual({ text: SAID, at: T0 });
    expect(fold(RECAP(SAID), SYSTEM("stop_hook_summary", T0 + MIN), SYSTEM("turn_duration", T0 + MIN)))
      .toEqual({ text: SAID, at: T0 });
  });

  it("gives way to the next recap", () => {
    expect(fold(RECAP("first"), ASSISTANT(T0 + MIN), RECAP("second", T0 + 10 * MIN)))
      .toEqual({ text: "second", at: T0 + 10 * MIN });
  });
});

/** A file the test grows under the watch. Same shape as output-watch.test.ts. */
function fakeFs() {
  const files = new Map<string, Buffer>();
  return {
    append(path: string, text: string) {
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(text, "utf8")]));
    },
    io: {
      async stat(path: string) {
        const b = files.get(path);
        if (!b) throw new Error("ENOENT");
        return { size: b.length };
      },
      async open(path: string) {
        const b = files.get(path);
        if (!b) throw new Error("ENOENT");
        return {
          async read(buf: Buffer, off: number, len: number, pos: number) {
            const slice = b.subarray(pos, pos + len);
            slice.copy(buf, off);
            return { bytesRead: slice.length };
          },
          async close() {},
        };
      },
    },
  };
}

describe("the watch hands a resting session's tail to the recap", () => {
  // No hook fires when the recap lands — it is written into a silence — so the
  // watch that stats these files between events is the only reader looking.
  const PATH = "/claude/projects/x/s1.jsonl";

  async function watching() {
    const fs = fakeFs();
    fs.append(PATH, ASSISTANT(T0 - 4 * MIN) + "\n");
    const watch = createOutputWatch(fs.io);
    watch.note("s1", PATH);
    await watch.poll(["s1"]);            // first sight: the end of the file
    return { fs, watch };
  }

  it("with the session and the file the lines came from", async () => {
    const { fs, watch } = await watching();
    fs.append(PATH, RECAP(SAID) + "\n");
    const tails: Array<[string, string, string]> = [];
    const blocks = await watch.poll(["s1"], (sid: string, text: string, path: string) => tails.push([sid, text, path]));
    expect(tails).toHaveLength(1);
    expect(tails[0][0]).toBe("s1");
    expect(tails[0][2]).toBe(PATH);
    expect(tails[0][1]).toContain(RECAP_MARK);
    // A recap is not the model producing anything; the activity chart is not told.
    expect(blocks).toEqual([]);
  });

  it("only once a line is whole", async () => {
    const { fs, watch } = await watching();
    const line = RECAP(SAID);
    fs.append(PATH, line.slice(0, 80));
    const tails: string[] = [];
    const tap = (_sid: string, text: string) => { tails.push(text); };
    await watch.poll(["s1"], tap);
    expect(tails, "half a line was handed over").toEqual([]);
    fs.append(PATH, line.slice(80) + "\n");
    await watch.poll(["s1"], tap);
    expect(tails.map(t => t.trim())).toEqual([line]);
    expect(recapOf(tails[0])).toEqual({ text: SAID, at: T0 });
  });

  it("and a tap that throws costs the tick nothing", async () => {
    const { fs, watch } = await watching();
    fs.append(PATH, RECAP(SAID) + "\n" + ASSISTANT(T0 + MIN) + "\n");
    const blocks = await watch.poll(["s1"], () => { throw new Error("tap"); });
    expect(blocks).toEqual([{ sid: "s1", kind: "text", at: T0 + MIN }]);
  });
});

const SESSION = "sess-recap";
let seq = 0;
const at = (receivedAt: number, payload: HookPayload): HookEnvelope =>
  ({ seq: ++seq, receivedAt, source: "hook", payload });

/** A session that took a prompt at T0 - 10m and finished its turn at T0 - 4m. */
function resting() {
  let s = applyEvent(initialState(), at(T0 - 11 * MIN, {
    hook_event_name: "SessionStart", session_id: SESSION, cwd: "/repo/vcrm-core",
  }));
  s = applyEvent(s, at(T0 - 10 * MIN, {
    hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/repo/vcrm-core", prompt: "plan VCRM-8867",
  }));
  s = applyEvent(s, at(T0 - 4 * MIN, { hook_event_name: "Stop", session_id: SESSION, cwd: "/repo/vcrm-core" }));
  return s;
}
const recapped = (s: ReturnType<typeof resting>, recap: unknown, receivedAt = T0 + 2000) =>
  applyEvent(s, at(receivedAt, { hook_event_name: "SessionRecapped", session_id: SESSION, recap } as HookPayload));

describe("SessionRecapped on the client", () => {
  it("puts the recap on the session root", () => {
    const s = recapped(resting(), { text: SAID, at: T0 });
    expect(s.agents.get(SESSION)!.recap).toEqual({ text: SAID, at: T0 });
  });

  it("takes it off when the server says a later turn retired it", () => {
    const s = recapped(recapped(resting(), { text: SAID, at: T0 }), null, T0 + 5 * MIN);
    expect(s.agents.get(SESSION)!.recap).toBeUndefined();
  });

  it("changes nothing on a recap it cannot use", () => {
    const s0 = recapped(resting(), { text: SAID, at: T0 });
    for (const bad of [undefined, { text: "", at: T0 }, { text: "   ", at: T0 }, { text: SAID, at: Number.NaN }, { at: T0 }]) {
      const s = recapped(s0, bad, T0 + 3000);
      expect(s.agents.get(SESSION)!.recap, JSON.stringify(bad)).toEqual({ text: SAID, at: T0 });
    }
  });

  it("leaves the \"Your turn\" it explains standing", () => {
    // The recap is written BECAUSE nothing is moving, a couple of minutes after
    // the idle prompt went up. Treating it as movement would take the badge down
    // at the exact moment it acquires an explanation.
    let s = resting();
    s = applyEvent(s, at(T0 - 3 * MIN, {
      hook_event_name: "Notification", session_id: SESSION, cwd: "/repo/vcrm-core",
      notification_type: "idle_prompt", message: "Claude is waiting for your input",
    }));
    expect(s.agents.get(SESSION)!.waiting?.kind).toBe("idle");
    s = recapped(s, { text: SAID, at: T0 });
    expect(s.agents.get(SESSION)!.waiting?.kind).toBe("idle");
  });
});

describe("whether a recap still describes the session: the client's half", () => {
  const RECAP_AT = { text: SAID, at: T0 };
  const root = (over: Record<string, unknown> = {}) => ({
    kind: "root" as const, recap: RECAP_AT, prompts: [{ at: T0 - 10 * MIN, text: "plan" }],
    state: "done" as const, closedAt: undefined as number | undefined, ...over,
  });

  it("shows it on a session resting on the turn it summarises", () => {
    expect(recapShown(root())).toEqual(RECAP_AT);
    expect(recapShown(recapped(resting(), RECAP_AT).agents.get(SESSION)!)).toEqual(RECAP_AT);
  });

  it("drops it the moment a prompt is newer — before the server has seen the model answer", () => {
    // The prompt reaches the deck through its hook seconds before the model has
    // written a line, so the transcript's half of the rule cannot see it yet.
    expect(recapShown(root({ prompts: [{ at: T0 - 10 * MIN, text: "plan" }, { at: T0 + MIN, text: "go" }] }))).toBeNull();
    const s = applyEvent(recapped(resting(), RECAP_AT), at(T0 + MIN, {
      hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/repo/vcrm-core", prompt: "go",
    }));
    expect(recapShown(s.agents.get(SESSION)!)).toBeNull();
  });

  it("does not show it while a turn is running, on a closed session, or anywhere but the root", () => {
    expect(recapShown(root({ state: "active" }))).toBeNull();
    expect(recapShown(root({ closedAt: T0 + MIN }))).toBeNull();
    expect(recapShown(root({ kind: "subagent" }))).toBeNull();
    expect(recapShown(root({ recap: undefined }))).toBeNull();
  });
});

describe("where it is drawn", () => {
  it("the session list carries it on the row, and only while it is true", () => {
    const s = recapped(resting(), { text: SAID, at: T0 });
    expect(buildRows(s, T0 + MIN)[0].recap).toEqual({ text: SAID, at: T0 });
    const after = applyEvent(s, at(T0 + MIN, {
      hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/repo/vcrm-core", prompt: "go",
    }));
    expect(buildRows(after, T0 + 2 * MIN)[0].recap).toBeNull();
  });

  it("the card, the list and the detail panel all ask the one rule", () => {
    const card = read("../components/AgentNode.tsx");
    expect(card).toContain("const recap = recapShown(data);");
    expect(card).toMatch(/className="glyph-btn recap-pin"[\s\S]{0,300}aria-expanded=\{noteOpen\}/);
    // Open by itself; the pin says so while it is.
    expect(card).toContain("const noteOpen = recap != null && !noteDismissed;");
    // The note is a node of its own, built beside the root while the recap is
    // true and not put away, and tied to it by an edge from note to root.
    const appSrc = read("../App.tsx");
    expect(appSrc).toContain("const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode, recapNote: RecapNoteNode };");
    expect(appSrc).toContain('type: "recapNote",');
    expect(appSrc).toMatch(/source: noteId,\s*target: a\.id,\s*type: "recapTie",\s*className: "recap-edge",/);
    expect(appSrc).toContain("const edgeTypes = { recapTie: RecapTieEdge };");
    const noteSrc = read("../components/RecapNoteNode.tsx");
    expect(noteSrc).toContain('role="note"');
    expect(noteSrc).toContain('<Handle type="source" position={Position.Right}');
    // A note, not a dialog: appearing on its own, it must never take focus.
    expect(noteSrc).not.toContain("useModalDismiss");
    expect(read("../components/SessionList.tsx")).toContain("recap: recapShown(a),");
    expect(read("../components/SessionList.tsx")).toContain('<span className="sl-recap" title={r.recap.text}><RecapMark />');
    const app = read("../App.tsx");
    expect(app).toContain("const recap = recapShown(agent);");
    expect(app).toContain('<p className="detail-recap">{recap.text}</p>');
  });

  it("draws the terminal's ※ rather than typing it, so every platform gets the same figure", () => {
    // U+203B comes from whatever fallback font a platform has; the card and the
    // list share one authored mark instead.
    const card = read("../components/AgentNode.tsx");
    expect(card).toContain('<svg className="recap-glyph" viewBox="0 0 12 12"');
    expect(card).not.toContain("※</");
  });

  /** The body of the first rule whose selector list names `sel`. */
  function body(sel: string): string {
    const i = SHEET.indexOf(sel);
    expect(i, `${sel} is not in the sheet`).toBeGreaterThan(-1);
    return SHEET.slice(SHEET.indexOf("{", i) + 1, SHEET.indexOf("}", i));
  }

  it("draws the note like a card and its tie as a thread with beads", () => {
    // The pin is the card's only mark: a glyph button in the session's colour.
    expect(body("\n.agent-node .recap-pin {")).toMatch(/color: var\(--accent\);/);
    const note = body("\n.recap-note {");
    // Outside the card, so it rebuilds the card's --accent itself.
    expect(note).toMatch(/--accent: hsl\(var\(--session-hue, 200\) 70% var\(--session-accent-l\)\);/);
    // A card's depth, since it is a node like the cards.
    expect(note).toMatch(/box-shadow: var\(--shadow-1\);/);
    // Beads, not dashes: the canvas's dashed edges mean a call.
    const beads = body("\n.recap-tie-beads {");
    expect(beads).toMatch(/stroke-dasharray: 0 7;/);
    expect(beads).toMatch(/stroke-linecap: round;/);
    expect(body("\n.recap-tie {")).toMatch(/pointer-events: none;/);
    // A curve, fastened by a bead at each end.
    const tieSrc = read("../components/RecapTieEdge.tsx");
    expect(tieSrc).toContain("getBezierPath(");
    expect((tieSrc.match(/className="recap-tie-end"/g) ?? []).length).toBe(2);
  });

  it("gives the note every recap measured whole, and the list three lines of it", () => {
    expect(body("\n.recap-note-text {")).toMatch(/-webkit-line-clamp: 8;/);
    const list = body("\n.session-list .sl-recap {");
    expect(list).toMatch(/-webkit-line-clamp: 3;/);
    expect(list).toMatch(/color: var\(--text-secondary\);/);
    expect(body("\n.detail-recap {")).toMatch(/color: var\(--text-secondary\);/);
  });

  it("keeps the pin at every zoom tier, and grows the card by nothing", () => {
    expect(SHEET).not.toMatch(/data-lod="(compact|overview)"\][^{]*\.recap-pin/);
    expect(SHEET).not.toMatch(/\.agent-node \.recap-row/);
    // The note waits out both distances, where the card beside it is a face.
    const hidden = body('.canvas-wrap[data-lod="compact"] .recap-note-age');
    expect(hidden).toMatch(/visibility: hidden;/);
    expect(SHEET).toContain('.canvas-wrap[data-lod="overview"] .recap-note-text');
  });

  it("arrives without motion", () => {
    // It is written because nothing is moving; the card has not earned a pulse.
    for (const sel of ["\n.recap-note {", "\n.session-list .sl-recap {", "\n.detail-recap {"]) {
      expect(body(sel), sel).not.toMatch(/animation|transition/);
    }
  });
});

describe("the session header's name, at the zoom where the card already says it", () => {
  it("carries its separator inside the span, so the two leave together", () => {
    expect(read("../components/SessionClusters.tsx"))
      .toContain('{c.name ? <span className="cluster-label-name">{SEP + c.name}</span> : null}');
  });

  it("is hidden at the detail tier only", () => {
    expect(SHEET).toMatch(/\.canvas-wrap\[data-lod="detail"\] \.cluster-label-name \{\s*display: none;\s*\}/);
    expect(SHEET).not.toMatch(/\.canvas-wrap\[data-lod="(compact|overview)"\] \.cluster-label-name/);
  });
});

describe("a recap's note opens by itself and stays put away once closed", () => {
  const A = recapKey("s1", T0);

  it("is open until somebody puts it away", () => {
    expect(isRecapDismissed(A)).toBe(false);
    dismissRecap(A);
    expect(isRecapDismissed(A)).toBe(true);
  });

  it("comes back from the card's ※, and goes again", () => {
    toggleRecapDismissed(A);
    expect(isRecapDismissed(A)).toBe(false);
    toggleRecapDismissed(A);
    expect(isRecapDismissed(A)).toBe(true);
  });

  it("opens again for the session's next recap", () => {
    expect(isRecapDismissed(recapKey("s1", T0 + 10 * MIN))).toBe(false);
  });
});

describe("the note is a node the layout, the frame and the caches can see", () => {
  const NOTE = recapNoteId("s1");

  it("is laid out to the left of the root it is tied to, clear of it — what R does", () => {
    const nodes = [
      { id: "s1", type: "agent", position: { x: 0, y: 0 }, data: { sessionId: "s1" } },
      { id: NOTE, type: "recapNote", position: { x: 0, y: 0 }, data: { sessionId: "s1", parentId: "s1" } },
    ];
    const edges = [{ id: "e:recap:s1", source: NOTE, target: "s1" }];
    const measured = new Map([["s1", { width: 240, height: 130 }], [NOTE, { width: 300, height: 150 }]]);
    const out = autoLayout(nodes as never, edges as never, { measured });
    const root = out.find(n => n.id === "s1")!.position;
    const note = out.find(n => n.id === NOTE)!.position;
    expect(note.x + 300).toBeLessThan(root.x);
  });

  it("arrives beside its card: kept out of the new-session gap filler, placed after it", () => {
    // A pinned card is left out of dagre, and the gap filler took a lone note
    // for a new session's block; both put the note far from its card.
    const appSrc = read("../App.tsx");
    expect(appSrc).toContain('new Set(missing.filter(n => n.type !== "recapNote").map(n => n.id)), lanes,');
    expect(appSrc).toMatch(/fillGapsWithNewSessions\([\s\S]*?\);[\s\S]{0,1200}recordPlacement\(n\.id, \{ x: root\.x - RECAP_NOTE_GAP - nw/);
    // And a note that was closed forgets its laid-out spot unless it was dragged.
    expect(appSrc).toContain("if (isRecapNoteId(id) && !shownNotes.has(id) && !pinned.has(id)) {");
    expect(isRecapNoteId(recapNoteId("s1"))).toBe(true);
    expect(isRecapNoteId("s1")).toBe(false);
  });

  it("keeps its place, pin and size for as long as its root lives", () => {
    const live = liveNodeIds([{ id: "s1", kind: "root" }, { id: "s1::toolu_1", kind: "subagent" }]);
    expect(live.has(NOTE)).toBe(true);
    expect(live.has(recapNoteId("s1::toolu_1"))).toBe(false);
    expect(measuredNodeIds([{ id: "s1", sessionId: "s1", kind: "root" }]).has(NOTE)).toBe(true);
  });

  it("sits inside its session's frame, which traces what the session drag moves", () => {
    const [c] = clusterBounds([
      { type: "agent", position: { x: 460, y: 0 }, width: 240, height: 130, data: { sessionId: "s1", kind: "root", label: "vcrm-core" } },
      { type: "recapNote", position: { x: 0, y: 0 }, width: 300, height: 150, data: { sessionId: "s1", parentId: "s1" } },
    ] as never);
    expect(c.x).toBeLessThan(0);
    expect(c.label).toBe("vcrm-core");
  });
});
