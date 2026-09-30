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
// Plain node, no renderer — the suite cannot draw React (see
// topbar-interaction.test.ts) — so the rules are exercised through the pure
// functions the dialog exports and the wiring is read off the source, the way
// visible-feedback-1853.test.ts reads the rest of this dialog.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KINDS, kindCopy, missingFields, isSendShortcut, isPlainEnter, sendShortcutCaps, isSymbolCap,
  outcomeAnnouncement, TITLE_MIN, TITLE_MISSING, type EnterKey,
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
    const words = KINDS.flatMap(k => [k.label, k.hint, k.titlePlaceholder, k.bodyLabel, k.bodyPlaceholder, k.bodyMissing]);
    for (const w of [...words, TITLE_MISSING]) expect(w, w).not.toMatch(/!|\bsimply\b|\bjust\b/i);
  });

  it("draws the body's label and both placeholders from the kind that is chosen", () => {
    expect(source).toMatch(/const copy = kindCopy\(kind\)/);
    expect(source).toMatch(/htmlFor="fb-body">\{copy\.bodyLabel\}</);
    expect(source).toMatch(/placeholder=\{copy\.bodyPlaceholder\}/);
    expect(source).toMatch(/placeholder=\{copy\.titlePlaceholder\}/);
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
  it("needs a title of at least three characters and a body that is not blank", () => {
    expect(TITLE_MIN).toBe(3);
    expect(missingFields("", "")).toEqual(["title", "body"]);
    expect(missingFields("ab", "it broke")).toEqual(["title"]);
    expect(missingFields("abc", "")).toEqual(["body"]);
    expect(missingFields("abc", "x")).toEqual([]);
  });

  it("trims before it counts, so spaces and blank lines are not a title or a body", () => {
    expect(missingFields("   ab   ", "x")).toEqual(["title"]);
    expect(missingFields("  abc  ", " \n\t ")).toEqual(["body"]);
  });

  it("lists the title first, because that is where focus goes", () => {
    expect(missingFields("", "")[0]).toBe("title");
    expect(source).toMatch(/\(missing\[0\] === "title" \? titleRef : bodyRef\)\.current\?\.focus\(\)/);
  });

  it("names what is missing beside its field, outside the label so it is read once", () => {
    expect(flat).toMatch(/aria-describedby=\{titleMissing \? "fb-title-error" : undefined\}/);
    expect(flat).toMatch(/aria-describedby=\{bodyMissing \? "fb-body-error" : undefined\}/);
    expect(flat).toMatch(/<\/label> <input ref=\{titleRef\}/);
    expect(flat).toMatch(/\{titleMissing && <p id="fb-title-error" className="fb-error">\{TITLE_MISSING\}<\/p>\}/);
    expect(flat).toMatch(/\{bodyMissing && <p id="fb-body-error" className="fb-error">\{copy\.bodyMissing\}<\/p>\}/);
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

  it("moves from the title to the body on Enter rather than submitting half a form", () => {
    expect(flat).toMatch(/if \(!isPlainEnter\(e\.nativeEvent\)\) return; e\.preventDefault\(\); bodyRef\.current\?\.focus\(\);/);
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
    expect(flat).toMatch(/<p className="fb-receipt"> <KindGlyph kind=\{kind\} \/> <span>\{title\.trim\(\)\}<\/span> <\/p>/);
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
