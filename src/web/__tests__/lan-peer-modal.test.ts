// A deck's own dialog, and the row that opens it.
//
// The row keeps the look it had — the list is a glance, and nothing about the
// glance changed — and becomes a door: the whole row opens that machine's
// dialog, the verb on the end still does the verb, and the tooltip that used to
// carry the long sentence is gone because the dialog carries it now.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deckRows, offerLine, rowSource, versionOrder, withAliases } from "../components/LanSyncSection";

const NOW = 1_700_000_000_000;
/** A file with its comments taken out, so a rule cannot be satisfied by a
 *  paragraph that describes it. */
const code = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const SECTION = code("../components/LanSyncSection.tsx");
const MODAL = code("../components/LanPeerModal.tsx");
const CSS = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

const paired = (over: Record<string, unknown> = {}) => ({
  fp: "aaa-aaa-aaa-aaa", peerFp: "aaa-aaa-aaa-aaa", name: "Dorin Marketing", paired: true,
  addr: "192.168.1.44", port: 52011, lastSeen: NOW, last: { at: NOW, done: [] }, ...over,
});

describe("a name somebody here gave a deck", () => {
  it("is drawn in place of the one the deck chose, which is kept for the dialog", () => {
    const [row] = deckRows({ peers: [paired()] as never, aliases: { "aaa-aaa-aaa-aaa": "Dorin Office" } }, NOW);
    expect(row.name).toBe("Dorin Office");
    expect(row.self).toBe("Dorin Marketing");
  });

  it("adds nothing to a row with no alias, so that row is what it always was", () => {
    const [row] = deckRows({ peers: [paired()] as never }, NOW);
    expect(row.name).toBe("Dorin Marketing");
    expect(row).not.toHaveProperty("self");
    // An alias that says what the deck already calls itself is not an alias.
    const [same] = deckRows({ peers: [paired()] as never, aliases: { "aaa-aaa-aaa-aaa": "Dorin Marketing" } }, NOW);
    expect(same).not.toHaveProperty("self");
  });

  it("follows the fingerprint to every kind of row, and never to a typed address", () => {
    const rows = deckRows({
      pending: [{ fp: "bbb-bbb-bbb-bbb", name: "Asker", addr: "10.0.0.2", at: NOW }],
      strangers: [{ fp: "ccc-ccc-ccc-ccc", name: "Nearby", addr: "10.0.0.3", at: NOW }],
      declined: [{ fp: "ddd-ddd-ddd-ddd", name: "Refused", addr: "10.0.0.4", at: NOW }],
      peers: [{ fp: "manual:10.0.0.9:5000", name: "10.0.0.9", addr: "10.0.0.9", port: 5000, manual: true }] as never,
      aliases: {
        "bbb-bbb-bbb-bbb": "Office", "ccc-ccc-ccc-ccc": "Laptop", "ddd-ddd-ddd-ddd": "Old PC",
        "manual:10.0.0.9:5000": "Never",
      },
    }, NOW);
    expect(rows.map(r => [r.kind, r.name])).toEqual([
      ["asks", "Office"], ["dialling", "10.0.0.9:5000"], ["nearby", "Laptop"], ["declined", "Old PC"],
    ]);
    // The long sentence says the same name the row does.
    expect(rows[0].hint).toContain("Office");
  });

  it("sorts by the name that is drawn, since that is the one being scanned for", () => {
    const rows = deckRows({
      peers: [
        paired({ fp: "aaa-aaa-aaa-aaa", peerFp: "aaa-aaa-aaa-aaa", name: "Alpha" }),
        paired({ fp: "zzz-zzz-zzz-zzz", peerFp: "zzz-zzz-zzz-zzz", name: "Zulu" }),
      ] as never,
      aliases: { "zzz-zzz-zzz-zzz": "Accounting" },
    }, NOW);
    expect(rows.map(r => r.name)).toEqual(["Accounting", "Alpha"]);
  });

  it("is the name the request dialog over the canvas says too", () => {
    expect(withAliases([{ fp: "a", name: "X" }, { fp: "b", name: "Y" }], { a: "Office" }))
      .toEqual([{ fp: "a", name: "Office" }, { fp: "b", name: "Y" }]);
    const list = [{ fp: "a", name: "X" }];
    expect(withAliases(list, undefined)).toBe(list);
  });
});

describe("the row behind the dialog", () => {
  it("finds the peer or the stranger each row was built from", () => {
    const s = {
      peers: [paired(), { fp: "manual:10.0.0.9:5000", name: "10.0.0.9", addr: "10.0.0.9", port: 5000, manual: true }],
      strangers: [{ fp: "ccc-ccc-ccc-ccc", name: "Nearby", addr: "10.0.0.3", at: NOW }],
      declined: [{ fp: "ddd-ddd-ddd-ddd", name: "Refused", addr: "10.0.0.4", at: NOW }],
      pending: [],
    } as never;
    const rows = deckRows(s, NOW);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const src = rowSource(s, r);
      expect(src.peer ?? src.stranger, r.kind).toBeTruthy();
    }
    expect(rowSource(null, rows[0])).toEqual({});
  });
});

describe("a version read against this deck's", () => {
  it("orders by the three numbers, as numbers", () => {
    expect(versionOrder("3.21.0", "3.21.0")).toBe(0);
    expect(versionOrder("3.20.9", "3.21.0")).toBe(-1);
    expect(versionOrder("3.21.1", "3.21.0")).toBe(1);
    // Lexically "3.9" is after "3.21". It is not.
    expect(versionOrder("3.9.0", "3.21.0")).toBe(-1);
    expect(versionOrder("10.0.0", "9.9.9")).toBe(1);
  });

  it("does not guess about something that is not a version", () => {
    expect(versionOrder("dev", "3.21.0")).toBeNull();
    expect(versionOrder("3.21", "3.21.0")).toBeNull();
  });
});

describe("what one offered login would do here", () => {
  const theirs = (alive: boolean) => ({ key: "a@x@@o", email: "a@x", alive });
  const mine = (alive: boolean) => ({ key: "a@x@@o", email: "a@x", alive });

  it("says a login this deck lacks arrives, whatever this deck shares", () => {
    expect(offerLine(theirs(true), null, false)).toEqual({ text: "works there · arrives here next round", tone: "wait" });
  });

  it("repairs an expired one only when this deck shares it too, and says the fix when not", () => {
    expect(offerLine(theirs(true), mine(false), true).tone).toBe("wait");
    const unshared = offerLine(theirs(true), mine(false), false);
    expect(unshared.tone).toBe("bad");
    expect(unshared.text).toContain("share it to repair");
  });

  it("moves nothing from a copy that is broken there", () => {
    expect(offerLine(theirs(false), mine(true), true)).toEqual({ text: "broken there · works here", tone: "idle" });
    expect(offerLine(theirs(false), mine(false), true).tone).toBe("bad");
    expect(offerLine(theirs(false), null, true).tone).toBe("idle");
  });

  it("is plain about the steady state", () => {
    expect(offerLine(theirs(true), mine(true), true)).toEqual({ text: "works there · works here", tone: "ok" });
  });
});

describe("the row is the door", () => {
  it("opens the deck's dialog from a button that is the name, and carries no tooltip", () => {
    expect(SECTION).toMatch(/className="ap-lan-who-open"/);
    expect(SECTION).toMatch(/<LanPeerModal/);
    // The sentence the tooltip carried is in the dialog now. On the row it was
    // the same words a second late, over the rows below it.
    expect(SECTION).not.toMatch(/className="ap-lan-who"[^>]*title=/);
  });

  it("keeps the verb a verb: it sits above the row's stretched hit area", () => {
    expect(CSS).toMatch(/\.ap-lan-who > \.ap-manage-btn \{ position: relative; z-index: 1; \}/);
    // Laid over the row on the bed's own box, so the keyboard's ring is the
    // row's shape rather than a ring round one word of it.
    expect(CSS).toMatch(/\.ap-lan-who-open \{[^}]*position: absolute;\s*inset: -3px -4px;/);
    expect(SECTION).toMatch(/<span className="ap-lan-who-name" aria-hidden>\{p\.name\}<\/span>/);
  });

  it("answers the pointer and the keyboard with the bed the panel's other rows use", () => {
    expect(CSS).toMatch(
      /\.ap-lan-who:hover::before,\s*\.ap-lan-who:has\(\.ap-lan-who-open:focus-visible\)::before \{\s*background: color-mix\(in srgb, var\(--text\) 6%, transparent\);/,
    );
  });

  it("does in the dialog exactly what the row's verb does, under the same busy tag", () => {
    for (const tag of ["unpair:", "accept:", "drop:", "allow:", "check:", "alias:"]) {
      expect(MODAL, tag).toContain(`press(\`${tag}`);
    }
  });

  it("asks twice before it unpairs, as the row does", () => {
    expect(MODAL).toMatch(/if \(!armed\) \{ setArmed\(true\); return; \}/);
  });
});
