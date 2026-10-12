import { describe, expect, it } from "vitest";
import { secondStart, sameShape } from "../../server/running-deck.mjs";
import { writesCodexLog } from "../../server/log-election.mjs";

const base = { pid: 100, port: 4318, version: "3.39.0", workspace: "", persist: "/log/events.jsonl", claude: true, codex: true, codexHome: "/profiles/a" };

describe("monitored Codex home sets", () => {
  it("replaces a deck when adding or removing an alternate home", () => {
    for (const [before, after] of [[['/profiles/a'], ['/profiles/a', '/profiles/b']], [['/profiles/a', '/profiles/b'], ['/profiles/a']]]) {
      const record = { ...base, codexHomes: before };
      expect(secondStart({ live: [record], want: { ...base, codexHomes: after }, ours: base.version }).act).toBe("replace");
    }
  });
  it("treats the roster as a set and detects new roots in a legacy single-home record", () => {
    expect(sameShape({ ...base, codexHomes: ['/profiles/a', '/profiles/b'] }, { ...base, codexHomes: ['/profiles/b', '/profiles/a'] })).toBe(true);
    expect(sameShape(base, { ...base, codexHomes: ['/profiles/a'] })).toBe(true);
    expect(sameShape(base, { ...base, codexHomes: ['/profiles/a', '/profiles/b'] })).toBe(false);
  });
  it("does not defer to an unknown legacy primary home", () => {
    const modern = { ...base, codexHomes: ['/profiles/a', '/profiles/b'] };
    const legacy = { ...base, pid: 200, port: 4319, codexHome: undefined };
    const decks = [modern, legacy];
    expect(writesCodexLog({ decks, pid: modern.pid, cwd: '/work', codexHome: '/profiles/b', platform: 'linux' })).toBe(true);
    expect(writesCodexLog({ decks, pid: legacy.pid, cwd: '/work', platform: 'linux' })).toBe(false);
  });
  it("lets a legacy primary-home writer own its tree even at a higher port", () => {
    const modern = { ...base, codexHomes: ['/profiles/a', '/profiles/b'] };
    const legacy = { ...base, pid: 200, port: 4319, codexHome: '/profiles/b' };
    const decks = [modern, legacy];
    expect(writesCodexLog({ decks, pid: modern.pid, cwd: '/work', codexHome: '/profiles/b', platform: 'linux' })).toBe(false);
    expect(writesCodexLog({ decks, pid: legacy.pid, cwd: '/work', platform: 'linux' })).toBe(true);
    expect(writesCodexLog({ decks: [modern, { ...legacy, persist: null }], pid: modern.pid, cwd: '/work', codexHome: '/profiles/b', platform: 'linux' })).toBe(true);
    expect(writesCodexLog({ decks: [modern], pid: modern.pid, cwd: '/work', codexHome: '/profiles/b', platform: 'linux' })).toBe(true);
    expect(writesCodexLog({ decks: [modern, { ...legacy, persist: '/other/events.jsonl' }], pid: modern.pid, cwd: '/work', codexHome: '/profiles/b', platform: 'linux' })).toBe(true);
  });
});
