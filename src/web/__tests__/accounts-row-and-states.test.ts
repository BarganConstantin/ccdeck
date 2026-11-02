// What a row says to a screen reader and to a pointer-less reader, what the
// shut fold names, what the panel says when there is no roster, and how the
// Move list answers the keyboard.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import AccountsEmptyState, { plainReason } from "../components/AccountsEmptyState";
import { radioMove } from "../menu-keys";
import { FOLD_PREVIEW, foldPreview, type Peer } from "../other-accounts";
import type { Account } from "../claude-accounts";
import { sheetText } from "./sheet-source";
import { withoutComments } from "./tsx-scan";

const NOW = 1_790_000_000;
const HOUR = 3600;

const account: Account = {
  num: 2, email: "second@example.com", alias: "work", org: null, active: false, disabled: false,
  lanes: [
    { id: "five_hour", label: "5h", pct: 31, resetAt: NOW + 2 * HOUR },
    { id: "seven_day", label: "7d", pct: 62, resetAt: NOW + 50 * HOUR },
  ],
  headroom: 38, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null,
};

const row = (a: Account, opened: boolean) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {},
} as never));

/** The text of the element with this id, tags and all. */
const textOfId = (html: string, id: string) => {
  const m = new RegExp(`<p class="ap-quota" id="${id}">([^]*?)</p>`).exec(html);
  return (m?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
};

describe("the row's main number, for a screen reader", () => {
  it("is said inside the line the door is described by, with its window", () => {
    const html = row(account, false);
    // The door is described by the quota line…
    expect(html).toMatch(/aria-describedby="[^"]*ap-quota-2/);
    // …and the line says the first window as the head draws it, then the others.
    const said = textOfId(html, "ap-quota-2");
    expect(said).toContain("5h 31%");
    expect(said).toContain("7d");
    expect(said).toContain("62%");
    // The copy is for a screen reader only: the head still draws the figure once.
    expect(html).toMatch(/<span class="vis-hidden">5h 31%\. <\/span>/);
    expect([...html.matchAll(/class="ap-value ap-q-pct"/g)]).toHaveLength(1);
  });

  it("says reset for a first window that has reset since it was read", () => {
    const rolled = { ...account, lanes: [{ id: "five_hour", label: "5h", pct: 96, resetAt: NOW - HOUR }, account.lanes[1]] };
    expect(textOfId(row(rolled, false), "ap-quota-2")).toContain("5h reset");
  });

  it("keeps the middle dot off the line's first visible part", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.ap-quota > :not\(\.vis-hidden\) ~ :is\(\.ap-q-reset, \.ap-q\)::before/);
  });
});

describe("an aliased account's address", () => {
  it("is text in the open detail, in the secondary ink, as well as in the title and for a screen reader", () => {
    const open = row(account, true);
    expect(open).toMatch(/<span class="ap-meta-email" aria-hidden="true">second@example\.com<\/span>/);
    expect(open).toMatch(/<span class="ap-email vis-hidden" id="ap-email-2">second@example\.com<\/span>/);
    expect(open).toMatch(/class="ap-row-open"[^>]*title="work · second@example\.com/);
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\n\.ap-meta-email \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/color: var\(--text-secondary\)/);
  });

  it("is not repeated on a shut row, nor on an account with no alias", () => {
    expect(row(account, false)).not.toContain("ap-meta-email");
    expect(row({ ...account, alias: null }, true)).not.toContain("ap-meta-email");
  });
});

const peer = (n: number, headroom: number | null, ready = true): Peer =>
  ({ key: `k${n}`, name: `acct-${n}`, ready, why: ready ? null : "signed out", warn: !ready, headroom });

describe("the shut fold's preview", () => {
  it("names the two best-ready accounts past six others, not the first two in the list", () => {
    // Nine others, listed worst first, so a list that was cut by position would
    // name the two emptiest. The peek's own order puts the most room first.
    const peers = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((room, i) => peer(i + 1, room));
    const lines = foldPreview(peers);
    expect(lines.slice(0, FOLD_PREVIEW).map(l => l.kind === "peer" ? l.name : "")).toEqual(["acct-9", "acct-8"]);
    expect(lines.at(-1)).toMatchObject({ kind: "more" });
    expect(lines).toHaveLength(FOLD_PREVIEW + 1);
  });

  it("names a not-ready account last, even past the peek's six", () => {
    const peers = [peer(1, null, false), ...[5, 15, 25, 35, 45, 55, 65].map((room, i) => peer(i + 2, room))];
    const names = foldPreview(peers).filter(l => l.kind === "peer").map(l => l.kind === "peer" ? l.name : "");
    expect(names).toEqual(["acct-8", "acct-7"]);
  });

  it("names all of three or fewer", () => {
    expect(foldPreview([peer(1, 40), peer(2, 90), peer(3, 10)]).filter(l => l.kind === "peer")).toHaveLength(3);
  });
});

describe("the panel's states", () => {
  const draw = (data: object) => renderToStaticMarkup(createElement(AccountsEmptyState, { data } as never));

  it("says which version answered, which was wanted and how to point the deck elsewhere, as text", () => {
    const html = draw({ reason: "cswap_refused", version: "9.9.9", want: "0.26.0" });
    const visible = html.replace(/<[^>]+>/g, " ");
    expect(visible).toContain("v9.9.9 answered where 0.26.0 was asked for");
    expect(visible).toContain("AGENTS_DECK_CSWAP");
  });

  it("offers no upgrade command, which does nothing for the deck's pinned install", () => {
    const html = draw({ reason: "cswap_refused", version: "9.9.9", want: "0.26.0" });
    expect(html).not.toContain("uv tool upgrade");
    expect(html).not.toContain("ap-state-cmd");
    expect(withoutComments(readFileSync(fileURLToPath(new URL("../components/AccountsEmptyState.tsx", import.meta.url)), "utf8")))
      .not.toContain("uv tool upgrade");
  });

  it("says a missing install's command in its box, which is the one state that has one", () => {
    expect(draw({ reason: "no_cswap", hint: "uv tool install claude-swap" })).toContain("ap-state-cmd");
  });

  it("shows the reason code, and says a known one in words", () => {
    expect(plainReason("EACCES: permission denied, open '/x'")).toBe("permission denied · EACCES: permission denied, open '/x'");
    expect(plainReason("ENOENT")).toBe("file not found · ENOENT");
    expect(plainReason("store_unreadable")).toBe("store_unreadable");
    expect(plainReason("permission denied")).toBe("permission denied");
    expect(plainReason(null)).toBe("");
    expect(draw({ reason: "store_unreadable" })).toContain("(store_unreadable)");
    expect(draw({ reason: "EACCES" })).toContain("(permission denied · EACCES)");
  });

  it("takes its words from the catalog, not from the code", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../components/AccountsEmptyState.tsx", import.meta.url)), "utf8"));
    expect(src).not.toMatch(/"permission denied"|"file not found"/);
    const en = readFileSync(fileURLToPath(new URL("../i18n/areas/accounts/en.ts", import.meta.url)), "utf8");
    expect(en).toMatch(/"accounts\.empty\.reasonDenied": "permission denied"/);
    expect(en).toMatch(/"accounts\.empty\.reasonMissing": "file not found"/);
  });

  it("leaves no translation behind that says what the English no longer does", () => {
    // These two lines lost a sentence each in English; a translation of the old
    // sentence would go on saying it. CHANGED ON PURPOSE (the UI in every
    // language): they were left out until retranslated, and every catalog now
    // has them, translated from today's English, so the test reads each one and
    // fails on the dropped sentence instead of on the key. The old empty-store
    // line named claude-swap and the + button; the old missing-tool line said
    // that without claude-swap there is nothing to show, in these words.
    const nothingToShow: Record<string, string> = {
      de: "ohne das gibt es nichts anzuzeigen", es: "sin él no hay nada que mostrar", fr: "il n'y a rien à afficher",
      ja: "がないと表示するものがありません", ko: "없으면 표시할 내용이 없습니다", "pt-BR": "sem ele não há nada a mostrar",
      ro: "fără el nu e nimic de afișat", "zh-CN": "没有它就没有内容可显示", "zh-TW": "沒有它就沒有內容可顯示",
    };
    for (const [code, dropped] of Object.entries(nothingToShow)) {
      const src = readFileSync(fileURLToPath(new URL(`../i18n/areas/accounts/${code}.ts`, import.meta.url)), "utf8");
      const line = (key: string) => src.split("\n").find(l => l.includes(`"${key}":`)) ?? "";
      expect(line("accounts.empty.noneHint"), code).not.toBe("");
      expect(line("accounts.empty.noneHint"), code).not.toContain("<b>+</b>");
      expect(line("accounts.empty.noneHint"), code).not.toContain("claude-swap");
      expect(line("accounts.empty.noCswapHint"), code).not.toBe("");
      expect(line("accounts.empty.noCswapHint"), code).not.toContain(dropped);
    }
  });

  it("puts the add-account primer's note on the page, not in a tooltip", () => {
    const dialog = readFileSync(fileURLToPath(new URL("../components/AddAccountDialog.tsx", import.meta.url)), "utf8");
    expect(dialog).toMatch(/<p className="aa-note">\{t\(email \? "accounts\.add\.primerNoteEmail" : "accounts\.add\.primerNote"\)\}<\/p>/);
    expect(dialog).not.toMatch(/<p className="aa-note" title=\{t\(email \? "accounts\.add\.primerNoteEmail"/);
  });
});

describe("the Move list", () => {
  it("walks with the arrows, Home and End, wrapping, and Right and Left are Down and Up", () => {
    const k = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(radioMove(k("ArrowDown"), 0, 3)).toEqual({ kind: "focus", index: 1 });
    expect(radioMove(k("ArrowRight"), 2, 3)).toEqual({ kind: "focus", index: 0 });
    expect(radioMove(k("ArrowUp"), 0, 3)).toEqual({ kind: "focus", index: 2 });
    expect(radioMove(k("ArrowLeft"), 1, 3)).toEqual({ kind: "focus", index: 0 });
    expect(radioMove(k("Home"), 2, 3)).toEqual({ kind: "focus", index: 0 });
    expect(radioMove(k("End"), 0, 3)).toEqual({ kind: "focus", index: 2 });
    expect(radioMove(k("Enter"), 0, 3)).toEqual({ kind: "pass" });
    expect(radioMove(k(" "), 0, 3)).toEqual({ kind: "pass" });
  });

  it("is a radio group with one Tab stop whose arrows move focus and never write", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../components/AccountMenuPopover.tsx", import.meta.url)), "utf8"));
    expect(src).toMatch(/role="radiogroup"/);
    expect(src).toMatch(/tabIndex=\{c\.slot === picked \? 0 : -1\}/);
    const keys = /onKeyDown=\{e => \{[^]*?\n {14}\}\}>/.exec(src)?.[0] ?? "";
    expect(keys).toMatch(/radioMove\(e,/);
    expect(keys).toMatch(/\.focus\(\)/);
    expect(keys).not.toMatch(/pickSlot|doSlot|doMove|fetch|post/);
    // The pick is the press.
    expect(src).toMatch(/onClick=\{\(\) => pickSlot\(c\.slot\)\}/);
  });
});
