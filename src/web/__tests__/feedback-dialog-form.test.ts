// The feedback dialog's form, after its polish pass (#1853's dialog).
//
// It was three plain radios over three fields, one body label hedging across
// every kind ("What happened, or what you would like"), and a Send that sat
// greyed out until the title and the body were filled — which said "not yet"
// without saying why, and read as broken. It also broke the press rule (#518):
// Send's `disabled` covered the request in flight, so the focused button went
// disabled under the reader and Chrome dropped focus to <body>; and when the
// answer came back the form unmounted with focus in it, and the thank-you was a
// role="status" created in the same render as its text, which a screen reader
// is not guaranteed to announce.
//
// Now: the kinds are cards with a line each, the body asks what that kind needs,
// Send is always pressable and names what is missing beside the field, ⌘/Ctrl+
// Enter sends, a bare Enter in the title moves on to the body, and a sent form
// hands focus to Close while a live region drawn from the first render says so.
//
// Then lighter (the owner, on the result): a required title over a required
// body read as a chore before a word was typed. The message is the one thing
// it asks for now. It comes first and takes focus; the title moved under it,
// optional, and left empty it is the message's own first line or sentence,
// shown in the empty field as it is typed. Starters over the message put a
// sentence's first words down for a person who does not know how to begin.
// The API's contract did not move: it still gets a title of 3 to 120.
//
// Plain node, no renderer — the suite cannot draw React (see
// topbar-interaction.test.ts) — so the rules are exercised through the pure
// functions the dialog exports and the wiring is read off the source, the way
// visible-feedback-1853.test.ts reads the rest of this dialog.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KINDS, kindCopy, missingFields, isSendShortcut, isPlainEnter, sendShortcutCaps, isSymbolCap,
  outcomeAnnouncement, titleFromBody, titleToSend, starterEdit, withStarter, hasWriting,
  TITLE_MIN, TITLE_MAX, TITLE_MISSING, TITLE_HINT, BODY_SHORT, type EnterKey,
} from "../components/FeedbackDialog";
import { withoutComments } from "./tsx-scan";

const raw = readFileSync(fileURLToPath(new URL("../components/FeedbackDialog.tsx", import.meta.url)), "utf8");
const source = withoutComments(raw);
/** JSX text flows across lines; the words are what is pinned, not the wrap. */
const flat = source.replace(/\s+/g, " ");

const key = (over: Partial<EnterKey>): EnterKey =>
  ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });

describe("each kind asks its own question", () => {
  it("keeps the three kinds, in their order, under the names they always had", () => {
    expect(KINDS.map(k => [k.value, k.label])).toEqual([
      ["bug", "Something is wrong"],
      ["idea", "An idea"],
      ["other", "Something else"],
    ]);
  });

  it("splits the old hedged body label into the question each kind needs", () => {
    // "What happened, or what you would like" was one label for all three.
    expect(kindCopy("bug").bodyLabel).toBe("What went wrong");
    expect(kindCopy("idea").bodyLabel).toBe("What you would like");
    expect(new Set(KINDS.map(k => k.bodyLabel)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map(k => k.bodyPlaceholder)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map(k => k.titlePlaceholder)).size).toBe(KINDS.length);
  });

  it("gives every kind a one-line hint with no full stop, and placeholders that trail off", () => {
    for (const k of KINDS) {
      expect(k.hint.length, k.value).toBeGreaterThan(0);
      expect(k.hint, k.value).not.toMatch(/[.!]$/);
      expect(k.titlePlaceholder, k.value).toMatch(/…$/);
      expect(k.bodyPlaceholder, k.value).toMatch(/…$/);
      expect(k.bodyMissing, k.value).toMatch(/\.$/);
    }
  });

  it("says nothing with an exclamation mark, a 'simply' or a 'just'", () => {
    // The brand's voice rules (PRODUCT.md), over every word the table adds.
    const words = KINDS.flatMap(k => [k.label, k.hint, k.titlePlaceholder, k.bodyLabel, k.bodyPlaceholder, k.bodyMissing, ...k.starters]);
    for (const w of [...words, TITLE_MISSING, TITLE_HINT, BODY_SHORT]) expect(w, w).not.toMatch(/!|\bsimply\b|\bjust\b/i);
  });

  it("draws the body's label and both placeholders from the kind that is chosen", () => {
    expect(source).toMatch(/const copy = kindCopy\(kind\)/);
    expect(source).toMatch(/htmlFor="fb-body">\{copy\.bodyLabel\}</);
    expect(source).toMatch(/placeholder=\{copy\.bodyPlaceholder\}/);
    // The title's is the kind's until the message can name itself, and then
    // it is that name (pinned under "the title is optional" below).
    expect(source).toMatch(/placeholder=\{derivedTitle\.length >= TITLE_MIN \? derivedTitle : copy\.titlePlaceholder\}/);
  });

  it("names each radio by its name alone and describes it by its hint, so the hint is read once", () => {
    // The <label> round the card holds both; without aria-labelledby the hint
    // joined the name and was read twice, once in it and once as description.
    expect(source).toMatch(/aria-labelledby=\{`fb-kind-name-\$\{option\.value\}`\}/);
    expect(source).toMatch(/id=\{`fb-kind-name-\$\{option\.value\}`\} className="fb-kind-name"/);
    expect(source).toMatch(/aria-describedby=\{`fb-kind-hint-\$\{option\.value\}`\}/);
    expect(source).toMatch(/id=\{`fb-kind-hint-\$\{option\.value\}`\} className="fb-kind-hint"/);
    // Still native radios in one named group, so the arrows walk them.
    expect(source).toMatch(/type="radio"\s+name="feedback-kind"/);
  });
});

describe("what Send cannot go without", () => {
  // It was a title of three or more AND a body, both required; the title is
  // optional now, so the old ["title", "body"] for an empty form is gone on
  // purpose. What still guards the API's three-character title is the rule
  // below: a title typed or derived, never one under three.
  it("needs only the message: a body that is not blank sends with no title", () => {
    expect(TITLE_MIN).toBe(3);
    expect(missingFields("", "")).toEqual(["body"]);
    expect(missingFields("", "it broke")).toEqual([]);
    expect(missingFields("abc", "")).toEqual(["body"]);
    expect(missingFields("abc", "x")).toEqual([]);
  });

  it("holds a typed title to three characters, and a message with no title to one that can name itself", () => {
    // Typed, the title is used as typed, so two characters is two too few.
    expect(missingFields("ab", "it broke")).toEqual(["title"]);
    // Not typed, the message has to be able to give three.
    expect(missingFields("", "ok")).toEqual(["body"]);
    expect(missingFields("", "ok?")).toEqual([]);
    // A typed title carries a message too short to name itself.
    expect(missingFields("Chime", "ok")).toEqual([]);
    // Both wrong: the message first, where focus goes.
    expect(missingFields("ab", "")).toEqual(["body", "title"]);
  });

  it("trims before it counts, so spaces and blank lines are not a title or a body", () => {
    expect(missingFields("   ab   ", "it broke")).toEqual(["title"]);
    expect(missingFields("  abc  ", " \n\t ")).toEqual(["body"]);
    // A title of spaces is no title: the message names itself.
    expect(missingFields("     ", "The chime is loud")).toEqual([]);
    expect(missingFields("     ", "ok")).toEqual(["body"]);
  });

  it("lists the message first, because that is where focus goes", () => {
    expect(missingFields("ab", "")[0]).toBe("body");
    expect(source).toMatch(/\(missing\[0\] === "body" \? bodyRef : titleRef\)\.current\?\.focus\(\)/);
  });

  it("asks an empty message what the kind asks, and a short one for a little more", () => {
    expect(BODY_SHORT).toMatch(/three characters/);
    expect(source).toMatch(/const bodyError = hasWriting\(body\) \? BODY_SHORT : copy\.bodyMissing;/);
  });

  it("does not count a starter's words on their own as a message", () => {
    // Pressed and left, "It would help if" would go out as its own title.
    expect(hasWriting("It would help if ")).toBe(false);
    expect(hasWriting("I expected\nInstead, it ")).toBe(false);
    expect(missingFields("", "It would help if ")).toEqual(["body"]);
    // A starter from another kind still counts as a starter.
    expect(missingFields("", "It happened when")).toEqual(["body"]);
    // One word added, and it is writing.
    expect(hasWriting("It would help if the chime were quieter")).toBe(true);
    expect(missingFields("", "It would help if the chime were quieter")).toEqual([]);
    // A typed title does not make an unwritten message written.
    expect(missingFields("Quieter chime", "I expected ")).toEqual(["body"]);
    // And the empty title shows the kind's own placeholder until there is writing.
    expect(source).toMatch(/const derivedTitle = hasWriting\(body\) \? titleFromBody\(body\) : "";/);
  });

  it("names what is missing beside its field, outside the label so it is read once", () => {
    expect(flat).toMatch(/aria-describedby=\{titleMissing \? "fb-title-error" : "fb-title-hint"\}/);
    expect(flat).toMatch(/aria-describedby=\{bodyMissing \? "fb-body-error" : undefined\}/);
    // A comment between them reads as `{ }` once comments are stripped.
    expect(flat).toMatch(/<\/label> (?:\{ \} )?<input ref=\{titleRef\}/);
    expect(flat).toMatch(/\{titleMissing \? <p id="fb-title-error" className="fb-error">\{TITLE_MISSING\}<\/p> : <p id="fb-title-hint" className="fb-hint">\{TITLE_HINT\}<\/p>\}/);
    expect(flat).toMatch(/\{bodyMissing && <p id="fb-body-error" className="fb-error">\{bodyError\}<\/p>\}/);
  });
});

describe("the title is optional, and an empty one is the message's own first line", () => {
  it("marks the title optional and says what an empty one becomes, under the field", () => {
    expect(flat).toMatch(/htmlFor="fb-title"> Title <span className="fb-optional">optional<\/span> <\/label>/);
    expect(TITLE_HINT).toBe("Left empty, the first line of your message is used.");
    // No `required` left on the title input.
    const input = source.slice(source.indexOf("ref={titleRef}"), source.indexOf("/>", source.indexOf("ref={titleRef}")));
    expect(input).not.toMatch(/\brequired\b/);
  });

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
    expect(titleFromBody("ok")).toBe("ok");
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
    // At a word: what comes before the ellipsis is a prefix of the message
    // that ends where a word did.
    const kept = title.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("cuts a single word longer than the limit where it stands, never in half a character", () => {
    const title = titleFromBody("x".repeat(300));
    expect(title).toBe(`${"x".repeat(TITLE_MAX - 1)}…`);
    const emoji = titleFromBody("a".repeat(TITLE_MAX - 2) + "😀".repeat(10));
    expect(emoji.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("sends the title typed, trimmed, and otherwise the one the message gives", () => {
    expect(titleToSend("  Quieter chime  ", "The chime is loud.")).toBe("Quieter chime");
    expect(titleToSend("", "The chime is loud.")).toBe("The chime is loud");
    // A whitespace-only title is no title.
    expect(titleToSend(" \t ", "The chime is loud.")).toBe("The chime is loud");
    expect(source).toMatch(/const sentTitle = titleToSend\(title, body\);/);
    expect(flat).toMatch(/JSON\.stringify\(\{ kind, title: sentTitle, body: body\.trim\(\), contact: contact\.trim\(\) \|\| undefined \}\)/);
  });

  it("shows the title that will be sent in the empty field, as the message is typed", () => {
    expect(flat).toMatch(/placeholder=\{derivedTitle\.length >= TITLE_MIN \? derivedTitle : copy\.titlePlaceholder\}/);
  });
});

describe("starters put a sentence's first words down", () => {
  it("offers each kind two or three of its own, with no ellipsis in the words", () => {
    for (const k of KINDS) {
      expect(k.starters.length, k.value).toBeGreaterThanOrEqual(2);
      expect(k.starters.length, k.value).toBeLessThanOrEqual(3);
      for (const w of k.starters) expect(w, w).not.toMatch(/…|\.\.\.|\s$/);
    }
    expect(kindCopy("bug").starters).toEqual(["It happened when", "I expected", "Instead, it"]);
    expect(kindCopy("idea").starters[0]).toBe("It would help if");
  });

  it("fills an empty message with the words and a space, so typing carries straight on", () => {
    expect(withStarter("", "It happened when")).toBe("It happened when ");
    expect(starterEdit("", "I expected")).toEqual({ from: 0, text: "I expected " });
    // A field of spaces holds nothing anybody typed.
    expect(withStarter("  \n ", "I expected")).toBe("I expected ");
  });

  it("never touches what is typed: the words go after it, on a line of their own", () => {
    const typed = "The canvas went blank";
    const next = withStarter(typed, "I expected");
    expect(next.startsWith(typed)).toBe(true);
    expect(next).toBe("The canvas went blank\nI expected ");
    expect(starterEdit(typed, "I expected")).toEqual({ from: typed.length, text: "\nI expected " });
    // Already on a new line: no second one.
    expect(withStarter("The canvas went blank\n", "Instead, it")).toBe("The canvas went blank\nInstead, it ");
    // Trailing spaces are kept, as typed.
    expect(withStarter("It broke  ", "I expected").startsWith("It broke  ")).toBe(true);
  });

  it("are buttons that never submit, grouped and named, drawn from the chosen kind", () => {
    expect(flat).toMatch(/<div className="fb-starters" role="group" aria-label="Start a sentence with">/);
    expect(flat).toMatch(/\{copy\.starters\.map\(starter => \( <button key=\{starter\} type="button" className="fb-starter" onClick=\{\(\) => startWith\(starter\)\}> \{starter\}… <\/button>/);
  });

  it("insert through the field's own editing, so ⌘Z takes a starter back out", () => {
    expect(source).toMatch(/document\.execCommand\("insertText", false, text\)/);
    // Where the browser refuses, the value is set to the same text instead.
    expect(source).toMatch(/if \(!document\.execCommand\("insertText", false, text\)\) setBody\(withStarter\(field\.value, starter\)\);/);
    // The caret goes to the end first, so the words land after what is typed.
    expect(source.indexOf("field.setSelectionRange(from, field.value.length)"))
      .toBeLessThan(source.indexOf('document.execCommand("insertText"'));
  });
});

describe("the message comes first", () => {
  it("takes focus on open, not the title", () => {
    expect(source).toMatch(/useModalDismiss\(onClose, \{ focusRef: bodyRef \}\)/);
  });

  it("draws the message, then the title, then the contact, so Tab walks them in that order", () => {
    const at = (needle: string) => source.indexOf(needle);
    expect(at('id="fb-body"')).toBeGreaterThan(-1);
    expect(at('id="fb-body"')).toBeLessThan(at('id="fb-title"'));
    expect(at('id="fb-title"')).toBeLessThan(at('id="fb-contact"'));
    // The starters sit before the message, one Shift+Tab back from it, so Tab
    // from the message goes straight on to the title.
    expect(at('className="fb-starters"')).toBeLessThan(at('id="fb-body"'));
  });
});

describe("Send is never greyed out, and never drops focus (#518)", () => {
  it("has no `disabled` anywhere in the dialog", () => {
    // It was `disabled={!ready}`, where `ready` folded in the request in flight:
    // pressed, the focused button went disabled and focus fell to <body>.
    expect(source).not.toMatch(/disabled=\{/);
  });

  it("says aria-busy while the request is out and refuses a second press itself", () => {
    expect(source).toMatch(/<button type="submit" className="btn primary fb-send"[^>]*\{\.\.\.selfPressProps\(sending\)\}/);
    expect(source).toMatch(/if \(!selfPressAccepted\(sendingRef\.current\)\) return;/);
    expect(source).toMatch(/\{sending \? "Sending…" : "Send"\}/);
  });
});

describe("the keyboard", () => {
  it("sends on ⌘+Enter or Ctrl+Enter, on every platform", () => {
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true);
  });

  it("leaves a bare Enter to the textarea's new line, and other chords alone", () => {
    expect(isSendShortcut(key({}))).toBe(false);
    expect(isSendShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSendShortcut(key({ key: "s", metaKey: true }))).toBe(false);
  });

  it("never sends on the Enter that commits an input method's characters", () => {
    expect(isSendShortcut(key({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isPlainEnter(key({ isComposing: true }))).toBe(false);
  });

  it("reads a bare Enter as a bare Enter and nothing else", () => {
    expect(isPlainEnter(key({}))).toBe(true);
    expect(isPlainEnter(key({ metaKey: true }))).toBe(false);
    expect(isPlainEnter(key({ ctrlKey: true }))).toBe(false);
    expect(isPlainEnter(key({ shiftKey: true }))).toBe(false);
    expect(isPlainEnter(key({ key: "a" }))).toBe(false);
  });

  it("submits through the form, so the shortcut and the button are one path", () => {
    expect(flat).toMatch(/onKeyDown=\{e => \{ if \(!isSendShortcut\(e\.nativeEvent\)\) return; e\.preventDefault\(\); e\.currentTarget\.requestSubmit\(\); \}\}/);
    expect(flat).toMatch(/aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
  });

  it("moves from the title back to an empty message on Enter rather than submitting half a form", () => {
    // It moved on to the body, which came after it. The body comes first now,
    // so a bare Enter in the title goes back to it only while it is empty;
    // with a message written the form is whole, and Enter is the form's own.
    expect(flat).toMatch(/if \(!isPlainEnter\(e\.nativeEvent\) \|\| body\.trim\(\) !== ""\) return; e\.preventDefault\(\); bodyRef\.current\?\.focus\(\);/);
  });

  it("names the chord this platform's keyboard says", () => {
    expect(sendShortcutCaps("MacIntel")).toEqual(["⌘", "Enter"]);
    expect(sendShortcutCaps("macOS")).toEqual(["⌘", "Enter"]);
    expect(sendShortcutCaps("iPad")).toEqual(["⌘", "Enter"]);
    expect(sendShortcutCaps("Win32")).toEqual(["Ctrl", "Enter"]);
    expect(sendShortcutCaps("Linux x86_64")).toEqual(["Ctrl", "Enter"]);
    expect(sendShortcutCaps("")).toEqual(["Ctrl", "Enter"]);
  });

  it("marks the one-symbol cap, so ⌘ is drawn as tall as the word beside it", () => {
    // In the mono stack ⌘ was a speck beside `Enter`; the marked cap is set in
    // the system face, a size up, in the same box.
    expect(isSymbolCap("⌘")).toBe(true);
    expect(isSymbolCap("Ctrl")).toBe(false);
    expect(isSymbolCap("Enter")).toBe(false);
    expect(flat).toMatch(/<kbd data-symbol=\{isSymbolCap\(capA\) \|\| undefined\}>\{capA\}<\/kbd><kbd>\{capB\}<\/kbd>/);
  });
});

describe("once it is sent", () => {
  it("announces through a live region that is there before anything is sent", () => {
    expect(outcomeAnnouncement("idle")).toBe("");
    expect(outcomeAnnouncement("failed")).toBe("");
    expect(outcomeAnnouncement("sending")).toBe("Sending…");
    expect(outcomeAnnouncement("sent")).toContain("reached the people who make ccdeck");
    const region = source.indexOf('<p className="vis-hidden" role="status">{outcomeAnnouncement(outcome.state)}</p>');
    expect(region, "no persistent live region").toBeGreaterThan(-1);
    // Outside the sent/unsent branch, so it is not created with its own text.
    expect(region).toBeLessThan(source.indexOf('outcome.state === "sent" ?'));
    expect(source).not.toMatch(/className="fb-done" role="status"/);
  });

  it("hands focus to Close when the form it was in goes away", () => {
    expect(source).toMatch(/const armRescue = useFocusRescue\(outcome\.state === "sent", closeRef\)/);
    expect(source).toMatch(/<button ref=\{closeRef\} type="button" className="btn primary" onClick=\{onClose\}>Close<\/button>/);
    // Armed by the press that sends, and only by that one.
    expect(source.indexOf("armRescue();")).toBeGreaterThan(source.indexOf("if (missing.length > 0)"));
    expect(source.indexOf("armRescue();")).toBeLessThan(source.indexOf('setOutcome({ state: "sending" })'));
  });

  it("thanks, says where it went, and shows what went", () => {
    expect(flat).toMatch(/<p className="fb-done-title">Thank you<\/p>/);
    expect(flat).toMatch(/<p className="fb-done-note">It reached the people who make ccdeck\.<\/p>/);
    // The title that was sent, typed or taken from the message — the typed
    // one alone would be an empty receipt now that a title is optional.
    expect(flat).toMatch(/<p className="fb-receipt"> <KindGlyph kind=\{kind\} \/> <span>\{sentTitle\}<\/span> <\/p>/);
  });
});

describe("what it says about where this goes", () => {
  it("keeps the whole promise, word for word, before Send", () => {
    expect(flat).toContain(
      "This goes to the people who make ccdeck, with your ccdeck version and system. They may open a " +
      "public GitHub issue from it; how to reach you is never put there.",
    );
    expect(flat.indexOf("how to reach you is never put there")).toBeLessThan(flat.indexOf('type="submit"'));
  });

  it("still marks how to reach you as optional", () => {
    expect(flat).toMatch(/How to reach you, if you want an answer <span className="fb-optional">optional<\/span>/);
  });
});
