// The Local network screens as V4's Figma draws them: the view's rows, its way
// in, "Nothing yet", Add a deck, the pairing request, a paired deck's details
// and the network map. The components are rendered with their real props and
// the markup read; the rules the buttons obey are called directly; the sizes
// and colours are read from the sheet and the theme files. Only what a
// renderer without a DOM cannot reach (the Add dialog is portalled, and a
// click cannot be sent) is pinned on the source, and said so.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";
import { english } from "./lan-english-source";
import { en } from "../i18n/en";
import { addressFault } from "../components/LanAddDeckModal";
import { hasText, joinToken, parseAddress } from "../lan-add-deck";
import { mapLayout, nodeBoxes } from "../lan-network-map";
import { FOLD_AT, viewRows, type DeckRow } from "../lan-roster";
import LanDeckList from "../components/LanDeckList";
import LanEntryRow from "../components/LanEntryRow";
import LanPairRequestModal from "../components/LanPairRequestModal";
import LanPeerFoot from "../components/LanPeerFoot";
import { Legend } from "../components/LanNetworkMap";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector));
  return m?.[1].replace(/\s+/g, " ");
};
const px = (n: number) => `calc(${n}px + var(--ui-text-increase, 0px))`;

const noop = () => {};
const press = () => ({ disabled: false, "aria-busy": false });
const NOW = 1_790_000_000_000;

const deck = (over: Partial<DeckRow>): DeckRow => ({
  fp: "3F9A1C0277B1", name: "iMac", addr: "192.168.1.5", kind: "paired",
  state: "online · all logins fine", tone: "ok", here: true, hint: "", quiet: true, ...over,
});

const listOf = (rows: DeckRow[], pairingMode: "automatic" | "invite" = "automatic") => renderToStaticMarkup(createElement(LanDeckList, {
  rows, pairingMode, armed: null, pressProps: press,
  answer: (async () => null) as never, dropAddress: (async () => null) as never,
  onUnpair: noop, onOpenPeer: noop, onInvite: noop,
}));

describe("the Local network view's rows", () => {
  it("are 44 high on two lines with a 14px glyph in the first column", () => {
    expect(decl(".ap-lan-who", "min-height")).toBe("44px");
    expect(decl(".ap-lan-who", "grid-template-columns")).toBe("14px minmax(0, 1fr) auto");
    expect(decl(".ap-lan-who", "grid-template-areas")).toBe('"glyph name verb" "glyph state verb"');
    expect(decl(".ap-lan-who-name", "font-size")).toBe(px(13));
    expect(decl(".ap-lan-who-name", "line-height")).toBe("20px");
    expect(decl(".ap-lan-who-when", "font-size")).toBe(px(12));
    expect(decl(".ap-lan-who-when", "line-height")).toBe("16px");
    expect(listOf([deck({})])).toMatch(/<svg class="ap-lan-glyph" width="14" height="14"/);
  });

  it("draw the state line on a healthy row too, as visible text", () => {
    const html = listOf([deck({ quiet: true })]);
    expect(html).toMatch(/<span id="lan-who-state-0" class="ap-lan-who-when">online · all logins fine<\/span>/);
    expect(html).not.toContain("vis-hidden\">online");
  });

  it("keep the state mark, and the verb each kind of row had", () => {
    const html = listOf([
      deck({ fp: "a", name: "live", here: true }),
      deck({ fp: "b", name: "away", here: false, state: "last online 2h ago", tone: "idle" }),
      deck({ fp: "c", name: "near", kind: "nearby", here: true, state: "nearby" }),
    ]);
    expect(html.match(/class="ap-pulse"/g)).toHaveLength(2);
    expect(html.match(/class="ap-dot"/g)).toHaveLength(1);
    expect(html.match(/>unpair</g)).toHaveLength(2);
    expect(html).toMatch(/>ask</);
    expect(body(".ap-lan-who > .ap-pulse, .ap-lan-who > .ap-dot")).toMatch(/grid-area:\s*glyph/);
  });

  it("show the decks that are not on as rows, and put a fold only on a long list of paired decks", () => {
    const row = (kind: DeckRow["kind"], here: boolean, i = 0): DeckRow => deck({ fp: `fp${kind}${here}${i}`, kind, here });
    const short = viewRows([row("paired", true), row("paired", false)], false);
    expect(short.shown).toHaveLength(2);
    expect(short.foldable).toBe(false);
    const paired = Array.from({ length: FOLD_AT }, (_, i) => row("paired", i === 0, i));
    expect(viewRows(paired, false).foldable).toBe(false);
    const long = viewRows([...paired, row("paired", false, 99)], false);
    expect(long.foldable).toBe(true);
    expect(long.shown).toHaveLength(1);
    // A nearby deck coming and going does not move the fold.
    expect(viewRows([...paired, row("nearby", true)], false).foldable).toBe(false);
    expect(viewRows([...paired, row("nearby", false)], false).foldable).toBe(false);
    expect(decl(".ap-lan-more", "font-size")).toBe(px(12));
  });
});

describe("the way into Local network", () => {
  const html = renderToStaticMarkup(createElement(LanEntryRow, {
    entry: { text: "2 online", tone: "ok", live: true }, rows: [], onOpen: noop,
    peek: false, openPeek: noop, shutPeek: noop, holdPeek: noop, dropPeek: noop,
  } as never));

  it("is the button first, with a 14px glyph, a name and the state", () => {
    expect(html).toMatch(/<button type="button" id="ap-lan-entry" class="ap-nav ap-lan-nav"/);
    expect(html).toMatch(/class="ap-nav-glyph" width="14" height="14"/);
    expect(html).toContain("Local network");
    expect(html).toContain("2 online");
  });

  it("is 44 high at 13/400 over 12, keeps the shared 6px bleed, and leaves the other fold's sizes alone", () => {
    expect(decl(".ap-nav.ap-lan-nav", "min-height")).toBe("44px");
    expect(decl(".ap-nav.ap-lan-nav", "width")).toBe("calc(100% + 12px)");
    expect(decl(".ap-nav.ap-lan-nav", "margin")).toBe("0 -6px");
    expect(decl(".ap-lan-nav .ap-nav-name", "font-size")).toBe(px(13));
    expect(decl(".ap-lan-nav .ap-nav-name", "font-weight")).toBe("400");
    expect(decl(".ap-lan-nav .ap-nav-state", "font-size")).toBe(px(12));
    expect(decl(".ap-nav-name", "font-size")).toBe(px(12));
    expect(decl(".ap-nav-state", "font-size")).toBe(px(11));
  });
});

describe("Nothing yet", () => {
  it("says its sentence in 12px body text, and How it works is an outlined kit button that opens the guide", () => {
    expect(en["lan.sync.emptyLead"]).toBe("Paired machines repair each other's expired logins.");
    expect(decl(".ap-lan-nothing", "font-size")).toBe(px(12));
    // The section cannot be rendered on without its status; its source is read.
    const section = english(sourceOf("components/LanSyncSection.tsx"));
    expect(section).toMatch(/<p className="ap-lan-nothing">Paired machines repair each other's expired logins\.<\/p>/);
    expect(section).toMatch(/<button type="button" className="btn ap-lan-how" onClick=\{\(\) => setGuideOpen\(true\)\}>\s*How it works\s*<\/button>/);
  });
});

describe("Add a deck", () => {
  it("keeps Add and Join inert on an empty or blank field, and ready on text", () => {
    for (const blank of ["", " ", "\t \n"]) {
      expect(hasText(blank), JSON.stringify(blank)).toBe(false);
      // Enter on a blank field reaches nobody: no address, no token.
      expect(parseAddress(blank)).toBeNull();
      expect(joinToken(blank)).toBeNull();
      expect(addressFault(blank)).toMatch(/^Type an address and a port/);
    }
    expect(hasText("192.168.1.5:54340")).toBe(true);
    expect(joinToken("  abc \n")).toBe("abc");
    expect(parseAddress(" 192.168.1.5:54340 ")).toEqual({ addr: "192.168.1.5", port: 54340 });
  });

  it("is built from these rules (the dialog is portalled, so its source is read)", () => {
    const add = english(sourceOf("components/LanAddDeckModal.tsx"));
    expect(add).toMatch(/<label className="lan-field-label" htmlFor="lan-add-addr">Another deck's address<\/label>/);
    expect(add).toMatch(/disabled=\{!hasText\(addrDraft\) \|\| pressProps\("add"\)\.disabled\}/);
    expect(add).toMatch(/disabled=\{!hasText\(joinDraft\) \|\| pressProps\("join"\)\.disabled\}/);
    expect(add).toMatch(/const token = joinToken\(joinDraft\);\s*if \(!token \|\| !claim\("join"\)\) return;/);
    expect(add).toMatch(/className="btn lan-make"/);
    expect(add).toMatch(/<footer className="modal-foot">\s*<button type="button" className="btn primary" onClick=\{onClose\}>Done<\/button>/);
    // The same requests with the same bodies as before.
    expect(add).toContain('post("/api/prefs", { lan: { manual: [...manual, entry] } })');
    expect(add).toContain('post("/api/lan/invite", { action })');
    expect(add).toContain('post("/api/lan/invite", { action: "join", token })');
  });

  it("speaks V4's words", () => {
    expect(en["lan.add.add"]).toBe("Add");
    expect(en["lan.add.join"]).toBe("Join");
    expect(en["lan.add.makeOne"]).toBe("Make an invite");
    expect(en["lan.add.faultNotInvite"]).toBe("That is not an invite. Paste the whole line they sent you.");
    expect(en["lan.add.faultNotInvite"]).not.toContain("—");
    expect(en["lan.add.inviteIntro"]).toBe("One piece of text you send them. They paste it, and the two decks pair. Nobody has to press anything here.");
  });

  it("sinks the fields into the sunken fill, with a rule between the two methods", () => {
    expect(decl(".lan-add .ap-manage-input", "background")).toBe("var(--sunken)");
    expect(decl(".lan-field-label", "font-size")).toBe(px(12));
    expect(decl(".lan-field-label", "font-weight")).toBe("500");
    expect(decl(".modal.lan-add .modal-section + .modal-section", "border-top")).toBe("1px solid var(--line-soft)");
  });
});

const request = { fp: "3F9A 1C02 77B1", name: "iMac", addr: "192.168.1.5", port: 4317, at: NOW - 120_000 };
const asked = (waiting: number) => renderToStaticMarkup(createElement(LanPairRequestModal, {
  request: request as never, waiting, busy: null, now: NOW, onAccept: noop, onDecline: noop, onLater: noop,
}));

describe("the pairing request", () => {
  it("boxes the fingerprint alone, with no pulse dot, and says where to compare it", () => {
    const html = asked(1);
    expect(html).toMatch(/<code class="lan-ask-fp-box">3F9A 1C02 77B1<\/code>/);
    expect(html).not.toContain("ap-pulse");
    expect(html).toContain("Check the fingerprint matches the one on their screen, under This deck on the network.");
    expect(html).toContain("what it shares is an account, not a screen");
    expect(html).toContain("One more deck is waiting behind this one.");
    expect(asked(0)).not.toContain("waiting behind");
  });

  it("answers in the footer, Decline first and outlined, Accept second and primary", () => {
    const html = asked(0);
    const foot = html.slice(html.indexOf('<footer'));
    expect(foot).toMatch(/^<footer class="modal-foot lan-ask-foot">/);
    expect(foot.indexOf(">Decline<")).toBeGreaterThan(-1);
    expect(foot.indexOf(">Accept<")).toBeGreaterThan(foot.indexOf(">Decline<"));
    expect(foot).toMatch(/<button type="button" class="btn"[^>]*>Decline</);
    expect(foot).toMatch(/<button type="button" class="btn primary"[^>]*>Accept</);
  });

  it("is sized as the Figma box", () => {
    expect(decl(".lan-ask-fp-box", "min-height")).toBe("36px");
    expect(decl(".lan-ask-fp-box", "padding")).toBe("8px 10px");
    expect(decl(".lan-ask-fp-box", "background")).toBe("var(--sunken)");
    expect(decl(".lan-ask-fp-box", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".lan-ask-fp-box", "font-family")).toBe("var(--font-mono)");
    expect(decl(".lan-ask-fp-box", "font-size")).toBe(px(13));
    expect(body(".lan-ask-fp-box")).not.toMatch(/border:/);
    expect(decl(".modal.lan-ask", "width")).toBe("min(420px, calc(100vw - 32px))");
  });

  it("answers with the same calls (the handlers live in pairRequestFor)", () => {
    const ask = english(sourceOf("components/LanPairRequestModal.tsx"));
    expect(ask).toContain('void answerLanPair("accept", request.fp)');
    expect(ask).toContain('void answerLanPair("dismiss", request.fp)');
    expect(ask).toContain("deferLanPair(request.fp)");
  });
});

describe("a paired deck's details", () => {
  const foot = (over: Partial<DeckRow>, peer: unknown = { waiting: false }) => renderToStaticMarkup(createElement(LanPeerFoot, {
    row: deck(over), paired: over.kind ? over.kind === "paired" : true, peer: peer as never, status: { pairingMode: "automatic" } as never,
    busy: null, press, checkNow: noop, armed: false, pressOwn: noop, run: (async () => true) as never,
    onVerb: (async () => null) as never,
  }));

  it("puts Unpair outlined on the left and Check now primary on the right", () => {
    const html = foot({});
    expect(html).toMatch(/^<footer class="modal-foot lan-peer-foot">/);
    const unpair = html.indexOf(">Unpair<");
    const check = html.indexOf(">Check now<");
    expect(unpair).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(unpair);
    expect(html).toMatch(/<button type="button" class="btn danger"[^>]*>Unpair</);
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Check now</);
    expect(decl(".lan-peer-foot", "justify-content")).toBe("space-between");
    expect(body(".lan-peer-foot .btn.danger:not(.armed)")).toMatch(/background:\s*transparent/);
    expect(body(".lan-peer-foot .btn.danger:not(.armed)")).toMatch(/border-color:\s*var\(--ctl-edge\)/);
  });

  it("keeps Check now off a deck that only calls in, and a lone verb for a deck that is not paired", () => {
    expect(foot({}, { waiting: true })).not.toContain("Check now");
    const nearby = foot({ kind: "nearby" });
    expect(nearby).toContain("Ask to pair");
    expect(nearby).not.toContain("Unpair");
    expect(nearby).not.toContain("Check now");
  });

  it("writes the sub-line in 12px mono: calls itself first, then whether it is there", () => {
    expect(decl(".lan-peer-sub", "font-family")).toBe("var(--font-mono)");
    expect(decl(".lan-peer-sub", "font-size")).toBe(px(12));
    expect(decl(".lan-peer-sub", "line-height")).toBe("16px");
    expect(en["lan.peer.callsItself"]).toBe("calls itself {name}");
    // The dialog is portalled; its source orders the two halves.
    const peer = english(sourceOf("components/LanPeerModal.tsx"));
    expect(peer).toMatch(/<span className="lan-peer-state">\{row\.state\}<\/span>/);
    expect(peer.indexOf("callsItself")).toBeLessThan(peer.indexOf("lan-peer-state"));
  });

  it("makes the same calls as before (read from the source: a click cannot be sent here)", () => {
    const f = english(sourceOf("components/LanPeerFoot.tsx"));
    expect(f).toContain("onClick={checkNow}");
    expect(f).toContain("onClick={() => pressOwn()}");
    expect(f).toContain("onClick={() => void run(onVerb)}");
    const peer = english(sourceOf("components/LanPeerModal.tsx"));
    expect(peer).toContain("const checkNow = () => void run(onCheck)");
    expect(peer).toMatch(/usePeerUnpair\(\{ row, run, onVerb, onUnpair \}\)/);
    const section = english(sourceOf("components/LanSyncSection.tsx"));
    expect(section).toContain('case "paired": return answer("unpair", row.fp, "unpair that deck");');
    expect(section).toContain("onCheck={() => checkOne(row.fp)}");
    const list = english(sourceOf("components/LanDeckList.tsx"));
    expect(list).toContain("onClick={() => onUnpair(p)}");
    expect(list).toContain('onClick={() => void answer("accept", p.fp, "reach that deck")}');
    expect(list).toContain("onClick={() => void dropAddress(p.fp)}");
  });
});

describe("the network map", () => {
  it("is titled Local network and puts its caption at 12px under the picture", () => {
    expect(en["lan.nm.title"]).toBe("Local network");
    expect(decl(".nm-sub", "font-size")).toBe(px(12));
    expect(decl(".nm-sub", "line-height")).toBe("16px");
    expect(decl(".nm-legend", "font-size")).toBe(px(12));
    expect(renderToStaticMarkup(createElement(Legend, { slice: false }))).toMatch(/^<ul class="nm-legend">/);
    const map = english(sourceOf("components/LanNetworkMap.tsx"));
    expect(map).toMatch(/<p id="nm-sub" className="nm-sub">\{headline\}<\/p>\s*<Legend /);
  });

  it("gives the details column 360 with 24 of padding", () => {
    expect(decl(".nm-body", "grid-template-columns")).toBe("minmax(0, 1fr) 360px");
    expect(decl(".nm-panel", "padding")).toBe("24px");
    expect(decl(".nm-side", "border-left")).toBe("1px solid var(--line-soft)");
  });

  it("draws this deck 72 across and the others 56 (48 unpaired), the glyph 14, the mark on the disc", () => {
    expect(decl(".nm-core-orb", "width")).toBe("72px");
    expect(decl(".nm-node", "width")).toBe("56px");
    expect(decl('.nm-node[data-tier="loose"]', "width")).toBe("48px");
    expect(decl(".nm-core-orb .lan-machine, .nm-node .lan-machine", "width")).toBe("14px");
    expect(decl(".nm-mark", "width")).toBe("10px");
    // A 10px mark centred on a 56 disc's lower right edge: 8px in from the box's
    // corner along the diagonal, so 3px from each side.
    expect(decl(".nm-mark", "right")).toBe("3px");
    expect(decl(".nm-mark", "bottom")).toBe("3px");
  });

  it("names a deck in 13/20 semibold over an 11/14 line", () => {
    expect(decl(".nm-name", "font-size")).toBe(px(13));
    expect(decl(".nm-name", "font-weight")).toBe("600");
    expect(decl(".nm-name", "line-height")).toBe("20px");
    expect(decl(".nm-cap", "font-size")).toBe(px(11));
    expect(decl(".nm-cap", "line-height")).toBe("14px");
  });

  it("keeps every disc and name off the orb, and off each other, at the stages the dialog draws", () => {
    const d = (i: number, over: Partial<DeckRow> = {}) => deck({ fp: `fp-${i}`, name: `deck-${i}`, ...over });
    const nets = [
      [d(1), d(2), d(3, { here: false }), d(4, { kind: "nearby" })],
      [d(1), d(2), d(3), d(4), d(5), d(6)],
    ];
    const meets = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    // 1440 wide, the stacked map at 1039 and below, a 390 phone.
    for (const [w, h, count] of [[758, 690, 2], [966, 415, 2], [357, 464, 1]]) {
      for (const rows of nets.slice(0, count)) {
        const layout = mapLayout(rows, w, h, "studio-mac");
        const { core, decks } = nodeBoxes(layout, "studio-mac");
        // This deck's orb, 72 across, at the centre.
        const orb = { x0: -36, y0: -36, x1: 36, y1: 36 };
        decks.forEach((a, i) => {
          const at = `${rows.length} decks at ${w}x${h}`;
          expect(meets(a.disc, orb), `${at} disc on the orb`).toBe(false);
          expect(meets(a.disc, core), `${at} disc on the name plate`).toBe(false);
          expect(meets(a.label, core), `${at} name on the orb or plate`).toBe(false);
          for (const b of decks.slice(i + 1)) {
            expect(meets(a.disc, b.disc) || meets(a.label, b.disc) || meets(b.label, a.disc) || meets(a.label, b.label), at).toBe(false);
          }
        });
      }
    }
  });
});

// The orb's glyph is drawn in the orb's ink. Every theme's orb colour is read
// from its file (the two gradients at their middle, where the glyph is) and the
// ink the sheet gives it measured against that.
describe("the orb's glyph", () => {
  const dir = fileURLToPath(new URL("../themes/", import.meta.url));
  type Theme = { id: string; extends?: string; tokens: Record<string, string> };
  const themes = new Map<string, Theme>();
  for (const f of readdirSync(dir).filter(n => n.endsWith(".json") && n !== "schema.json")) {
    const t = JSON.parse(readFileSync(dir + f, "utf8")) as Theme;
    themes.set(t.id, t);
  }
  const token = (id: string, key: string): string => {
    const t = themes.get(id)!;
    return t.tokens[key] ?? (t.extends ? token(t.extends, key) : "");
  };
  const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const lum = ([r, g, b]: [number, number, number]) => {
    const f = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** The orb at its middle: a flat colour, or a gradient 51% of the way from its first stop to its second. */
  const orbAt = (value: string) => {
    const hexes = value.match(/#[0-9a-fA-F]{6}/g)!;
    if (hexes.length === 1) return rgb(hexes[0]);
    const [a, b] = [rgb(hexes[0]), rgb(hexes[1])];
    return a.map((c, i) => Math.round(c * 0.49 + b[i] * 0.51)) as [number, number, number];
  };

  it("inherits the orb's ink, which is --bg except on Light, where it is --text", () => {
    expect(decl(".nm-core-orb .lan-machine", "color")).toBe("inherit");
    expect(decl(".nm-core-orb", "color")).toBe("var(--bg)");
    expect(decl(':root[data-theme="light"] .nm-core-orb', "color")).toBe("var(--text)");
  });

  it("reads at 3:1 or better on every theme", () => {
    expect(themes.size).toBeGreaterThanOrEqual(12);
    for (const id of themes.keys()) {
      const ink = token(id, id === "light" ? "text" : "bg");
      const ratioNow = ratio(rgb(ink), orbAt(token(id, "hero-core")));
      expect(ratioNow, id).toBeGreaterThanOrEqual(3);
    }
  });
});
