// One failed read replaced a working table with "Could not read the process
// list on this platform" (#1770).
//
// Every failure inside the server's reader — `ps` past its four seconds,
// Get-Process past its six, a spawn that never started — resolves to an empty
// list, and the route wrapped that as `{ ok: true, procs: [] }`. The dialog
// stored any ok reply over the one it had and read an empty list as a platform
// that cannot answer, so a table that had been fine for a minute blanked for a
// poll, the header said "0 of 0 running", and on Windows — where one reading
// takes about as long as its deadline — it could flip poll after poll.
//
// Three halves, all run rather than read, except the one line of route wiring:
// the reply the route sends, the merge the dialog applies to it, and the body
// drawn from what the merge kept.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nextProcRead, ProcessListView, SORT_DEFAULT, type Proc } from "../components/ProcessListModal";
import type { LiveSource } from "../machine-live";
// @ts-expect-error — plain .mjs server module, no types
import { processesReply } from "../../server/process-list.mjs";

const p1: Proc = { pid: 4242, cpu: 97, mem: 3.1, name: "node", rssBytes: 1 << 30 };
const p2: Proc = { pid: 1, cpu: 0, mem: 0.1, name: "systemd", rssBytes: 12 << 20 };
const kept = { procs: [p1, p2], total: 300 };

/** A machine that publishes none of the band's readings, so the band under
 *  the list draws nothing and the markup is the list alone. */
const quiet: LiveSource = { cpu: null, perCore: null, memory: null, swap: null, loadavg: null, thermal: null };

const draw = (read: ReturnType<typeof nextProcRead>) =>
  renderToStaticMarkup(createElement(ProcessListView, { read, sort: SORT_DEFAULT, onSort: () => {}, sys: quiet, onClose: () => {} }));

describe("the route's answer to a read that failed", () => {
  it("says it failed, rather than ok with nothing in it", () => {
    // No machine has nothing running on it, so an empty reading is a failure
    // by construction — the server's own comment in readProcesses said so while
    // the reply beside it said ok.
    expect(processesReply({ procs: [], total: 0 })).toEqual({ ok: false, reason: "read_failed" });
  });

  it("is unchanged for a reading that has rows", () => {
    expect(processesReply({ procs: [p1], total: 300 })).toEqual({ ok: true, procs: [p1], total: 300 });
  });

  it("is what the route sends", () => {
    const route = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
    expect(route).toMatch(/readProcesses\(process\.platform, detail\)\.then\(r => send\(res, 200, processesReply\(r\)\)\)/);
  });
});

describe("the dialog's merge of a reply into what it holds", () => {
  it("keeps the table it has when a read comes back empty", () => {
    expect(nextProcRead(kept, { ok: true, procs: [], total: 0 })).toBe(kept);
  });

  it("keeps it when the route says the read failed", () => {
    expect(nextProcRead(kept, { ok: false, reason: "read_failed" })).toBe(kept);
  });

  it("takes an empty read when there has never been anything else to show", () => {
    expect(nextProcRead(null, { ok: true, procs: [], total: 0 })).toEqual({ procs: [], total: 0 });
    expect(nextProcRead(null, { ok: false, reason: "read_failed" })).toEqual({ procs: [], total: 0 });
  });

  it("replaces the table with a reading that has rows", () => {
    expect(nextProcRead(kept, { ok: true, procs: [p2], total: 299 })).toEqual({ procs: [p2], total: 299 });
  });
});

describe("the body drawn from what was kept", () => {
  it("still shows the table and its count after a failed read", () => {
    const html = draw(nextProcRead(kept, { ok: true, procs: [], total: 0 }));
    expect(html).toContain('<table class="sd-procs pl-table">');
    expect(html).toContain("2 of 300 running");
    expect(html).not.toContain("Could not read the process list");
  });

  it("does not blame the platform when no read has worked yet, and counts nothing", () => {
    const html = draw(nextProcRead(null, { ok: false, reason: "read_failed" }));
    expect(html).toContain("Could not read the process list");
    expect(html).not.toContain("on this platform");
    expect(html, "a count of a machine nobody could read").not.toContain("0 of 0 running");
  });
});
