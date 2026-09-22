// One colleague's Mac showed up twice on the Local network list: the same name
// over the same address, two rows nobody could tell apart. They were two decks
// on one computer, each with its own key. To somebody reading the list that is
// one machine, so it is drawn once — and the dialog behind the row still lists
// every deck folded into it, with a way to unpair the one that should not be
// there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deckRows, oneRowPerMachine, rowSource } from "../components/LanSyncSection";

const NOW = 1_700_000_000_000;
const code = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const SECTION = code("../components/LanSyncSection.tsx");
const MODAL = code("../components/LanPeerModal.tsx");
const CSS = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

const peer = (fp: string, over: Record<string, unknown> = {}) => ({
  fp, peerFp: fp, name: "Petrus-MacBook-Pro", paired: true,
  addr: "192.168.1.153", port: 57051, lastSeen: NOW, last: { at: NOW, done: [] }, ...over,
});

describe("two decks on one machine are one row", () => {
  it("folds decks with one name at one address, and keeps every one of them", () => {
    const rows = deckRows({
      peers: [peer("cdf-de5-f8c-263"), peer("759-496-6f5-809", { port: 55899 })] as never,
    }, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].twins?.map(t => t.fp)).toEqual(["759-496-6f5-809"]);
    // Folded, the name is unique again, so the row does not grow the address
    // it draws under names that collide.
    expect(rows[0].quiet).toBe(true);
  });

  it("puts the deck that is online in front", () => {
    const rows = deckRows({
      peers: [
        peer("aaa-aaa-aaa-aaa", { lastSeen: NOW - 3 * 3_600_000, last: { at: NOW - 3 * 3_600_000, done: [] } }),
        peer("bbb-bbb-bbb-bbb", { port: 55899 }),
      ] as never,
    }, NOW);
    expect(rows[0].fp).toBe("bbb-bbb-bbb-bbb");
    expect(rows[0].twins?.map(t => t.fp)).toEqual(["aaa-aaa-aaa-aaa"]);
  });

  it("leaves apart what a reader can tell apart", () => {
    // Two machines that share a name are told apart by address.
    const twoMachines = deckRows({
      peers: [peer("aaa-aaa-aaa-aaa"), peer("bbb-bbb-bbb-bbb", { addr: "192.168.1.154" })] as never,
    }, NOW);
    expect(twoMachines).toHaveLength(2);
    expect(twoMachines.every(r => !r.twins)).toBe(true);
    // One address under two names is a choice somebody made — an alias.
    const named = deckRows({
      peers: [peer("aaa-aaa-aaa-aaa"), peer("bbb-bbb-bbb-bbb", { port: 55899 })] as never,
      aliases: { "bbb-bbb-bbb-bbb": "Petru work deck" },
    }, NOW);
    expect(named).toHaveLength(2);
  });

  it("folds the keys a machine held before into it, which hold no address", () => {
    // Measured on the machine this came from: three paired keys for one Mac,
    // one live at an address and two that only ever called in and never will
    // again. One machine, one row, three decks in its dialog.
    const rows = deckRows({
      peers: [
        peer("759-496-6f5-809", { port: 55899 }),
        peer("585-eb2-55a-7e2", { addr: "", port: 0, waiting: true, lastSeen: undefined, last: undefined }),
        peer("cdf-de5-f8c-263", { addr: "", port: 0, waiting: true, lastSeen: undefined, last: undefined }),
      ] as never,
    }, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].fp).toBe("759-496-6f5-809");
    expect(rows[0].twins?.map(t => t.fp).sort()).toEqual(["585-eb2-55a-7e2", "cdf-de5-f8c-263"]);
    // Nothing collides any more, so no address is hung under the name.
    expect(rows[0].state).not.toContain("192.168.1.153");
  });

  it("keeps an addressless deck apart when its name is on two machines", () => {
    // Nothing says which of the two it belongs to.
    const row = (fp: string, addr: string) =>
      ({ fp, name: "MacBook-Pro", addr, kind: "paired" as const, state: "", tone: "idle" as const, here: false, hint: "" });
    const rows = oneRowPerMachine([row("a", "10.0.0.1"), row("b", "10.0.0.2"), row("c", "")]);
    expect(rows.map(r => r.fp)).toEqual(["a", "b", "c"]);
    // With no address anywhere under the name, it is one machine.
    expect(oneRowPerMachine([row("d", ""), row("e", "")])).toHaveLength(1);
  });

  it("finds the peer behind every folded deck, for its dialog", () => {
    const s = { peers: [peer("aaa-aaa-aaa-aaa"), peer("bbb-bbb-bbb-bbb", { port: 55899 })] } as never;
    const [row] = deckRows(s, NOW);
    for (const t of row.twins ?? []) expect(rowSource(s, t).peer?.fp).toBe(t.fp);
  });
});

describe("the dialog lists every deck at the address", () => {
  it("is handed the folded decks and a way to unpair each one", () => {
    expect(SECTION).toMatch(/twins=\{\(openRow\.twins \?\? \[\]\)\.map\(t => \(\{ row: t, peer: rowSource\(status, t\)\.peer \?\? null \}\)\)\}/);
    expect(SECTION).toMatch(/onUnpair=\{fp => answer\("unpair", fp, "unpair that deck"\)\}/);
    // And stays open when the machine's other deck takes the lead.
    expect(SECTION).toMatch(/r\.fp === peerOpen \|\| r\.twins\?\.some\(t => t\.fp === peerOpen\)/);
  });

  it("names the count and draws each deck's port and fingerprint", () => {
    expect(MODAL).toMatch(/\{instances\.length\} decks on this machine/);
    expect(MODAL).toMatch(/className="ap-lan-code lan-twin-at">\{at\}</);
    expect(MODAL).toMatch(/className="ap-lan-code lan-twin-fp">\{fpT\}</);
    // A key with nothing to dial says so, rather than drawing an empty cell.
    expect(MODAL).toMatch(/lan-twin-at lan-twin-none">no address here</);
  });

  it("unpairs a folded deck with the same two presses as everywhere else", () => {
    expect(MODAL).toMatch(/armedFor: armedTwin, target: fpT, armedAt: armedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    expect(MODAL).toMatch(/if \(press === "arm"\) \{ setArmedTwin\(fpT\); armedAt\.current = now; return; \}/);
    expect(MODAL).toMatch(/if \(press === "ignore"\) return;/);
    expect(MODAL).toMatch(/void run\(\(\) => onUnpair\(fpT\)\)/);
    // A held key is one decision, as it is on the dialog's own unpair.
    expect(MODAL).toMatch(/lan-twin-do[\s\S]{0,200}onKeyDown=\{e => \{ if \(e\.repeat\) e\.preventDefault\(\); \}\}/);
  });

  it("is styled, so the list is not a raw bulleted ul", () => {
    for (const sel of [".lan-twins", ".lan-twin", ".lan-twin-meta"]) {
      expect(CSS, sel).toMatch(new RegExp(`\\${sel}\\s*\\{`));
    }
  });
});
