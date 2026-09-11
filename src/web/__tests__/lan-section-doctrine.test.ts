// The accounts panel spent a year learning three rules, and the LAN section
// shipped without any of them.
//
// A critique of the whole surface found the same shape three times: the panel
// commits on a press and never on a blur, reports every failure in a box a
// reader can see, and makes an act you cannot undo cost a second deliberate
// press — and `LanSyncSection.tsx` saved two fields on blur, checked `ok` with
// no `else` anywhere, and offered a live login to the network on one unguarded
// click. These are the rules, pinned where a regression trips rather than where
// somebody has to notice it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  askedLabel, checkedLabel, deckRows, faultText, isOnline, leftLabel, parseAddress, roundLabel,
  rosterSplit, sameKeys, sectionState, writeFailure, ONLINE_MS,
} from "../components/LanSyncSection";

const SRC = readFileSync(
  fileURLToPath(new URL("../components/LanSyncSection.tsx", import.meta.url)),
  "utf8",
);
const SERVER = readFileSync(
  fileURLToPath(new URL("../../server/index.mjs", import.meta.url)),
  "utf8",
);
const SERVER_ENGINE = readFileSync(
  fileURLToPath(new URL("../../server/lan-engine.mjs", import.meta.url)),
  "utf8",
);
const MODAL = readFileSync(
  fileURLToPath(new URL("../components/LanSetupModal.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
/** The dialog behind `+ add a deck`, which is the other half of "who this deck
 *  talks to" — the half that takes an address or a token rather than naming a
 *  machine already on the list. */
const ADD = readFileSync(
  fileURLToPath(new URL("../components/LanAddDeckModal.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
/** The file with its comments taken out, so a rule cannot be satisfied by a
 *  paragraph that describes it. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const NOW = 1_700_000_000_000;

describe("a round says which of the three things it was", () => {
  it("marks a deck it could not reach, so the one row worth reading is the one that reads differently", () => {
    // The whole point. The sentence was already honest; it was drawn in the
    // dimmest ink the panel has, identical to `all logins fine` on the row
    // above, and in Operate mode the only thing anybody scans a list like this
    // for is which row is wrong.
    //
    // A sentence this file has never seen passes through whole rather than
    // being replaced by a guess: lan-socket.mjs is free to add one, and a map
    // that swallowed the unknown would report a fault it cannot name.
    expect(roundLabel({ at: NOW, error: "handshake refused" }, NOW))
      .toEqual({ text: "handshake refused", tone: "bad" });
  });

  it("says the faults it does know in words somebody can act on", () => {
    // `could not reach it — handshake timed out` was two clauses, an em dash
    // and a protocol noun in a 190px row: it wrapped, and the wrap is what
    // pushed the machine's own name off its own row. The prefix is said by the
    // row now — red mark, sentence under the name — so what is left is what
    // happened.
    expect(roundLabel({ at: NOW, error: "handshake timed out" }, NOW))
      .toEqual({ text: "no answer", tone: "bad" });
    expect(roundLabel({ at: NOW, error: "peer closed the connection" }, NOW))
      .toEqual({ text: "it hung up", tone: "bad" });
    for (const said of ["no answer", "it hung up", "it stopped mid-sentence"]) {
      expect(said.length, said).toBeLessThan(26);
    }
  });

  it("says a connect error as a thing that happened, and hovers the rest", () => {
    // `connect ECONNREFUSED 192.168.1.229:65059` drew three wrapped lines in a
    // 190px column — a code, an address and a port belonging to a machine whose
    // name is the first line of the same row. Reported from a screenshot.
    expect(roundLabel({ at: NOW, error: "connect ECONNREFUSED 192.168.1.229:65059" }, NOW))
      .toEqual({ text: "not listening", tone: "bad" });
    expect(faultText("connect EHOSTUNREACH 10.0.0.4:5000")).toBe("no route to it");
    expect(faultText("read ECONNRESET")).toBe("it hung up");
    // Anything neither this file nor Node has a code for arrives whole: a
    // message nobody has seen is more useful than a guess about it.
    expect(faultText("the moon is in the way")).toBe("the moon is in the way");
    // And every short form is short enough to sit beside a presence clause in
    // one line of a 190px row.
    for (const said of ["not listening", "no route to it", "no answer", "it hung up"]) {
      expect(`${said} · last online 20m ago`.length, said).toBeLessThan(38);
    }
    // The address and the code are not lost — they are on the row's hover.
    const [row] = deckRows({
      peers: [{
        fp: "a", peerFp: "a", name: "Deniss", paired: true, addr: "192.168.1.229", port: 65059,
        lastSeen: NOW - 5 * 60_000, last: { at: NOW, error: "connect ECONNREFUSED 192.168.1.229:65059" },
      }] as never,
    }, NOW);
    expect(row.state).toBe("not listening · last online 5m ago");
    expect(row.hint).toContain("connect ECONNREFUSED 192.168.1.229:65059");
  });

  it("keeps the two refusals that are answers out of the fault vocabulary", () => {
    // Both arrive as `last.error`, on the same channel as a dead socket, and
    // drawn in that vocabulary they would read as breakage. One is a person who
    // has not answered yet and the other is a person who has.
    expect(roundLabel({ at: NOW, error: "waiting for the other deck to accept this one" }, NOW))
      .toEqual({ text: "waiting for them to say yes", tone: "idle" });
    expect(roundLabel({ at: NOW, error: "that deck said no" }, NOW))
      .toEqual({ text: "it said no", tone: "bad" });
  });

  it("calls a round that moved nothing idle rather than wrong", () => {
    // Two decks whose accounts all agree is the STEADY STATE of this feature,
    // not a fault. Painting it like one would make the list permanently red.
    // And it says which of the two "nothing happened" cases it is: `nothing to
    // do` could be read as "nothing is shared, so there was nothing to send",
    // which is a setup mistake rather than the steady state.
    expect(roundLabel({ at: NOW, done: [] }, NOW))
      .toEqual({ text: "all logins fine · now", tone: "idle" });
  });

  it("calls a clean round ok, and counts in the singular when it is one", () => {
    // "arrived", because a round only ever pulls — roundWith dials, reads the
    // far manifest and imports. `took 1 account` left the direction to the
    // reader in the one feature where direction is the whole confusion.
    expect(roundLabel({ at: NOW, done: [{ email: "a@b.c", action: "heal", ok: true }] }, NOW))
      .toEqual({ text: "1 login arrived · now", tone: "ok" });
    expect(roundLabel({
      at: NOW,
      done: [
        { email: "a@b.c", action: "heal", ok: true },
        { email: "d@e.f", action: "add", ok: true },
      ],
    }, NOW)).toEqual({ text: "2 logins arrived · now", tone: "ok" });
  });

  it("marks a partial round, because some of it failed and nothing else says so", () => {
    // Reached the deck, so it is not an error; did not do what it set out to
    // do, so it is not ok either. The tone follows the failure, not the reach.
    expect(roundLabel({
      at: NOW,
      done: [
        { email: "a@b.c", action: "heal", ok: true },
        { email: "d@e.f", action: "add", ok: false },
      ],
    }, NOW)).toEqual({ text: "1 of 2 logins arrived · now", tone: "bad" });
  });

  it("says nothing at all about a deck it has not had a round with yet", () => {
    expect(roundLabel(null, NOW)).toBeNull();
    expect(roundLabel(undefined, NOW)).toBeNull();
  });
});

describe("a write that did not happen says so", () => {
  it("tells a deck that refused apart from a deck that is gone", () => {
    // The two fail for completely different causes and lead to completely
    // different next moves, and both were the same silence.
    expect(writeFailure("save the passphrase", null))
      .toBe("Could not save the passphrase — the deck did not answer.");
    expect(writeFailure("save the passphrase", { ok: false, reason: "bad_request" }))
      .toBe("Could not save the passphrase — the deck refused it (bad_request).");
    expect(writeFailure("save the passphrase", { ok: false }))
      .toBe("Could not save the passphrase.");
  });

  it("names what the user was doing, never the route it used", () => {
    // `/api/prefs failed` is true and answers nothing. The verb is the content.
    for (const what of ["share that account", "add that address", "turn this on"]) {
      expect(writeFailure(what, null)).toContain(what);
    }
    expect(writeFailure("share that account", null)).not.toMatch(/api|prefs|POST|\b\d{3}\b/);
  });
});

describe("what we last sent, against what the server says", () => {
  it("ignores order, because the panel sends a Set and the server stores what it is sent", () => {
    expect(sameKeys(["a@@1", "b@@2"], ["b@@2", "a@@1"])).toBe(true);
  });

  it("refuses two lists that are not the same members", () => {
    expect(sameKeys(["a@@1"], ["a@@1", "b@@2"])).toBe(false);
    expect(sameKeys(["a@@1", "b@@2"], ["a@@1", "c@@3"])).toBe(false);
    // Same length, and one of them is a repeat rather than a second member.
    expect(sameKeys(["a@@1", "a@@1"], ["a@@1", "b@@2"])).toBe(false);
  });

  it("holds for the empty case, which is the state the section starts in", () => {
    expect(sameKeys([], [])).toBe(true);
  });
});

describe("the three rules the panel above it already keeps", () => {
  it("commits on a press and never on a blur", () => {
    // `appear as` saved on blur, and `by address` parsed on blur and threw the
    // text away when the parse failed — a typo produced an empty box, no peer,
    // and no statement that anything had gone wrong. picker-commit.ts spends
    // three paragraphs on why nothing in this panel may act on an event the
    // user did not aim at.
    expect(CODE).not.toMatch(/onBlur/);
  });

  it("has a failure box, announced and dismissible, like the panel's own", () => {
    expect(CODE).toMatch(/className="ap-failure"/);
    expect(CODE).toMatch(/role="alert"/);
    expect(CODE).toMatch(/className="ap-failure-x"/);
  });

  it("reports every write that did not land, in both ways it can fail", () => {
    // The `else` that was missing, and the `catch` that was missing. Counted
    // rather than merely present: a single setFailure would satisfy a `toMatch`
    // and leave the other path silent.
    expect([...CODE.matchAll(/setFailure\(writeFailure\(/g)].length).toBeGreaterThanOrEqual(4);
    // Two in the dialog, and that is every path it has left: one `write`, its
    // `else` and its `catch`. The dialog shrank to two fields when the pairing
    // moved into the panel — the rule is unchanged, the surface is smaller.
    expect([...MODAL.matchAll(/setFailure\(writeFailure\(/g)].length).toBeGreaterThanOrEqual(2);
    expect(CODE).toMatch(/catch\s*\{[\s\S]{0,400}?setFailure/);
  });

  it("gives every write the verb its failure will be reported with", () => {
    // save(patch) with no second argument is a write whose failure has no
    // sentence. Every call site passes one.
    expect(MODAL).not.toMatch(/\bwrite\(\s*\{[^{}]*\}\s*\)/);
    expect([...MODAL.matchAll(/\bwrite\(\s*\{[\s\S]*?\}\s*,/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("splits the surface by SUBJECT: who this deck talks to, and what it is", () => {
    // The first cut of this rule sent every decision into the dialog, and it
    // cut in the wrong place. What came back from use was that the two things
    // somebody does daily — see who is there, answer somebody asking — were the
    // two things furthest away: three panels, a button and a scroll. Reported
    // as "it is too complicated, I should just see who wants to connect and
    // press yes or no".
    //
    // So the line is not decision-versus-reading any more. WHO THIS DECK TALKS
    // TO is a list, and every verb that changes a row on it belongs beside that
    // row: pairing, declining, unpairing, and the two ways of reaching a deck
    // the network could not offer. WHAT THIS DECK IS — its name, the logins it
    // offers — is what is left in the dialog.
    expect(CODE).toMatch(/LanSetupModal/);
    for (const field of [
      `aria-label="This deck's name on the network"`,
      'type="checkbox"',
    ]) {
      expect(CODE, field).not.toContain(field);
      expect(MODAL, field).toContain(field);
    }
    // And the other way round for everything that names another machine. The
    // two fields moved once more, out of the panel's own drawer and into a
    // dialog of their own: an address is monospace, an invite is 140
    // characters, and unfolded in a 288px column they turned a list of machines
    // into a form with a list on top of it. What stays in the panel is the word
    // that opens them.
    for (const field of [
      `aria-label="Another deck's address"`,
      `aria-label="An invite you were sent"`,
    ]) {
      expect(MODAL, field).not.toContain(field);
      expect(CODE, field).not.toContain(field);
      expect(ADD, field).toContain(field);
    }
    // The word became the glyph the accounts header two sections up has always
    // used for the same act; what is pinned is that the section still OWNS it.
    expect(CODE).toMatch(/aria-label="Add a deck"/);
    expect(CODE).toMatch(/role="switch"/);
    expect(CODE).toMatch(/wants to pair/);
  });

  it("builds the next share list from what it last sent, not from the last render", () => {
    // The race: `status.shared` only changes after a write has landed AND the
    // poll after it has returned, so a second tick inside that window rebuilt
    // its Set from before the first one and silently dropped an account.
    expect(MODAL).toMatch(/new Set\(pending\.current \?\? status\.shared \?\? \[\]\)/);
    expect(MODAL).toMatch(/pending\.current = \[\.\.\.next\]/);
    // And retires the optimistic copy once the server agrees with it, or the
    // boxes would keep showing what was sent even after the deck refused it.
    expect(MODAL).toMatch(/sameKeys\(pending\.current, status\.shared \?\? \[\]\)/);
  });

  it("says which state a press is in with a word, because aria-busy paints nothing", () => {
    // `check now` looked identical pressed and unpressed: selfPressProps sets
    // aria-busy, and aria-busy has no rule anywhere in the stylesheet.
    // Each one lives with the control it is about, and says which state it is
    // in with a WORD rather than only with `aria-busy`, which paints nothing.
    // The round is a glyph beside the switch now, so its word is in the
    // accessible name and in the line under the title.
    expect(CODE).toMatch(/aria-label=\{busy === "check" \? "Checking every paired deck"/);
    // The word moved into `checkedLabel`, which is the same slot: the line
    // under the title says `checking…` while the round is out and what it found
    // when it lands.
    expect(CODE).toMatch(/checkedLabel\(status\?\.checkedAt, now, busy === "check"\)/);
    expect(checkedLabel(NOW, NOW, true)).toBe("checking…");
    expect(ADD).toMatch(/"joining…"\s*:\s*"join"/);
  });
});

describe("who pairs with whom, without anybody pressing anything", () => {
  it("keeps both switches in the dialog that says what this deck is", () => {
    // They belong with the name and the share list, not on the roster: all
    // three are what this deck IS on the network, and the roster is who else
    // is out there. The dialog opens on every switch-on for exactly that
    // reason — see the block above.
    expect(MODAL).toMatch(/aria-label="Ask every deck this one finds"/);
    expect(MODAL).toMatch(/aria-label="Say yes to every deck that asks"/);
    expect(MODAL).toMatch(/autoAsk: !asks/);
    expect(MODAL).toMatch(/autoAccept: !says/);
    expect(CODE).not.toContain("autoAccept: !");
    // Last, after the list it is a permission over, so the warning under it
    // points at rows the reader has just looked at.
    expect(MODAL.indexOf('type="checkbox"')).toBeLessThan(MODAL.indexOf("Pairing"));
  });

  it("reads a missing answer as on, because that is what the engine is doing", () => {
    // A deck that has not written prefs since this shipped is a deck running
    // the defaults. Drawing `off` there would be the dialog contradicting the
    // machine it is a dialog about.
    expect(MODAL).toMatch(/status\.autoAsk !== false/);
    expect(MODAL).toMatch(/status\.autoAccept !== false/);
    expect(SERVER).toMatch(/autoAsk: lan\.autoAsk !== false/);
    expect(SERVER).toMatch(/autoAccept: lan\.autoAccept !== false/);
  });

  it("says nothing in the state it ships in, and says what a switch turned off costs", () => {
    // The two labels describe the two switches in full, so a paragraph under
    // them repeating it is a paragraph nobody reads twice — the same rule the
    // roster is built on. What earns a line is a switch somebody has turned
    // OFF, because the deck is then behaving differently from its default and
    // that difference is what a reader opened this to check.
    expect(MODAL).toMatch(/\{says \? null : asks \? \(\s*<p className="lan-note">/);
    // No yellow anywhere in this dialog now. It had two paragraphs of it, both
    // under controls whose own labels said the same thing, and a surface that
    // shouts about its resting state is a surface people stop reading.
    expect(MODAL).not.toContain("lan-warn");
    // The note that IS drawn never claims the incoming half still waits for
    // somebody, which would be a lie the moment the second switch is on.
    const note = /\{says \? null : asks \? \(\s*<p className="lan-note">([\s\S]*?)<\/p>/.exec(MODAL)?.[1] ?? "";
    expect(note).toMatch(/still has to say yes/);
  });

  it("never lets the switch undo a no", () => {
    // A refusal is a decision about a machine. lan-socket refuses a declined
    // deck before the engine is told anything, so the automatic yes is never
    // reached for one — and the automatic ask skips it too.
    expect(SERVER_ENGINE).toMatch(/cfg\.autoAsk && !had && !declined\.has\(entry\.fp\)/);
    expect(readFileSync(
      fileURLToPath(new URL("../../server/lan-socket.mjs", import.meta.url)), "utf8",
    )).toMatch(/if \(declined\(peerFp\)\) return refuse\("declined"\)/);
  });
});

describe("the list is quiet until it is not", () => {
  const CSS = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
  /** The body of the first rule with this exact selector, comments stripped. */
  function rule(selector: string): string {
    const at = CSS.indexOf(selector + " {");
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return CSS.slice(at, CSS.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, " ");
  }
  const peer = (over: Record<string, unknown>) => ({
    fp: "aa", peerFp: "aa", name: "Deck", addr: "10.0.0.2", port: 5, paired: true,
    lastSeen: NOW - 1_000, ...over,
  });

  it("says nothing under a deck that is on with nothing to repair", () => {
    // THE DEFECT. Every healthy row carried `online · all logins fine` — the
    // same twenty-four characters under every name, in a list whose whole job
    // is to make the odd row findable. Two of them and the eye has nothing to
    // catch on; five and the section is a wall.
    const [row] = deckRows({ peers: [peer({ last: { at: NOW - 1_000, done: [] } })] }, NOW);
    expect(row.quiet).toBe(true);
    // The sentence is still THERE. It is what a screen reader is read, which is
    // the whole reason the row does not simply drop it — see `.vis-hidden`.
    expect(row.state).toBe("online · all logins fine");
    expect(row.here).toBe(true);
  });

  it("still says everything that is not the steady state", () => {
    // A round that MOVED something is news, a fault is news, and a machine that
    // is not there is the row somebody is looking for. None of them go quiet.
    const moved = deckRows({ peers: [peer({
      last: { at: NOW - 1_000, done: [{ email: "a@b", action: "sent", ok: true }] },
    })] }, NOW)[0];
    expect(moved.quiet).toBe(false);
    expect(moved.state).toMatch(/1 login arrived/);

    const broken = deckRows({ peers: [peer({ last: { at: NOW - 1_000, error: "ECONNREFUSED" } })] }, NOW)[0];
    expect(broken.quiet).toBe(false);
    expect(broken.tone).toBe("bad");

    const away = deckRows({ peers: [peer({ lastSeen: NOW - 3_600_000, last: null })] }, NOW)[0];
    expect(away.quiet).toBe(false);
    expect(away.state).toMatch(/last online/);

    // And a deck this one holds no address for keeps its sentence even while it
    // is answering: `one-way` is the half a green dot cannot say.
    const oneWay = deckRows({ peers: [peer({ waiting: true, last: null })] }, NOW)[0];
    expect(oneWay.quiet).toBe(false);
    expect(oneWay.state).toMatch(/one-way/);
  });

  it("draws the address under two machines that share a name, and under no others", () => {
    // The name is a string somebody typed. Two colleagues who never renamed
    // their deck have the same one, and two identical rows are two rows a
    // reader cannot tell apart — while giving EVERY row an address would pay
    // for a collision that usually is not there.
    const twins = deckRows({ peers: [
      peer({ fp: "a", peerFp: "a", addr: "10.0.0.2", last: { at: NOW, done: [] } }),
      peer({ fp: "b", peerFp: "b", addr: "10.0.0.3", last: { at: NOW, done: [] } }),
    ] }, NOW);
    expect(twins.map(r => r.quiet)).toEqual([false, false]);
    expect(twins[0].state).toMatch(/^10\.0\.0\.2/);
    expect(twins[1].state).toMatch(/^10\.0\.0\.3/);
    const alone = deckRows({ peers: [peer({ last: { at: NOW, done: [] } })] }, NOW);
    expect(alone[0].state).not.toMatch(/10\.0\.0\.2/);
  });

  it("keeps the sentence in the accessibility tree when it takes it off the screen", () => {
    // `.vis-hidden` is the class this app already has for exactly this: a state
    // word the dot beside it cannot say, kept for anybody being read the list.
    // Dropping the node instead would have made the colour of a 5px dot the
    // only evidence that a deck is fine.
    expect(CODE).toMatch(/p\.quiet \? "vis-hidden" : "ap-lan-who-when"/);
    expect(CSS).toContain(".vis-hidden");
  });

  it("keeps unpair off the row until the row is pointed at", () => {
    // Unpairing is done about twice in a deck's life and cannot be undone from
    // this section, and it drew on every paired row at once — a column of
    // identical destructive verbs down the right edge of the thing a reader
    // scans for a machine's name. The panel's own account rows already put
    // `remove` two presses inside the manage block.
    // Every rule with that selector, because the reduced-motion block declares
    // one too and it comes first in the sheet.
    const danger = [...CSS.matchAll(/\.ap-lan-who \.ap-lan-do\.danger \{([^}]*)\}/g)].map(m => m[1]);
    expect(danger.some(b => /opacity:\s*0\b/.test(b))).toBe(true);
    const shown = CSS.slice(CSS.indexOf(".ap-lan-who:hover .ap-lan-do.danger"));
    // KEYBOARD focus, and only that. `:focus-within` held it up after a mouse
    // closed the deck's dialog and focus came back to the row — a destructive
    // verb left showing on a row nobody was pointing at, with no ring to say
    // why.
    expect(shown.slice(0, 200)).toMatch(/:has\(:focus-visible\)/);
    expect(shown.slice(0, 200)).toMatch(/\.armed/);
    // Its WIDTH is never given up, or the name's column would resize under the
    // cursor and every row would jump as the pointer crossed it.
    expect(danger.some(b => /display:\s*none/.test(b))).toBe(false);
    // And the three verbs that are the REASON their row is on the list stay
    // where they are: a deck nearby exists to be asked.
    for (const verb of ["ask", "allow", "stop"]) {
      expect(CODE, verb).toMatch(new RegExp(`>\\s*${verb}\\s*</button>`));
    }
    expect(CSS).not.toMatch(/\.ap-lan-who \.ap-lan-do \{[^}]*opacity:\s*0/);
  });

  it("spends its space on the boundaries between groups, not inside them", () => {
    // Five gaps within two pixels of each other say there are five things here.
    // There are three: what the network is, who is on it, and the two errands
    // at the bottom.
    const gap = (sel: string, prop: string) => Number(new RegExp(prop + ":\\s*(\\d+)px").exec(rule(sel))?.[1]);
    const between = gap(".ap-lan-here", "gap");
    expect(between).toBeLessThan(gap(".ap-lan-here", "margin"));      // list edge above
    // The tail is the rest of the list rather than the next thing, so it sits
    // no further from the last row than the rows sit from each other.
    expect(gap(".ap-lan-tail", "margin-top")).toBeLessThanOrEqual(between);
    // 24px verbs 5px apart put their centres 29px apart, which is what SC 2.5.8
    // asks of a target that is not itself 24px away from the next one.
    expect(between + 24).toBeGreaterThanOrEqual(24);
  });

  it("puts the act in the header and leaves the settings at the foot", () => {
    // They were two words side by side at the foot, at one weight, offering two
    // equal errands — and one of them is what this section is FOR while the
    // other is done twice in a deck's life. The first is a `+` in the header
    // now, beside the round, which is where the accounts header two sections up
    // has kept the same glyph for the same act since it was written.
    const head = /<div className="ap-auto-head">([\s\S]*?)<\/div>/.exec(CODE)?.[1] ?? "";
    expect(head).toMatch(/ap-lan-plus/);
    expect(head).toMatch(/aria-label="Add a deck"/);
    expect(head).toMatch(/ap-lan-check/);
    // A glyph has to carry its label somewhere, and `+` alone is not one.
    expect(head).not.toMatch(/aria-label=""/);
    expect(head).toMatch(/ap-lan-set/);
    expect(head).toMatch(/aria-label="This deck's name and shared logins"/);
    // AN ICON IS DRAWN, NOT TYPED. The three were `+`, `↻` and `⚙` — three
    // Unicode codepoints from three different blocks, drawn by whichever
    // installed font happened to cover each one, which measured 8.7x7.4,
    // 9.8x9.9 and 7.2x7.2 of ink in a row of three identical buttons. They are
    // authored now at the spec the topbar's five already use.
    expect(head).not.toMatch(/[\u2699\u21BB]/);
    const icons = [...head.matchAll(/<svg([^>]*)>/g)].map(m => m[1]);
    expect(icons).toHaveLength(3);
    for (const attrs of icons) {
      expect(attrs, attrs).toContain('width="13" height="13"');
      expect(attrs, attrs).toContain('viewBox="0 0 14 14"');
      expect(attrs, attrs).toContain('strokeWidth="1.3"');
      expect(attrs, attrs).toContain('stroke="currentColor"');
      // The button carries the name; the drawing inside it must not be a second
      // one for a screen reader to read out.
      expect(attrs, attrs).toContain("aria-hidden");
    }
    // And no per-control font-size survives: those were three fonts being
    // talked into looking one size, not typography.
    for (const sel of [".ap-lan-plus", ".ap-lan-check", ".ap-lan-set"]) {
      expect(rule(sel), sel).not.toMatch(/font-size/);
    }
    // There is no foot any more. What was down there is two glyphs up here, and
    // the one thing that was never a control — when the last round ran — shares
    // the list's last line with the fold, because both are facts about the list
    // rather than about any deck on it.
    expect(CODE).not.toContain("ap-lan-foot");
    const tail = /<div className="ap-lan-tail">([\s\S]*?)\n {10}<\/div>/.exec(CODE)?.[1] ?? "";
    expect(tail).toMatch(/ap-lan-more/);
    expect(tail).toMatch(/ap-lan-checked/);
    expect(CODE).not.toContain("name &amp; sharing");
    // And the title is what pushes the header's controls right, so the row
    // survives every combination of the three that can be missing.
    expect(rule(".ap-lan .ap-auto-title")).toMatch(/margin-right:\s*auto/);
  });
});

describe("switching on says what switching on does", () => {
  /** The one callback this rule is about, with the file's comments already
   *  gone: a paragraph promising to open the dialog is not the dialog. */
  const TOGGLE = /const toggle = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(CODE)?.[1] ?? "";

  it("opens the setup dialog on the press that put this deck on the network", () => {
    // THE DEFECT: a deck could start beaconing its name to every machine on the
    // network, offering whichever logins the share list happened to hold, and
    // the person who pressed the switch had been shown neither. Both facts sat
    // one press deeper behind `name & shared logins`, so the ordinary way to
    // turn this on was to turn it on and never look.
    expect(TOGGLE).not.toBe("");
    // On EVERY enable, not on the first: what is shared changes between one
    // switch-on and the next, so a dialog shown once is a dialog about a list
    // that has since moved. Nothing here remembers having shown it.
    expect(TOGGLE).toMatch(/if \(!on\) setSetupOpen\(true\)/);
    expect(TOGGLE).not.toMatch(/setupShown|seenSetup|firstTime|once/);
    // And only where the write landed: after the `ok`, before the `else` that
    // reports a refusal. A dialog over a switch that did not move would be the
    // panel telling somebody about a network they are not on.
    const ok = TOGGLE.indexOf("if (out?.ok)");
    const failed = TOGGLE.indexOf("setFailure(writeFailure(");
    const opens = TOGGLE.indexOf("setSetupOpen(true)");
    expect(ok).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(ok);
    expect(opens).toBeLessThan(failed);
    // Once, so the `catch` — the deck did not answer at all — opens nothing
    // either.
    expect([...TOGGLE.matchAll(/setSetupOpen\(/g)]).toHaveLength(1);
  });

  it("opens it from the press and never from the flag", () => {
    // `status.enabled` is polled every five seconds and is not a record of
    // anybody pressing anything: it goes true on a reload, on the first poll of
    // a deck that was already on, and when the server switches it on by itself.
    // An effect watching it would therefore put a dialog in front of a reader
    // who is three sections up looking at a quota — which is the same defect
    // the fold and the live regions were written around.
    for (const [effect] of CODE.matchAll(/useEffect\([\s\S]*?\n  \}, \[[^\]]*\]\);/g)) {
      expect(effect).not.toMatch(/setSetupOpen/);
      expect(effect).not.toMatch(/enabled/);
    }
    // Three presses open it and nothing else does: the switch on its way on,
    // the control that has always opened it, and the line in a deck's own
    // dialog that goes from "you offer" to where that list is changed.
    expect([...CODE.matchAll(/setSetupOpen\(true\)/g)]).toHaveLength(3);
    expect(CODE).toMatch(/onClick=\{\(\) => setSetupOpen\(true\)\}/);
    expect(CODE).toMatch(/onSettings=\{\(\) => \{ setPeerOpen\(null\); setSetupOpen\(true\); \}\}/);
  });
});

describe("the pairing that replaced the passphrase", () => {
  it("asks a person about a named machine, not about a string nobody can see", () => {
    // THE DEFECT THE WHOLE REDESIGN CAME OUT OF. A passphrase differing by one
    // character produced a closed socket and no other symptom on both machines,
    // and a secret is the one value a panel must never print — so neither
    // person could check theirs against the other's.
    expect(CODE).toMatch(/wants to pair/);
    expect(CODE).toMatch(/accept/);
    expect(CODE).toMatch(/dismiss/);
    // And what the reader is asked to compare is on the request itself —
    // PRINTED, not only in a `title`. A mouse-only, screen-reader-silent place
    // is not where the feature's one security decision can live.
    expect(CODE).toMatch(/fingerprint is \$\{p\.fp\}/);
    expect(CODE).toMatch(/fingerprint <code className="ap-lan-code">\{p\.fp\}<\/code>/);
  });

  it("has no passphrase left anywhere in the surface", () => {
    for (const src of [CODE, MODAL]) {
      expect(src).not.toMatch(/passphrase/i);
      expect(src).not.toMatch(/type="password"/);
    }
  });

  it("puts the request above everything else, because nothing moves until it is answered", () => {
    const ask = CODE.indexOf('className="ap-lan-asks"');
    expect(ask).toBeGreaterThan(-1);
    // Above the roster, which is the only other thing in the section.
    expect(ask).toBeLessThan(CODE.indexOf('className="ap-lan-here"'));
    // Announced, because it arrives while the reader is three sections up
    // looking at a quota.
    expect(CODE).toMatch(/className="ap-lan-asks" role="alert"/);
  });

  it("says how long a request has been waiting, coarsely, because the answer is a press", () => {
    const NOW = 1_700_000_000_000;
    expect(askedLabel(NOW, NOW)).toBe("just now");
    expect(askedLabel(NOW - 30_000, NOW)).toBe("just now");
    expect(askedLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(askedLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  it("routes accept, dismiss and unpair through one server verb each", () => {
    expect(SERVER).toMatch(/function handleLanPeer/);
    expect(SERVER).toMatch(/url\.pathname === "\/api\/lan\/peer"/);
    for (const verb of ["accept", "dismiss", "unpair"]) {
      expect(SERVER, verb).toMatch(new RegExp(`case "${verb}"`));
    }
    // The KEY being pinned comes from what this deck saw on the wire, never
    // from the page — so a page cannot pair this deck with a key nobody met.
    expect(SERVER).toMatch(/never from\s+\*\s*the page/);
  });
});

describe("who is here, which is what the panel is for now", () => {
  const NOW2 = 1_700_000_000_000;
  const peer = (over: Record<string, unknown> = {}) => ({ fp: "a", name: "Deck", addr: "", port: 0, ...over });

  it("counts a deck that beacons recently as here", () => {
    expect(isOnline(peer({ lastSeen: NOW2 - 10_000 }) as never, NOW2)).toBe(true);
    expect(isOnline(peer({ lastSeen: NOW2 - ONLINE_MS - 1 }) as never, NOW2)).toBe(false);
  });

  it("counts a deck reached by address, which never beacons at all", () => {
    // The only evidence for a typed peer is whether the last round got through,
    // and that is exactly what a person means by "is it up".
    expect(isOnline(peer({ last: { at: NOW2 - 5_000, done: [] } }) as never, NOW2)).toBe(true);
  });

  it("counts a deck it can hear and cannot talk to as away", () => {
    // A round that failed is offline whatever the beacon says: somewhere you
    // cannot send an account is not somewhere that is here.
    expect(isOnline(peer({ lastSeen: NOW2, last: { at: NOW2, error: "timed out" } }) as never, NOW2)).toBe(false);
  });

  it("splits the roster so the panel can list one half and count the other", () => {
    const { online, offline } = rosterSplit([
      peer({ fp: "a", lastSeen: NOW2 }),
      peer({ fp: "b", lastSeen: NOW2 - 10 * 60_000 }),
    ] as never, NOW2);
    expect(online.map(p => p.fp)).toEqual(["a"]);
    expect(offline.map(p => p.fp)).toEqual(["b"]);
  });

  it("says what is happening in one line, in the words a person would use", () => {
    // Nothing asked yet is not the same as switched off, and saying `off`
    // before the first answer lands is a wrong answer given confidently.
    expect(sectionState(null, NOW2)).toEqual({ text: "checking…", tone: "idle" });
    // NOTHING WHILE IT IS OFF. The switch beside it already says so, in the one
    // place a person looks to change it, and the subtitle under the heading
    // says what the feature is for. A sentence that only restates a control the
    // eye has already read is a line of type charging rent for nothing — and
    // this one sat under a switch it could not disagree with.
    expect(sectionState({ enabled: false }, NOW2)).toEqual({ text: "", tone: "idle" });
    // `checking…` above is the one that still speaks, and it has to: it is the
    // difference between "not asked yet" and "asked, and the answer is off".
    expect(sectionState({ enabled: true, running: false }, NOW2).text).toBe("starting…");
    // And a start that failed says why rather than saying `starting…` until the
    // process dies. A second deck on one machine takes the first one's port.
    expect(sectionState({ enabled: true, running: false, stalled: "listen EADDRINUSE: address already in use 0.0.0.0:62259" }, NOW2))
      .toEqual({ text: "could not start — listen EADDRINUSE: address already in use 0.0.0.0:62259", tone: "bad" });
    expect(sectionState({ enabled: true, running: true, peers: [] }, NOW2))
      .toEqual({ text: "no deck paired yet", tone: "idle" });
    expect(sectionState({ enabled: true, running: true, peers: [peer({ lastSeen: NOW2 })] as never }, NOW2))
      .toEqual({ text: "1 deck ready", tone: "ok" });
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", lastSeen: NOW2 }), peer({ fp: "b", lastSeen: NOW2 - 10 * 60_000 })] as never,
    }, NOW2)).toEqual({ text: "1 deck ready · 1 away", tone: "ok" });
  });

  it("does not call a deck that CALLS IN unreachable, which is the line that lied", () => {
    // lan-engine.mjs synthesizes a row for every deck this one accepted and
    // holds no address for. It is never dialled, so `last` stays null and
    // `lastSeen` never arrives, so `isOnline` is false for it forever — and the
    // line drew `no paired deck is reachable` in the warning ink over a pairing
    // that was working perfectly, two lines above that deck's own row saying it
    // reaches us.
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", paired: true, waiting: true, lastSeen: NOW2 - 20_000 })] as never,
    }, NOW2)).toEqual({ text: "1 deck ready", tone: "ok" });
    // And one that has NOT called is not ready either — being paired says what
    // happened once, not whether that machine is switched on now.
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", paired: true, waiting: true })] as never,
    }, NOW2).tone).toBe("bad");
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", paired: true, waiting: true, lastSeen: NOW2 - 40 * 60_000 })] as never,
    }, NOW2).tone).toBe("bad");
    // And a deck that calls in AND failed the last round it was part of is not
    // laundered by the same rule.
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", paired: true, waiting: true, last: { at: NOW2, error: "timed out" } })] as never,
    }, NOW2).tone).toBe("bad");
  });

  it("does not call a deck that answered unreachable, nor a waiting one ready", () => {
    // Both halves of one screenshot. Three decks each said `waiting for the
    // other deck to accept this one` — an ANSWER, from a machine plainly there
    // — and the line read `this deck cannot reach any of its 3 decks` while
    // every row under it said `last online now`.
    const asked = (fp: string) => peer({ fp, peerFp: fp, paired: true, lastSeen: NOW2,
      last: { at: NOW2, error: "waiting for the other deck to accept this one" } });
    expect(isOnline(asked("a") as never, NOW2)).toBe(true);
    expect(sectionState({ enabled: true, running: true, peers: [asked("a")] as never }, NOW2))
      .toEqual({ text: "1 deck found · waiting for them to accept", tone: "wait" });
    expect(sectionState({
      enabled: true, running: true, peers: [asked("a"), asked("b"), asked("c")] as never,
    }, NOW2)).toEqual({ text: "3 decks found · waiting for them to accept", tone: "wait" });
    // One of them accepting takes the line back to the ordinary count rather
    // than leaving it on the waiting sentence.
    expect(sectionState({
      enabled: true, running: true,
      peers: [asked("a"), peer({ fp: "b", peerFp: "b", paired: true, lastSeen: NOW2 })] as never,
    }, NOW2).tone).toBe("ok");
    // And the row itself is neither fine nor broken.
    const [row] = deckRows({ peers: [asked("a")] as never }, NOW2);
    expect(row.state).toBe("online · waiting for them to say yes");
    expect(row.tone).toBe("wait");
    expect(row.here).toBe(true);
  });

  it("does not let one typed address report the whole fleet as broken", () => {
    // An address nothing has ever answered at is not a deck that is away. It is
    // a string somebody typed, it has its own row and its own verb, and
    // counting it as an unreachable peer let one typo paint the section red.
    expect(sectionState({
      enabled: true, running: true,
      peers: [
        peer({ fp: "manual:10.0.0.9:5000", paired: false, manual: true, met: false, last: { at: NOW2, error: "timed out" } }),
        peer({ fp: "b", paired: true, lastSeen: NOW2 }),
      ] as never,
    }, NOW2)).toEqual({ text: "1 deck ready", tone: "ok" });
  });

  it("leads with a request, because until it is answered nothing moves", () => {
    expect(sectionState({
      enabled: true, running: true, pending: [{ fp: "a", name: "x", addr: "y", at: NOW2 }],
      peers: [peer({ lastSeen: NOW2 })] as never,
    }, NOW2)).toEqual({ text: "1 deck is waiting for your answer", tone: "wait" });
  });

  it("says it plainly when nothing is reachable, rather than counting to zero", () => {
    // And it names the DIRECTION, because "not reachable" says nothing about
    // which side cannot do what — which is the whole confusion in a feature
    // where one machine dials and the other answers.
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ paired: true, last: { at: NOW2, error: "timed out" } })] as never,
    }, NOW2)).toEqual({ text: "this deck cannot reach the one it is paired with", tone: "bad" });
    expect(sectionState({
      enabled: true, running: true,
      peers: [
        peer({ fp: "a", paired: true, last: { at: NOW2, error: "timed out" } }),
        peer({ fp: "b", paired: true, last: { at: NOW2, error: "timed out" } }),
      ] as never,
    }, NOW2)).toEqual({ text: "this deck cannot reach any of its 2 decks", tone: "bad" });
  });

  it("gives every machine one row, in the order of what is owed to whom", () => {
    const rows = deckRows({
      pending: [{ fp: "p", name: "Asking-Deck", addr: "10.0.0.1", at: NOW2 }],
      peers: [
        peer({ fp: "z", peerFp: "z", name: "Zed", paired: true, lastSeen: NOW2 }),
        peer({ fp: "a", peerFp: "a", name: "Alma", paired: true, lastSeen: NOW2 }),
        peer({ fp: "manual:10.0.0.9:5000", name: "10.0.0.9", addr: "10.0.0.9", port: 5000, manual: true, met: false, paired: false }),
      ] as never,
      strangers: [{ fp: "s", name: "Near", addr: "10.0.0.2", at: NOW2 }],
      declined: [{ fp: "d", name: "Turned-Away", addr: "10.0.0.3", at: NOW2 }],
    }, NOW2);
    expect(rows.map(r => r.kind)).toEqual(["asks", "paired", "paired", "dialling", "nearby", "declined"]);
    // Alphabetical INSIDE a kind, never by liveness: sorting the paired decks
    // by whether they answered last made a row change position between two
    // five-second polls on one lost beacon, in a list somebody is scanning for
    // one machine.
    expect(rows.filter(r => r.kind === "paired").map(r => r.name)).toEqual(["Alma", "Zed"]);
  });

  it("leads every row with whether that machine is on, and when it last was", () => {
    // The row said what the last ROUND did, and a reader scanning a list of
    // machines asks something simpler first: is that one up? A bare `12m ago`
    // was a number with no noun doing the work of both answers.
    const rows = deckRows({
      peers: [
        peer({ fp: "up", peerFp: "up", name: "Up", paired: true, lastSeen: NOW2,
          last: { at: NOW2, done: [{ email: "a@b.c", action: "heal", ok: true }] } }),
        peer({ fp: "down", peerFp: "down", name: "Down", paired: true, lastSeen: NOW2 - 20 * 60_000 }),
        peer({ fp: "broke", peerFp: "broke", name: "Broke", paired: true, lastSeen: NOW2 - 20 * 60_000,
          last: { at: NOW2, error: "handshake timed out" } }),
        peer({ fp: "new", peerFp: "new", name: "New", paired: true }),
      ] as never,
    }, NOW2);
    const said = Object.fromEntries(rows.map(r => [r.name, r.state]));
    expect(said).toEqual({
      Broke: "no answer · last online 20m ago",
      Down: "last online 20m ago",
      New: "never reached",
      // Online dates itself, so the round's own clock is dropped: two
      // timestamps do not fit in 190px and the second one answers nothing.
      Up: "online · 1 login arrived",
    });
    // Every one of them fits the row it has to live in.
    for (const [name, text] of Object.entries(said)) expect(text.length, name).toBeLessThan(36);
  });

  it("keeps an address that never answered out of the paired rows", () => {
    // It wore the paired row and the paired verb, and `unpair` on it named a
    // fingerprint built out of the address — which matches nothing this deck
    // ever met, so the row's one control answered `could not unpair that deck`.
    const [row] = deckRows({
      peers: [peer({ fp: "manual:10.0.0.9:5000", name: "10.0.0.9", addr: "10.0.0.9", port: 5000, manual: true, met: false, paired: false })] as never,
    }, NOW2);
    expect(row.kind).toBe("dialling");
    // The verb names the address, because that is what the removal filters out
    // of prefs — there is no fingerprint here to unpair.
    expect(row.fp).toBe("10.0.0.9:5000");
    expect(row.state).toBe("trying…");
    const [failed] = deckRows({
      peers: [peer({ fp: "manual:10.0.0.9:5000", name: "10.0.0.9", addr: "10.0.0.9", port: 5000, manual: true, met: false, paired: false,
        last: { at: NOW2, error: "handshake timed out" } })] as never,
    }, NOW2);
    // No presence clause on this kind: the row already IS "an address nothing
    // has answered at", and saying it twice is the panel repeating itself.
    expect(failed.state).toBe("no answer");
  });

  it("says the one-way case out loud, because a round only ever pulls", () => {
    // roundWith dials, reads the far manifest and imports: nothing leaves on a
    // round this deck starts. So a deck this one holds no address for repairs
    // ITSELF from here and can never repair this one — and `reaches us` was
    // true, cheerful, and hid the half that matters to somebody whose own login
    // has expired.
    const [row] = deckRows({
      peers: [peer({ fp: "a", peerFp: "a", name: "Studio", paired: true, waiting: true })] as never,
    }, NOW2);
    expect(row.state).toBe("one-way · has not called yet");
    // Short enough to be one line in a 190px row, because three of them can be
    // true at once and the honest long form wrapped on every one.
    expect(row.state.length).toBeLessThan(30);
    // AND IT IS NOT DRAWN AS LIVE. Being paired says what happened once and
    // says nothing about whether that machine is switched on now — a Windows
    // deck closed an hour ago still drew with the live emitter, and the section
    // counted it as ready. Reported from a screenshot of exactly that.
    expect(row.here).toBe(false);
    expect(row.tone).toBe("idle");

    // Once it has called, the row says when — and goes live for as long as the
    // same window the beacon rows use.
    const [fresh] = deckRows({
      peers: [peer({ fp: "a", peerFp: "a", name: "Studio", paired: true, waiting: true, lastSeen: NOW2 - 20_000 })] as never,
    }, NOW2);
    expect(fresh.state).toBe("online · one-way, it calls in");
    expect(fresh.here).toBe(true);
    const [stale] = deckRows({
      peers: [peer({ fp: "a", peerFp: "a", name: "Studio", paired: true, waiting: true, lastSeen: NOW2 - 40 * 60_000 })] as never,
    }, NOW2);
    expect(stale.state).toBe("one-way · last online 40m ago");
    expect(stale.here).toBe(false);
    expect(row.hint).toMatch(/cannot repair from it/);
    expect(row.hint).toMatch(/add its address/i);
  });

  it("carries the whole of a name in the hint, because 190px does not", () => {
    // The row `title` used to hold the ADDRESS while the NAME was the thing
    // being truncated, so a long hostname could not be read in full anywhere in
    // the app.
    const [row] = deckRows({
      strangers: [{ fp: "s", name: "DESKTOP-QK7H2LM-ENGINEERING-04", addr: "10.0.0.2", at: NOW2 }],
    }, NOW2);
    expect(row.hint).toContain("DESKTOP-QK7H2LM-ENGINEERING-04");
  });

  it("shows one machine once, whichever lists it turns up in", () => {
    const rows = deckRows({
      pending: [{ fp: "same", name: "Twice", addr: "10.0.0.1", at: NOW2 }],
      strangers: [{ fp: "same", name: "Twice", addr: "10.0.0.1", at: NOW2 }],
      declined: [{ fp: "same", name: "Twice", addr: "10.0.0.1", at: NOW2 }],
    }, NOW2);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("asks");
  });

  it("survives a null status and junk in the lists", () => {
    expect(deckRows(null, NOW2)).toEqual([]);
    expect(deckRows({}, NOW2)).toEqual([]);
    expect(deckRows({ pending: [null, { name: "no fp" }] as never }, NOW2)).toEqual([]);
  });

  it("says when it last asked, because a live list and a stopped one look alike", () => {
    // Nothing said it. A section that refreshes itself every minute is
    // indistinguishable from one that has stopped, and the only way to tell
    // them apart was to press the button and watch — which is what the button
    // was being pressed for.
    expect(CODE).toMatch(/checkedLabel\(status\?\.checkedAt, now/);
    expect(checkedLabel(null, NOW2, false)).toBe("not checked yet");
    expect(checkedLabel(NOW2 - 180_000, NOW2, false)).toBe("checked 3m ago");
    // `checked now` reads for half a beat as an instruction rather than as a
    // report, and it is the one value of `seenLabel` that does: every other
    // answer already ends in `ago`.
    expect(checkedLabel(NOW2 - 5_000, NOW2, false)).toBe("checked just now");
    // And it comes from the engine's own clock rather than from a render, so a
    // panel opened an hour later reads the round rather than the visit.
    expect(SERVER_ENGINE).toMatch(/roundAt = now\(\)/);
    expect(SERVER_ENGINE).toMatch(/checkedAt: roundAt/);
  });

  it("counts an invite down in minutes and seconds, which is how it is read out", () => {
    expect(leftLabel(NOW2 + 600_000, NOW2)).toBe("10:00");
    expect(leftLabel(NOW2 + 61_000, NOW2)).toBe("1:01");
    expect(leftLabel(NOW2 + 9_000, NOW2)).toBe("0:09");
    expect(leftLabel(NOW2 - 5_000, NOW2)).toBe("0:00");
  });
});

describe("the invite, which is one piece of text and every address", () => {
  it("carries all of them, because nobody knows which one routes", async () => {
    const { mintInvite, readInvite } = await import("../../server/lan-sync.mjs");
    const made = mintInvite({ addrs: ["100.67.32.58:49336", "192.168.1.82:49336"], name: "Constantins-iMac" });
    const read = readInvite(made.token);
    expect(read.addrs).toEqual([
      { addr: "100.67.32.58", port: 49336 },
      { addr: "192.168.1.82", port: 49336 },
    ]);
    expect(read.name).toBe("Constantins-iMac");
    expect(read.code).toBe(made.code);
  });

  it("tells an expired one apart from a thing that is not an invite", async () => {
    // Two different instructions for the reader: ask for a new one, or paste
    // the whole thing. A reader who cannot tell them apart retypes the same.
    const { mintInvite, readInvite, INVITE_MS } = await import("../../server/lan-sync.mjs");
    const made = mintInvite({ addrs: ["1.2.3.4:5"], name: "x", now: 1_000 });
    expect(readInvite(made.token, 1_000).expired).toBe(false);
    expect(readInvite(made.token, 1_000 + INVITE_MS + 1).expired).toBe(true);
    for (const junk of ["", "hello", "ccdeck1.", "ccdeck1.!!!", "ccdeck2.abc", null, 5]) {
      expect(readInvite(junk as string), String(junk)).toBeNull();
    }
  });

  it("has a code that is six digits and evenly drawn", async () => {
    // A modulo over a byte would make 0-5 likelier than 6-9, in the one number
    // that decides whether a stranger can pair.
    const { inviteCode } = await import("../../server/lan-sync.mjs");
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const c = inviteCode();
      expect(c).toMatch(/^[0-9]{6}$/);
      for (const d of c) seen.set(d, (seen.get(d) ?? 0) + 1);
    }
    const counts = [...Array(10).keys()].map(d => seen.get(String(d)) ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(Math.max(...counts) * 0.6);
  });

  it("proves the holder without ever sending the code", async () => {
    const { inviteProof } = await import("../../server/lan-sync.mjs");
    const a = inviteProof("482100", "fpA|fpB|c1|c2");
    expect(a).not.toContain("482100");
    // Bound to the transcript, so a recording of one exchange is worth nothing.
    expect(inviteProof("482100", "fpA|fpB|c1|c3")).not.toBe(a);
    expect(inviteProof("482101", "fpA|fpB|c1|c2")).not.toBe(a);
  });

  it("refuses a token built to make this deck dial a list", async () => {
    const { mintInvite, MAX_INVITE_ADDRS, readInvite } = await import("../../server/lan-sync.mjs");
    const many = Array.from({ length: 50 }, (_, i) => `10.0.0.${i}:5000`);
    const made = mintInvite({ addrs: many, name: "x" });
    expect(readInvite(made.token).addrs).toHaveLength(MAX_INVITE_ADDRS);
  });
});

describe("the list of decks nearby, which was a wall of ghosts", () => {
  const T = 1_700_000_000_000;
  const heard = (over: Record<string, unknown> = {}) => ({ fp: "a", name: "Deck-A", addr: "192.168.1.82", port: 1, at: T, ...over });

  it("drops a deck nobody has heard from in a while", async () => {
    // Every deck ever heard stayed forever, so a machine started and stopped
    // seven times was seven rows — same name, same address, none of them
    // reachable. That is what made the dialog unreadable.
    const { pairable, PRESENT_MS } = await import("../../server/lan-sync.mjs");
    const live = heard({ at: T - 1_000 });
    const gone = heard({ fp: "b", name: "Deck-B", at: T - PRESENT_MS - 1 });
    expect(pairable([live, gone], T).shown.map((p: { fp: string }) => p.fp)).toEqual(["a"]);
  });

  it("shows one row per machine, keeping the one still running", async () => {
    // A deck that restarts takes a new key, so the same machine arrives under a
    // new fingerprint. To the person reading, a name at an address is a
    // machine — and the freshest of them is the one still there.
    const { pairable } = await import("../../server/lan-sync.mjs");
    const shown = pairable([
      heard({ fp: "old", at: T - 40_000 }),
      heard({ fp: "new", at: T - 1_000 }),
      heard({ fp: "other", name: "Deck-B", at: T - 2_000 }),
    ], T).shown;
    expect(shown.map((p: { fp: string }) => p.fp)).toEqual(["new", "other"]);
  });

  it("puts the deck somebody just started at the top", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    const shown = pairable([
      heard({ fp: "a", name: "A", at: T - 50_000 }),
      heard({ fp: "b", name: "B", at: T - 1_000 }),
    ], T).shown;
    expect(shown.map((p: { name: string }) => p.name)).toEqual(["B", "A"]);
  });

  it("caps the list and says how many it did not show", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    const many = Array.from({ length: 14 }, (_, i) => heard({ fp: `f${i}`, name: `Deck-${i}`, at: T - i }));
    const out = pairable(many, T, { limit: 8 });
    expect(out.shown).toHaveLength(8);
    expect(out.more).toBe(6);
  });

  it("never offers to pair with this machine", async () => {
    // A deck's own beacon is filtered by fingerprint, and that is not enough: a
    // second deck on the same computer is a different process with a different
    // key, so it passes that check honestly and then appears under this
    // machine's own hostname, at its own address, offering to pair with itself.
    // Reported from a screenshot — "why myself appear here in list".
    const { pairable } = await import("../../server/lan-sync.mjs");
    const rows = [
      heard({ fp: "self", name: "Constantins-iMac", addr: "192.168.1.82" }),
      heard({ fp: "vpn", name: "Constantins-iMac", addr: "100.67.32.58" }),
      heard({ fp: "them", name: "cbargan-windows", addr: "192.168.88.41" }),
    ];
    const out = pairable(rows, T, { mine: ["192.168.1.82", "100.67.32.58"] });
    expect(out.shown.map((p: { fp: string }) => p.fp)).toEqual(["them"]);
    // And with no addresses to compare against, it does not silently drop
    // everything — a machine that cannot name its own addresses still has
    // neighbours worth showing.
    expect(pairable(rows, T).shown).toHaveLength(3);
  });

  it("survives an empty list and junk in it", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    expect(pairable([], T).shown).toEqual([]);
    expect(pairable(null as never, T).shown).toEqual([]);
    expect(pairable([null, {}, heard()] as never, T).shown).toHaveLength(1);
  });
});

describe("what did not change", () => {
  it("still refuses an address with no usable port", () => {
    expect(parseAddress("192.168.1.5:54340")).toEqual({ addr: "192.168.1.5", port: 54340 });
    for (const bad of ["192.168.1.5", "192.168.1.5:", ":54340", "192.168.1.5:0", "192.168.1.5:70000"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("still says the thing that cannot be softened, on the row it is about", () => {
    // THE PARAGRAPH WENT, THE FACT DID NOT. It was a yellow block above the
    // list, and the two halves of it that no rewrite may drop are: another
    // machine keeps its own copy, and unticking does not take that copy back.
    // They live on each tickable row now — hover, and on the row the decision
    // is actually made on, rather than in a wall of warning ink over all of
    // them. Pinned by MEANING, so an honest rewording is not a regression.
    const row = /className="ap-lan-pick" title=\{a\.alive\s*\?\s*"([^"]*)"/.exec(MODAL)?.[1] ?? "";
    expect(row).toMatch(/keeps its own copy|heal from yours/);
    expect(row).toMatch(/does not take back/);
  });

  it("has stopped explaining itself around the two fields it is made of", () => {
    // Three sentences and a fingerprint came off this dialog. What is left is a
    // name to type and a list to tick, which is what it is for — the prose was
    // written when the dialog held thirteen controls and needed to say which
    // was which.
    expect(MODAL).not.toMatch(/Everyone on this network can see this name/);
    expect(MODAL).not.toMatch(/Read this out when somebody is deciding/);
    expect(MODAL).not.toContain("lan-warn");
    // AND THE FINGERPRINT IS STILL PRINTED WHERE IT IS ACTED ON. It is not a
    // decoration anywhere it appears: it is the one value whoever is asking
    // cannot choose, so it belongs on both surfaces that answer a request.
    expect(CODE).toMatch(/fingerprint <code className="ap-lan-code">\{p\.fp\}/);
    expect(readFileSync(
      fileURLToPath(new URL("../components/LanPairRequestModal.tsx", import.meta.url)), "utf8",
    )).toMatch(/fingerprint/);
  });
});

describe("what an off network is allowed to cost", () => {
  // Reported from the Network tab with LOCAL NETWORK switched off: `lan`, `lan`,
  // `prefs`, every five seconds, forever. TWO independent pollers were asking —
  // App's, so a pairing request appears without opening a panel, and the
  // section's own — and neither looked at whether the network was on.
  //
  // With it off nothing can arrive. No beacon is running, nobody can dial in,
  // `pending` cannot become anything and the peer list cannot change. Three
  // requests every five seconds is fifty-two thousand a day for a section
  // reading "off — this deck is not on the network".
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("asks slowly while the switch is off, and quickly while it is on", () => {
    expect(SRC).toContain("export const LAN_POLL_ON_MS = 5_000;");
    expect(SRC).toContain("export const LAN_POLL_OFF_MS = 60_000;");
    // One pair of numbers, used by both pollers, rather than one each.
    // Other names may ride the same import; the two constants must be on it.
    expect(app).toMatch(/import \{ LAN_POLL_OFF_MS, LAN_POLL_ON_MS(, \w+)* \} from "\.\/components\/LanSyncSection";/);
    for (const src of [SRC, app]) {
      expect(src).toMatch(/enabled === true \? LAN_POLL_ON_MS : LAN_POLL_OFF_MS/);
    }
  });

  it("chains timeouts rather than setting an interval", () => {
    // An interval cannot change its own period without the effect being torn
    // down and rebuilt, and rebuilding it on every answer would re-fire the
    // request that produced the answer.
    // The section decides the next delay when the answer lands and the chain
    // reads it back; App decides it in the chain itself. Both are timeout
    // chains, and neither drives this poll from an interval.
    expect(SRC).toMatch(/timer = window\.setTimeout\(tick, every\.current\)/);
    expect(SRC).not.toMatch(/setInterval\(\(\) => \{ setNow/);
    // Scoped to the LAN poller: App has another `pull` on a five-minute
    // interval — the version check — and this rule is not about that one.
    const at = app.indexOf("const [lanPending, setLanPending]");
    const lanBlock = app.slice(at, app.indexOf("const answerLanPair", at));
    expect(lanBlock).toMatch(/setTimeout\(pull, j\?\.enabled === true \? LAN_POLL_ON_MS : LAN_POLL_OFF_MS\)/);
    expect(lanBlock).not.toMatch(/setInterval\(/);
  });

  it("keeps the fast cadence for the thing it exists for", () => {
    // A request arriving is the point of the section AND of the dialog in App,
    // so when the network IS on both still ask every five seconds. The saving
    // is meant to be invisible to anybody using the feature.
    expect(SRC).toMatch(/A pairing request arriving is the point of this section/);
  });
});
