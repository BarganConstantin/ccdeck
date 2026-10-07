// The feedback dialog, made effortless (#1853's dialog, after #1886, #1889 and
// #1890).
//
// It had grown into an issue form: three cards with a glyph and a line each, a
// title field, starter chips over the message, a contact field and a paragraph
// in a well about where it all goes — 670px of it at 1440×900 before a word
// was typed. The owner's brief: somebody who noticed something should be able
// to say it in ten seconds, without organising the report for the people who
// read it.
//
// So the default state is one question and one field to answer it in, a
// compact Bug / Idea / Other over it, Add screenshot and Add details under it,
// one line saying what rides along, and Send feedback. The title is worked out
// from the message and never asked for (#1889's derivation, kept; its title
// field and starters, reversed on purpose). The contact and what happens to a
// report are under Add details. Sent, the dialog thanks and closes itself.
//
// Plain node, no renderer — the suite cannot draw React (see
// topbar-interaction.test.ts) — so the rules are exercised through the pure
// functions feedback.ts exports and the wiring is read off the source.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KINDS, kindCopy, hasMessage, titleFromBody, feedbackTitle, fieldsToSend, parseFacts, systemLabel, factsLabel,
  isSendShortcut, isPlainEnter, sendShortcutCaps, isSymbolCap, outcomeAnnouncement, feedbackFailure,
  TITLE_MIN, TITLE_MAX, CONTACT_MAX, MESSAGE_MISSING, SENT_LINE, SENT_HOLD_MS, SENT_EXIT_MS, FACTS_SUFFIX,
  FACTS_UNKNOWN, ADD_DETAILS, CONTACT_LABEL, CONTACT_PLACEHOLDER, CONTACT_HINT, WHERE_IT_GOES, type EnterKey,
} from "../feedback";
import { openTags, withoutComments } from "./tsx-scan";
import { sheetText } from "./sheet-source";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
/** JSX text flows across lines; the words are what is pinned, not the wrap. */
const flat = (src: string) => src.replace(/\s+/g, " ");
const dialog = read("../components/FeedbackDialog.tsx");
const kinds = read("../components/FeedbackKinds.tsx");
const details = read("../components/FeedbackDetails.tsx");
const shots = read("../components/FeedbackShots.tsx");
const sendHook = read("../use-feedback-send.ts");
const factsHook = read("../use-feedback-facts.ts");
const flatDialog = flat(dialog);
const flatDetails = flat(details);
const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet's top-level rules as [selectors, body]. A @media body is another
 *  cascade — the reduced-motion and forced-colours answers are not how
 *  anything rests — so it is skipped whole. */
const RULES: Array<[string[], string]> = (() => {
  const out: Array<[string[], string]> = [];
  let i = 0;
  while (i < sheet.length) {
    const open = sheet.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let end = open;
    for (; end < sheet.length; end++) {
      if (sheet[end] === "{") depth++;
      else if (sheet[end] === "}" && --depth === 0) break;
    }
    const prelude = sheet.slice(i, open).replace(/\s+/g, " ").trim();
    if (!prelude.startsWith("@")) out.push([prelude.split(",").map(s => s.trim()), sheet.slice(open + 1, end)]);
    i = end + 1;
  }
  return out;
})();

/** Every top-level block written for exactly this selector, joined. */
function rule(selector: string): string {
  const found = RULES.filter(([sels]) => sels.includes(selector)).map(([, body]) => body);
  expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return found.join(";");
}
/** A declaration's value in that block, the last one winning. */
function value(selector: string, prop: string): string {
  const all = [...rule(selector).matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))];
  expect(all.length, `${selector} declares no ${prop}`).toBeGreaterThan(0);
  return all[all.length - 1][1].trim();
}
const px = (v: string) => Number.parseFloat(v);

const key = (over: Partial<EnterKey>): EnterKey =>
  ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });

describe("the default state asks for one thing", () => {
  it("draws one text field to write in, the message, and no title field at all", () => {
    const sources = [dialog, kinds, details, shots];
    const areas = sources.flatMap(src => openTags(src, ["textarea"]));
    expect(areas.length).toBe(1);
    expect(areas[0].attrs).toMatch(/id="fb-body"/);
    // #1889's optional title is gone on purpose: the title is worked out from
    // the message (below), so nobody is asked to write one.
    for (const src of sources) expect(src).not.toMatch(/id="fb-title"|setTitle\b/);
  });

  it("keeps the one other text field, the contact, inside the folded section", () => {
    const textInputs = [dialog, kinds, details, shots].flatMap(src =>
      openTags(src, ["input"]).filter(tag => /type="text"|type="email"/.test(tag.attrs)));
    expect(textInputs.map(tag => /id="fb-contact"/.test(tag.attrs))).toEqual([true]);
    expect(openTags(details, ["input"]).some(tag => /id="fb-contact"/.test(tag.attrs))).toBe(true);
    // Folded when the dialog opens.
    expect(dialog).toMatch(/const \[detailsOpen, setDetailsOpen\] = useState\(false\);/);
  });

  it("folds the section to nothing — no height, no tab stop, nothing read — until it is opened", () => {
    expect(value(".fb-details", "grid-template-rows")).toBe("0fr");
    expect(value(".fb-details[data-open]", "grid-template-rows")).toBe("1fr");
    expect(value(".fb-details-clip", "overflow")).toBe("hidden");
    // visibility, not opacity alone: hidden is out of the tab order and the
    // accessibility tree; transparent is neither.
    expect(value(".fb-details-body", "visibility")).toBe("hidden");
    expect(value(".fb-details[data-open] .fb-details-body", "visibility")).toBe("visible");
    expect(details).toMatch(/data-open=\{open \|\| undefined\}/);
  });

  it("has no privacy well, no cards and no starters left in the markup or the sheet", () => {
    for (const gone of ["fb-note", "fb-kind-hint", "fb-kind-name", "fb-kind-check", "fb-starter", "fb-receipt", "fb-label-row"]) {
      expect([dialog, kinds, details, shots].some(src => src.includes(gone)), `markup still draws .${gone}`).toBe(false);
      expect(sheet.includes(`.${gone}`), `the sheet still styles .${gone}`).toBe(false);
    }
    // Where a report goes is said once, in the folded section, not before Send.
    expect(dialog).not.toMatch(/WHERE_IT_GOES/);
    expect(details).toMatch(/\{WHERE_IT_GOES\.map\(line => <p key=\{line\}>\{line\}<\/p>\)\}/);
  });

  it("opens with the caret in the message", () => {
    expect(dialog).toMatch(/useModalDismiss\(onClose, \{ focusRef: bodyRef \}\)/);
    expect(flatDialog).toMatch(/<textarea ref=\{bodyRef\} id="fb-body"/);
  });

  it("fits a typical window without scrolling, and well inside the 450px the brief aims at", () => {
    // Summed from the sheet's own numbers, for the state the dialog opens in:
    // no image, the details folded, no error. The header's content is the 24px
    // close button's box less the margins that pull it into the title's line.
    const head = 2 * px(value(".modal-head", "padding").split(" ")[0]) + 24 + 1;
    const bodyPad = 2 * px(value(".modal-body", "padding"));
    const gap = px(value(".modal-body.fb-body", "gap"));
    const kindsRow = px(value(".fb-kind", "min-height")) + 2 * px(value(".fb-kinds", "padding"));
    const inner = px(value(".fb-compose", "gap"));
    const compose = px(value(".fb-label", "line-height")) + inner + px(value(".ap-manage-input.fb-message", "min-height"))
      + inner + px(value(".fb-tool", "min-height")) + px(value(".fb-tools", "margin").split(" ")[0]);
    const factsLine = px(value(".fb-facts", "line-height"));
    const foot = px(value(".fb-foot", "padding").split(" ")[2]) + 30;
    const total = head + bodyPad + kindsRow + gap + compose + gap + factsLine + foot;
    expect(total).toBeLessThanOrEqual(400);
    // The modal may be 82vh tall before its body scrolls; at a 1280×720 window
    // that is 590px, and the default state is far inside it.
    expect(total).toBeLessThan(0.82 * 720);
    // The message grows with what is typed and stops before it can push Send
    // off a short window.
    expect(value(".ap-manage-input.fb-message", "max-height")).toBe("min(40vh, 320px)");
    expect(value(".modal.feedback-dialog", "width")).toBe("min(540px, 92vw)");
  });
});

describe("the kinds, as one compact control", () => {
  it("keeps the three kinds the API takes, under three short words", () => {
    expect(KINDS.map(k => [k.value, k.label])).toEqual([["bug", "Bug"], ["idea", "Idea"], ["other", "Other"]]);
  });

  it("asks each kind's own question, and begins each message the way that kind does", () => {
    expect(kindCopy("bug").question).toBe("What happened?");
    expect(kindCopy("bug").placeholder).toBe("I was trying to…\nWhat did you expect to happen?");
    expect(kindCopy("idea").question).toBe("What would make ccdeck better?");
    expect(kindCopy("idea").placeholder).toBe("It would be useful if…");
    expect(kindCopy("other").question).toBe("What would you like to tell us?");
    expect(kindCopy("other").placeholder).toBe("Write anything…");
    expect(new Set(KINDS.map(k => k.question)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map(k => k.placeholder)).size).toBe(KINDS.length);
  });

  it("draws the question and the placeholder from the kind that is chosen", () => {
    expect(dialog).toMatch(/const copy = kindCopy\(kind\);/);
    expect(flatDialog).toMatch(/<label className="fb-label" htmlFor="fb-body">\{copy\.question\}<\/label>/);
    expect(flatDialog).toMatch(/placeholder=\{copy\.placeholder\}/);
  });

  it("is native radios in one named group, so the arrows walk them and Tab stops once", () => {
    expect(flat(kinds)).toMatch(/<fieldset className="fb-kinds"> <legend className="vis-hidden">Kind of feedback<\/legend>/);
    expect(flat(kinds)).toMatch(/<input type="radio" name="feedback-kind" value=\{option\.value\} checked=\{kind === option\.value\}/);
    expect(flatDialog).toMatch(/<FeedbackKinds kind=\{kind\} onChange=\{setKind\} \/>/);
  });

  it("is a track of words, not a row of cards, and marks the chosen one with an edge", () => {
    expect(value(".fb-kinds", "display")).toBe("inline-flex");
    expect(value(".fb-kinds", "background")).toBe("var(--ctl-fill)");
    expect(value(".fb-kind", "min-height")).toBe("24px");
    expect(value(".fb-kind", "border")).toMatch(/transparent/);
    expect(value(".fb-kind:has(input:checked)", "border-color")).toBe("var(--ctl-edge)");
  });

  it("changes the question and nothing else, so what was typed stays", () => {
    // The message is the dialog's state, keyed to nothing the kind changes. It
    // opens on the kept draft's message when there is one, and on the seed's
    // otherwise (feedback-draft-kept.test.ts runs that).
    expect(dialog).toMatch(/const \[body, setBody\] = useState\(kept\?\.body \?\? seed\.body\);/);
    expect(kinds).not.toMatch(/setBody|body/);
  });
});

describe("the title is worked out, never asked for", () => {
  it("takes the first line, and the first sentence of it, without the full stop", () => {
    expect(titleFromBody("The done chime is loud at night.")).toBe("The done chime is loud at night");
    expect(titleFromBody("The chime is loud. At night it wakes the house.")).toBe("The chime is loud");
    expect(titleFromBody("Usage panel is empty\nIt was fine yesterday.")).toBe("Usage panel is empty");
    // A question or three dots say something a full stop does not.
    expect(titleFromBody("Can the chime be quieter? It is loud.")).toBe("Can the chime be quieter?");
    expect(titleFromBody("It hangs...")).toBe("It hangs...");
    // A dot inside a word is not the end of a sentence.
    expect(titleFromBody("v3.36.0 blanks the canvas")).toBe("v3.36.0 blanks the canvas");
  });

  it("skips the blank lines and spaces a message starts with, and folds runs of spaces", () => {
    expect(titleFromBody("\n\n   The   chime\tis loud  \nmore")).toBe("The chime is loud");
  });

  it("reaches past a first line too short to be a title", () => {
    expect(titleFromBody("Hi.\nThe chime is loud at night.")).toBe("Hi. The chime is loud at night.");
    expect(titleFromBody("   ")).toBe("");
  });

  it("cuts a long first line at a word, inside the API's 120, and says it was cut", () => {
    const long = "When I switch accounts while a session is waiting on a permission prompt the whole canvas "
      + "redraws and the waiting card jumps to the bottom of the list, which is the opposite of what it should do";
    const title = titleFromBody(long);
    expect(TITLE_MAX).toBe(120);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.length).toBeGreaterThan(TITLE_MAX / 2);
    expect(title.endsWith("…")).toBe(true);
    const kept = title.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("cuts a single word longer than the limit where it stands, never in half a character", () => {
    expect(titleFromBody("x".repeat(300))).toBe(`${"x".repeat(TITLE_MAX - 1)}…`);
    const emoji = titleFromBody("a".repeat(TITLE_MAX - 2) + "😀".repeat(10));
    expect(emoji.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("names a message too short to name itself after its kind, rather than asking for more words", () => {
    // #1889 refused "ok" with "Say a little more: three characters or more" —
    // a rule that existed only for the API's three-character title. Dropped on
    // purpose: what still guards the API is that every title sent is 3 or more.
    expect(TITLE_MIN).toBe(3);
    expect(feedbackTitle("bug", "ok")).toBe("Bug: ok");
    expect(feedbackTitle("idea", "👍")).toBe("Idea: 👍");
    expect(feedbackTitle("other", "  x  ")).toBe("Other: x");
    expect(feedbackTitle("bug", "The chime is loud.")).toBe("The chime is loud");
    for (const body of ["ok", "a", "👍", "Hi.", "The chime is loud.", "x".repeat(500)]) {
      for (const kind of ["bug", "idea", "other"] as const) {
        const title = feedbackTitle(kind, body);
        expect(title.length, `${kind} "${body}"`).toBeGreaterThanOrEqual(TITLE_MIN);
        expect(title.length, `${kind} "${body}"`).toBeLessThanOrEqual(TITLE_MAX);
      }
    }
  });

  it("posts the worked-out title, both texts trimmed, and no contact when none was given", () => {
    expect(fieldsToSend({ kind: "idea", body: "  A quieter chime.\nAt night.  ", contact: " bob@example.org " }))
      .toEqual({ kind: "idea", title: "A quieter chime", body: "A quieter chime.\nAt night.", contact: "bob@example.org" });
    expect(fieldsToSend({ kind: "bug", body: "ok", contact: "   " })).toEqual({ kind: "bug", title: "Bug: ok", body: "ok" });
    expect("contact" in fieldsToSend({ kind: "bug", body: "ok", contact: "" })).toBe(false);
    expect(sendHook).toMatch(/feedbackRequest\(fieldsToSend\(draft\), attached\)/);
    expect(dialog).toMatch(/void send\(\{ kind, body, contact \}\);/);
  });
});

describe("what Send needs: a message, and nothing else", () => {
  it("sends anything with a character in it, and nothing that is only spaces", () => {
    expect(hasMessage("ok")).toBe(true);
    expect(hasMessage("👍")).toBe(true);
    expect(hasMessage("  \n\t ")).toBe(false);
    expect(hasMessage("")).toBe(false);
  });

  it("says what is missing beside the message, moves there, and sends nothing", () => {
    expect(MESSAGE_MISSING).toBe("Write something first.");
    const submit = flatDialog.slice(flatDialog.indexOf("function submit("), flatDialog.indexOf("void send("));
    expect(submit).toMatch(/if \(!hasMessage\(body\)\) \{ setTriedToSend\(true\); bodyRef\.current\?\.focus\(\); return; \}/);
    expect(dialog).toMatch(/const bodyMissing = triedToSend && !hasMessage\(body\);/);
    // Described by the line while it shows, joined with the one other line
    // that can describe the message (a reload's lost screenshots).
    expect(flatDialog).toMatch(/const messageDescribedBy = \[bodyMissing && "fb-body-error", imagesLostShown && "fb-images-lost"\] \.filter\(Boolean\)\.join\(" "\) \|\| undefined;/);
    expect(flatDialog).toMatch(/aria-describedby=\{messageDescribedBy\}/);
    // Outside the label, so it is read once, as the description.
    expect(flatDialog).toMatch(/\{bodyMissing && <p id="fb-body-error" className="fb-error">\{MESSAGE_MISSING\}<\/p>\}/);
  });
});

describe("Send feedback is never greyed out, and never drops focus (#518)", () => {
  it("says what it does", () => {
    expect(flatDialog).toMatch(/<span className="fb-send-idle">Send feedback<\/span>/);
    expect(flatDialog).toMatch(/<button type="button" className="btn" onClick=\{onClose\}>Cancel<\/button>/);
    // Cancel before Send, the quieter of the two.
    expect(flatDialog.indexOf(">Cancel<")).toBeLessThan(flatDialog.indexOf('"fb-send-idle">Send feedback'));
  });

  it("has no `disabled` anywhere in the dialog", () => {
    for (const src of [dialog, kinds, details, shots]) expect(src).not.toMatch(/disabled=\{/);
  });

  it("says aria-busy while the request is out, and refuses a second press itself", () => {
    expect(flatDialog).toMatch(/<button ref=\{sendRef\} type="submit" className="btn primary fb-send"[^>]*\{\.\.\.selfPressProps\(sending\)\}/);
    expect(sendHook).toMatch(/if \(!selfPressAccepted\(sendingRef\.current\)\) return;/);
    expect(flatDialog).toMatch(/<span className="fb-send-busy">Sending…<\/span>/);
  });

  it("holds its width while it says Sending…, so Cancel never moves under the pointer", () => {
    // Both words in one grid cell, one hidden by visibility — which also keeps
    // it out of the button's name.
    expect(value(".fb-send-label", "display")).toBe("grid");
    expect(value(".fb-send-busy", "visibility")).toBe("hidden");
    expect(value('.fb-send[aria-busy="true"] .fb-send-idle', "visibility")).toBe("hidden");
    expect(value('.fb-send[aria-busy="true"] .fb-send-busy', "visibility")).toBe("visible");
  });
});

describe("the keyboard", () => {
  it("sends on ⌘+Enter or Ctrl+Enter, on every platform", () => {
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true);
  });

  it("leaves a bare Enter to the message's new line, and other chords alone", () => {
    expect(isSendShortcut(key({}))).toBe(false);
    expect(isSendShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSendShortcut(key({ key: "s", metaKey: true }))).toBe(false);
    // Nothing on the message itself listens for Enter: a newline is its own.
    const area = openTags(dialog, ["textarea"])[0];
    expect(area.attrs).not.toMatch(/onKeyDown/);
  });

  it("never sends on the Enter that commits an input method's characters", () => {
    expect(isSendShortcut(key({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isPlainEnter(key({ isComposing: true }))).toBe(false);
  });

  it("submits through the form, so the shortcut and the button are one path", () => {
    expect(flatDialog).toMatch(/onKeyDown=\{e => \{ if \(!isSendShortcut\(e\.nativeEvent\)\) return; e\.preventDefault\(\); e\.currentTarget\.requestSubmit\(\); \}\}/);
    expect(flatDialog).toMatch(/aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
  });

  it("keeps a bare Enter in the contact field from sending, as a one-line field otherwise would", () => {
    expect(isPlainEnter(key({}))).toBe(true);
    expect(isPlainEnter(key({ metaKey: true }))).toBe(false);
    expect(isPlainEnter(key({ shiftKey: true }))).toBe(false);
    expect(flatDetails).toMatch(/onKeyDown=\{e => \{ if \(isPlainEnter\(e\.nativeEvent\)\) e\.preventDefault\(\); \}\}/);
  });

  it("names the chord this platform's keyboard says, ⌘ drawn as tall as the word beside it", () => {
    expect(sendShortcutCaps("MacIntel")).toEqual(["⌘", "Enter"]);
    expect(sendShortcutCaps("Win32")).toEqual(["Ctrl", "Enter"]);
    expect(sendShortcutCaps("")).toEqual(["Ctrl", "Enter"]);
    expect(isSymbolCap("⌘")).toBe(true);
    expect(isSymbolCap("Ctrl")).toBe(false);
    expect(flatDialog).toMatch(/<kbd data-symbol=\{isSymbolCap\(capA\) \|\| undefined\}>\{capA\}<\/kbd><kbd>\{capB\}<\/kbd> to send/);
  });
});

describe("Add details", () => {
  it("is a disclosure button naming the region it opens", () => {
    expect(ADD_DETAILS).toBe("Add details");
    expect(flatDetails).toMatch(/<button type="button" className="fb-tool fb-more" aria-expanded=\{open\} aria-controls=\{DETAILS_ID\} onClick=\{onToggle\}>/);
    expect(flatDetails).toMatch(/<div id=\{DETAILS_ID\} className="fb-details" data-open=\{open \|\| undefined\}>/);
    expect(flatDialog).toMatch(/<DetailsToggle open=\{detailsOpen\} onToggle=\{\(\) => setDetailsOpen\(open => !open\)\} \/>/);
  });

  it("keeps what was typed across folding and unfolding: always drawn, its value held by the dialog", () => {
    expect(dialog).toMatch(/const \[contact, setContact\] = useState\(kept\?\.contact \?\? ""\);/);
    expect(flatDialog).toMatch(/<FeedbackDetails open=\{detailsOpen\} contact=\{contact\} onContact=\{setContact\} \/>/);
    // Never mounted on a condition, which would throw the field away.
    expect(flatDialog).not.toMatch(/detailsOpen &&/);
    expect(flatDetails).toMatch(/value=\{contact\}/);
    // And the message is not inside it, so folding it cannot touch the message.
    expect(details).not.toMatch(/fb-body/);
  });

  it("asks for a way back, optional, at the API's 200, and says why", () => {
    expect(CONTACT_LABEL).toBe("How to reach you");
    expect(CONTACT_PLACEHOLDER).toBe("Email or GitHub @name");
    expect(CONTACT_HINT).toBe("Only if you would like an answer.");
    expect(CONTACT_MAX).toBe(200);
    expect(flatDetails).toMatch(/\{CONTACT_LABEL\} <span className="fb-optional">optional<\/span>/);
    expect(flatDetails).toMatch(/maxLength=\{CONTACT_MAX\}/);
  });

  it("says where a report goes and what may become of it, without a promise it cannot keep", () => {
    // True today: a report is only stored; the people who make ccdeck read it
    // and may open a public issue from it, choosing what it says; the contact
    // and the images are never put on one. Nothing becomes public by being sent.
    expect(WHERE_IT_GOES).toEqual([
      "It all goes to the people who make ccdeck, with the version and system below.",
      "Nothing becomes public by being sent. They may open a public GitHub issue from it, choosing its title and text; your contact and screenshots are never put on one.",
    ]);
  });

  it("unfolds a beat faster than it folds back, and only fades under reduced motion", () => {
    expect(value(".fb-details", "transition")).toMatch(/grid-template-rows 160ms/);
    expect(value(".fb-details[data-open]", "transition-duration")).toBe("220ms");
    const reduced = sheet.slice(sheet.lastIndexOf("@media (prefers-reduced-motion: reduce)", sheet.indexOf(".fb-details-body,\n  .fb-details[data-open] .fb-details-body { transform: none; }")));
    expect(reduced).toMatch(/\.fb-details,\s*\.fb-details\[data-open\] \{ transition: none; \}/);
  });
});

describe("what goes with it, said before Send", () => {
  it("reads the server's answer, and nothing that is not one", () => {
    expect(parseFacts({ ok: true, appVersion: "3.36.0", platform: "darwin-arm64" })).toEqual({ appVersion: "3.36.0", platform: "darwin-arm64" });
    expect(parseFacts(null)).toBeNull();
    expect(parseFacts({ ok: false, appVersion: "3.36.0", platform: "darwin-arm64" })).toBeNull();
    expect(parseFacts({ ok: true, appVersion: 3, platform: "darwin-arm64" })).toBeNull();
    expect(parseFacts({ ok: true, appVersion: "", platform: "" })).toBeNull();
  });

  it("names the system as its owner would, from exactly what is sent", () => {
    expect(systemLabel("darwin-arm64")).toBe("macOS · arm64");
    expect(systemLabel("win32-x64")).toBe("Windows · x64");
    expect(systemLabel("linux-x64")).toBe("Linux · x64");
    expect(systemLabel("freebsd-x64")).toBe("freebsd · x64");
    expect(systemLabel("darwin")).toBe("macOS");
  });

  it("draws one quiet line: the version and system, or the same words without them", () => {
    expect(factsLabel({ appVersion: "3.36.0", platform: "darwin-arm64" })).toBe("ccdeck 3.36.0 · macOS · arm64");
    expect(factsLabel(null)).toBeNull();
    expect(FACTS_SUFFIX).toBe("sent with it");
    expect(FACTS_UNKNOWN).toBe("Your ccdeck version and system are sent with it.");
    expect(flatDialog).toMatch(/const facts = factsLabel\(useFeedbackFacts\(\)\);/);
    expect(flatDialog).toMatch(/<p className="fb-facts"> \{facts \? <><span className="fb-facts-value">\{facts\}<\/span> — \{FACTS_SUFFIX\}<\/> : FACTS_UNKNOWN\} <\/p>/);
  });

  it("asks the deck's own server, which answers from the function that attaches them", () => {
    expect(flat(factsHook)).toMatch(/fetch\("\/api\/feedback"\) \.then\(r => \(r\.ok \? r\.json\(\) : null\)\)/);
    // The page sends neither: the post carries the message alone, and the
    // server adds the two (reports-1853.test.ts pins that side).
    expect(sendHook).not.toMatch(/appVersion|platform/);
  });

  it("writes ccdeck the way the product does, lower-case, everywhere it says the name", () => {
    const words = [...KINDS.flatMap(k => [k.label, k.question, k.placeholder]), ...WHERE_IT_GOES, FACTS_UNKNOWN,
      factsLabel({ appVersion: "1", platform: "darwin-arm64" })!, SENT_LINE, CONTACT_HINT, MESSAGE_MISSING];
    for (const w of words) {
      expect(w, w).not.toMatch(/CCDeck|Ccdeck/);
      // The brand's voice rules (PRODUCT.md).
      expect(w, w).not.toMatch(/!|\bsimply\b|\bjust\b/i);
    }
  });
});

describe("once it is sent", () => {
  it("announces through a live region that is there before anything is sent", () => {
    expect(outcomeAnnouncement("idle")).toBe("");
    expect(outcomeAnnouncement("failed")).toBe("");
    expect(outcomeAnnouncement("sending")).toBe("Sending…");
    expect(outcomeAnnouncement("sent")).toBe(SENT_LINE);
    // The same region says what an armed Discard will do while it is armed
    // (feedback-draft-kept.test.ts), and the outcome otherwise.
    const region = dialog.indexOf('<p className="vis-hidden" role="status">{discard.armed ? DISCARD_ARMED_TITLE : outcomeAnnouncement(outcome.state)}</p>');
    expect(region, "no persistent live region").toBeGreaterThan(-1);
    expect(region).toBeLessThan(dialog.indexOf("{sent && ("));
  });

  it("thanks, briefly, over the form at the form's own size", () => {
    expect(SENT_LINE).toBe("Thanks — feedback sent.");
    expect(flatDialog).toMatch(/\{sent && \( <div className="fb-done"> <SuccessMark \/> <p className="fb-done-line">\{SENT_LINE\}<\/p> <\/div> \)\}/);
    expect(value(".fb-done", "position")).toBe("absolute");
    expect(value(".fb-done", "inset")).toBe("0");
    expect(value(".fb-stage", "position")).toBe("relative");
  });

  it("takes the form out of reach under it, and puts focus on the × that outlives it (#1762)", () => {
    const effect = flatDialog.slice(flatDialog.indexOf("useEffect(() => { const form = formRef.current;"), flatDialog.indexOf("}, [sent]);"));
    expect(effect).toMatch(/const held = form\.contains\(document\.activeElement\) \|\| focusDropped\(document\.activeElement\?\.tagName \?\? null\);/);
    expect(effect).toMatch(/form\.inert = sent;/);
    expect(effect).toMatch(/if \(sent && held\) closeRef\.current\?\.focus\(\);/);
    expect(flatDialog).toMatch(/<button ref=\{closeRef\} type="button" className="glyph-btn" onClick=\{onClose\} aria-label="Close \(Esc\)"/);
  });

  it("closes itself after a moment, fading out faster than anything arrived", () => {
    expect(SENT_HOLD_MS).toBeGreaterThanOrEqual(1000);
    expect(SENT_HOLD_MS).toBeLessThanOrEqual(2000);
    expect(SENT_EXIT_MS).toBeLessThan(200);
    expect(flat(sendHook)).toMatch(/const fade = window\.setTimeout\(\(\) => setLeaving\(true\), SENT_HOLD_MS\);/);
    expect(flat(sendHook)).toMatch(/const close = window\.setTimeout\(\(\) => onCloseRef\.current\(\), SENT_HOLD_MS \+ SENT_EXIT_MS\);/);
    // Both timers go with the dialog, so one closed by hand is not closed twice.
    expect(flat(sendHook)).toMatch(/return \(\) => \{ window\.clearTimeout\(fade\); window\.clearTimeout\(close\); \};/);
    expect(dialog).toMatch(/const leaving = useCloseWhenSent\(sent, onClose\);/);
    expect(flatDialog).toMatch(/data-leaving=\{leaving \|\| undefined\}/);
    expect(value(".modal-backdrop[data-leaving]", "transition")).toBe(`opacity ${SENT_EXIT_MS}ms ease-out`);
    expect(value(".modal-backdrop[data-leaving]", "opacity")).toBe("0");
  });

  it("says what went wrong and keeps every word when it did not arrive", () => {
    expect(flatDialog).toMatch(/\{outcome\.state === "failed" && <p className="fb-error" role="alert">\{outcome\.message\}<\/p>\}/);
    expect(feedbackFailure(400, "invalid", {})).toBe("The server did not accept the message. It is still here; check it and send again.");
    expect(feedbackFailure(502, "unavailable")).toMatch(/your text is still here/);
    expect(feedbackFailure(0, null)).toMatch(/Nothing was sent/);
  });
});

// ── the design pass (2026-10-07) ────────────────────────────────────────────

describe("the design pass: what each state shows, and where Send stays", () => {
  it("keeps Send under the pointer that pressed it when a send fails", () => {
    // The dialog is centred, so it grows about its middle and Send moves half
    // of whatever it grows by. The failure the reader answers by pressing Send
    // again sits 6px under the facts line, on one line, so Send moves 11px —
    // inside its own 30px height, and a second press lands on it.
    const gap = px(value(".modal-body.fb-body", "gap")) + px(value(".fb-facts + .fb-error", "margin-top"));
    expect(gap).toBe(6);
    const grows = gap + px(value(".fb-error", "line-height"));
    expect(grows / 2).toBeLessThan(30 / 2);
    // One line at the dialog's 508px measure: about six pixels a character
    // at 12px. The words that matter stay — nothing went, and the text is
    // still in the field.
    const unreachable = feedbackFailure(0, null);
    expect(unreachable).toBe("ccdeck's server could not be reached. Nothing was sent; your text is still here.");
    expect(unreachable.length).toBeLessThanOrEqual(82);
  });

  it("shows how long an armed Discard stays armed, the way the accounts panel does", async () => {
    const { DISCARD_ARMED_MS } = await import("../use-feedback-draft");
    expect(value(".fb-foot .btn.danger.armed::after", "animation")).toBe(`ap-disarm ${DISCARD_ARMED_MS}ms linear forwards`);
    expect(value(".fb-foot .btn.danger.armed", "overflow")).toBe("hidden");
    // Under reduced motion the fill and the words stay and the bar does not travel.
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.fb-foot \.btn\.danger\.armed::after \{ animation: none; transform: scaleX\(0\); \}/);
  });

  it("marks a message sent empty with its edge as well as its line", () => {
    expect(value('.ap-manage-input.fb-message[aria-invalid="true"]', "border-color")).toBe("var(--err)");
  });

  it("draws each image's edge as the control it is, with its count beside it", () => {
    expect(value(".fb-shot-img", "border")).toBe("1px solid var(--ctl-edge)");
    expect(value(".fb-shot-pick:hover .fb-shot-img", "border-color")).toBe("var(--text)");
    expect(/\.fb-shots-count \{([^}]*)\}/.exec(sheet)?.[1]).not.toMatch(/margin-left/);
  });

  it("sets the facts line nearer Send than the buttons above it", () => {
    expect(px(value(".modal-body.fb-body", "padding-bottom"))).toBeLessThan(px(value(".modal-body.fb-body", "gap")));
  });

  it("gives a fingertip the deck's 32px floor on every small control in the dialog", () => {
    expect(sheet).toMatch(/@media \(pointer: coarse\) \{[^@]*\.fb-kind,\s*\.fb-tool,\s*\.fb-foot \.btn \{ min-height: 32px; \}/);
    expect(sheet).toMatch(/@media \(pointer: coarse\) \{[^@]*\.fb-shot > \.fb-shot-remove::after \{ inset: -6px; \}/);
  });
});
