// Stop there and resume here, on the card: the not-attachable card of a
// Claude session running in a terminal outside the deck, where Resume here
// after exit is offered. The button asks the deck which process holds the
// session (use-terminal-session's checkStopElsewhere), the card then asks the
// reader to confirm in place, naming the session and what is lost, and once
// confirmed it waits as Resume here after exit waits, saying Claude is being
// stopped. stop-elsewhere.test.ts holds the deck's side, and
// use-terminal-session.test.ts the controller's steps; this file holds the
// card, the stage's wiring and the words in every language.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { all, one, textOf, type Drawn } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import { AFTER_EXIT_OFFER_MSG, StateCard, type StageBodyProps, type StopElsewhereOffer } from "../components/terminal/StageBody";
import {
  AFTER_EXIT_HOW_MSG, AFTER_EXIT_MSG, AFTER_EXIT_WAITING_MSG, STOP_CONFIRM_MSG, STOP_CONFIRM_TITLE_MSG, STOP_CONFIRM_WHAT_MSG,
  STOP_ELSEWHERE_MSG, STOP_FINAL, STOP_ISSUE_MSG, STOP_OFFER_MSG, STOP_SLOW_MSG, STOP_STOPPING_MSG, STOP_WARN_QUESTION_MSG,
  STOP_WARN_TURN_MSG, STOP_WARN_UNSENT_MSG, folderShown, type StagePhase,
} from "../components/terminal/stage-model";
import type { StopElsewhereReason } from "../terminal-api";
import { en } from "../i18n/en";
import { catalogFor } from "../i18n/catalogs";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const buttons = (tree: unknown) => all(tree, el => el.type === "button");
const named = (tree: unknown) => buttons(tree).map(b => textOf(b).trim());
const button = (tree: unknown, name: string) => one(tree, el => el.type === "button" && textOf(el).trim() === name);
const read = (path: string) => withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
/** The actions row's children as the card lays them out, placeholders kept:
 *  a button keeps its DOM node (and the focus on it) only at the same index. */
const actsOf = (tree: unknown) => (one(tree, el => el.props.className === "ts-acts")?.props.children ?? []) as unknown[];
const slotOf = (tree: unknown, value: string) =>
  actsOf(tree).findIndex(c => !!c && typeof c === "object" && "props" in c && (c as Drawn).props["data-stop-elsewhere"] === value);

const target = { kind: "C" as const, label: "External session", adoptable: true };
const elsewhere = { kind: "not-attachable" as const, target, stillRunning: true, busy: false };
const armed = { ...elsewhere, awaitingExit: true };
const stopping = { ...armed, stopping: true };
const NAME = "paycore · Fix the login loop";
const CWD = "/home/u/code/paycore";

function stopOffer(over: Partial<StopElsewhereOffer> = {}): StopElsewhereOffer {
  return { name: NAME, cwd: CWD, checking: false, confirming: false, ask: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), ...over };
}
function bodyProps(phase: StagePhase, over: Partial<StageBodyProps> = {}): StageBodyProps {
  return {
    hostRef: { current: null }, phase,
    context: { prompt: "Refactor mailbox controller" },
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
  };
}
const ways = (stop?: StopElsewhereOffer) => ({ arm: vi.fn(), cancel: vi.fn(), ...(stop ? { stop } : {}) });

describe("the button", () => {
  it("leads where Resume here after exit is offered, which stays beside it, and Not now after", () => {
    const stop = stopOffer();
    const props = bodyProps(elsewhere, { afterExit: ways(stop) });
    const tree = StateCard(props);
    expect(named(tree)).toEqual([en[STOP_ELSEWHERE_MSG], en[AFTER_EXIT_MSG], "Not now"]);
    expect(button(tree, en[STOP_ELSEWHERE_MSG])?.props.className).toBe("btn primary");
    expect(button(tree, en[AFTER_EXIT_MSG])?.props.className, "Resume here after exit is the second way").toBe("btn");
    const out = html(createElement(StateCard, props));
    expect(out).toContain(en[STOP_OFFER_MSG]);
    expect(out, "one line, which names the new way").not.toContain(en[AFTER_EXIT_OFFER_MSG]);
    (button(tree, en[STOP_ELSEWHERE_MSG])!.props.onClick as () => void)();
    expect(stop.ask).toHaveBeenCalledOnce();
    expect(stop.confirm, "a press only asks; the reader confirms after").not.toHaveBeenCalled();
  });

  it("is nowhere Resume here after exit is not: no offer, armed, a move under way or on offer, an ended session", () => {
    // Without the stage's offer the card is the one it was.
    const plain = StateCard(bodyProps(elsewhere, { afterExit: ways() }));
    expect(named(plain)).toEqual([en[AFTER_EXIT_MSG], "Not now"]);
    expect(html(createElement(StateCard, bodyProps(elsewhere, { afterExit: ways() })))).toContain(en[AFTER_EXIT_OFFER_MSG]);
    expect(button(StateCard(bodyProps(elsewhere)), en[STOP_ELSEWHERE_MSG])).toBeNull();
    // Resume here after exit armed by its own press: its Cancel only.
    expect(named(StateCard(bodyProps(armed, { afterExit: ways(stopOffer()) })))).toEqual(["Cancel"]);
    // A move under way, or one that may be tried again: the move leads, and
    // the card keeps one primary.
    const moving = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer()), handoff: { moving: true, toggle: vi.fn() } }));
    expect(button(moving, en[STOP_ELSEWHERE_MSG])).toBeNull();
    const busy = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer()), handoff: { moving: false, reason: "claude-not-ready", toggle: vi.fn() } }));
    expect(button(busy, en[STOP_ELSEWHERE_MSG])).toBeNull();
    expect(all(busy, el => el.type === "button" && el.props.className === "btn primary")).toHaveLength(1);
    // Ghostty 1.3, no move at all: the stop leads again.
    const old = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer()), handoff: { moving: false, reason: "ghostty-unsupported", toggle: vi.fn() } }));
    expect(button(old, en[STOP_ELSEWHERE_MSG])?.props.className).toBe("btn primary");
    // A session that ended there, or one the deck cannot reopen.
    const ended = { ...elsewhere, target: { ...target, kind: "gone" as const }, stillRunning: false };
    expect(button(StateCard(bodyProps(ended, { afterExit: ways(stopOffer()) })), en[STOP_ELSEWHERE_MSG])).toBeNull();
    const notOurs = { ...elsewhere, target: { ...target, adoptable: false } };
    expect(button(StateCard(bodyProps(notOurs, { afterExit: ways(stopOffer()) })), en[STOP_ELSEWHERE_MSG])).toBeNull();
  });

  it("says Checking… while the deck is asked, and stays enabled (aria-busy)", () => {
    const tree = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer({ checking: true })) }));
    const checking = button(tree, en["board.stage.checking"]);
    expect(checking?.props["aria-busy"]).toBe(true);
    expect(checking?.props.disabled).toBeUndefined();
    expect(checking?.props["data-stop-elsewhere"]).toBe("stop");
  });
});

describe("the confirmation", () => {
  it("names the session and its folder, says what happens, and offers Stop and resume here or Cancel", () => {
    const stop = stopOffer({ confirming: true });
    const props = bodyProps(elsewhere, { afterExit: ways(stop), boardState: "idle" });
    const out = html(createElement(StateCard, props));
    expect(out).toContain(en[STOP_CONFIRM_TITLE_MSG].replace("{name}", NAME));
    expect(out).toContain(`title="${CWD}">${folderShown(CWD)}</div>`);
    expect(out).toContain(en[STOP_CONFIRM_WHAT_MSG]);
    expect(out, "in place of the card's prompt").not.toContain("Refactor mailbox controller");
    const tree = StateCard(props);
    expect(named(tree), "no Not now, no Resume here after exit while it asks").toEqual([en[STOP_CONFIRM_MSG], "Cancel"]);
    expect(button(tree, en[STOP_CONFIRM_MSG])?.props.className).toBe("btn primary");
    const back = button(tree, "Cancel")!;
    expect(back.props["data-stage-land"], "the keys land on Cancel, never on the stop").toBe(true);
    const press = { detail: 1 };
    (button(tree, en[STOP_CONFIRM_MSG])!.props.onClick as (e: unknown) => void)(press);
    expect(stop.confirm).toHaveBeenCalledWith(press);
    (back.props.onClick as (e: unknown) => void)(press);
    expect(stop.cancel).toHaveBeenCalledWith(press);
  });

  it("warns of what is lost by what the board says Claude is doing", () => {
    const warnings = (boardState: StageBodyProps["boardState"]) => {
      const tree = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer({ confirming: true })), boardState }));
      return all(tree, el => el.props.className === "ts-note").map(el => textOf(el));
    };
    expect(warnings("working")).toEqual([en[STOP_WARN_TURN_MSG], en[STOP_WARN_UNSENT_MSG]]);
    expect(warnings("waiting")).toEqual([en[STOP_WARN_QUESTION_MSG], en[STOP_WARN_UNSENT_MSG]]);
    expect(warnings("idle")).toEqual([en[STOP_WARN_UNSENT_MSG]]);
    expect(warnings(null)).toEqual([en[STOP_WARN_UNSENT_MSG]]);
  });

  it("is cancelled by Escape, which goes no further than the card", () => {
    const stop = stopOffer({ confirming: true });
    const card = StateCard(bodyProps(elsewhere, { afterExit: ways(stop) })) as unknown as Drawn;
    expect(card.props["data-stop-confirm"]).toBe(true);
    const onKeyDown = card.props.onKeyDown as (e: unknown) => void;
    const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    const tab = key("Tab");
    onKeyDown(tab);
    expect(stop.cancel).not.toHaveBeenCalled();
    expect(tab.stopPropagation).not.toHaveBeenCalled();
    const escape = key("Escape");
    onKeyDown(escape);
    expect(stop.cancel).toHaveBeenCalledOnce();
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation, "not the deck's Escape, which would close the pane").toHaveBeenCalled();
    // Not asking: the card answers no keys of its own.
    expect((StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer()) })) as unknown as Drawn).props.onKeyDown).toBeUndefined();
  });

  it("keeps the focus on the pressed button: the stop becomes Cancel, and the confirm the wait's Cancel", () => {
    const stop = stopOffer();
    const offered = StateCard(bodyProps(elsewhere, { afterExit: ways(stop) }));
    const asking = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer({ confirming: true })) }));
    const waiting = StateCard(bodyProps(stopping, { afterExit: ways(stopOffer()) }));
    expect(slotOf(offered, "stop")).toBeGreaterThanOrEqual(0);
    expect(slotOf(asking, "back")).toBe(slotOf(offered, "stop"));
    expect(slotOf(asking, "confirm")).toBeGreaterThanOrEqual(0);
    expect(slotOf(waiting, "cancel")).toBe(slotOf(asking, "confirm"));
    expect(actsOf(asking)).toHaveLength(actsOf(offered).length);
    expect(actsOf(waiting)).toHaveLength(actsOf(offered).length);
  });
});

describe("the wait it arms", () => {
  it("says Claude is being stopped there, with the working glyph and Cancel as its one button", () => {
    const after = ways(stopOffer());
    const props = bodyProps(stopping, { afterExit: after });
    const out = html(createElement(StateCard, props));
    expect(out).toMatch(new RegExp(`<p class="ts-text ts-wait" role="status">.*<span>${en[STOP_STOPPING_MSG]}</span></p>`));
    expect(out, "no line asking the reader to exit it there").not.toContain(en[AFTER_EXIT_HOW_MSG]);
    expect(out).not.toContain(en[AFTER_EXIT_WAITING_MSG]);
    const tree = StateCard(props);
    expect(named(tree)).toEqual(["Cancel"]);
    const cancel = button(tree, "Cancel")!;
    expect(cancel.props["data-stage-land"]).toBe(true);
    const press = { detail: 1 };
    (cancel.props.onClick as (e: unknown) => void)(press);
    expect(after.cancel, "the wait's own Cancel").toHaveBeenCalledWith(press);
  });

  it("says Claude has not stopped yet once it is slow, and keeps waiting", () => {
    const out = html(createElement(StateCard, bodyProps({ ...stopping, slowStop: true }, { afterExit: ways(stopOffer()) })));
    expect(out).toMatch(new RegExp(`<p class="ts-text ts-wait" role="status">.*<span>${en[STOP_SLOW_MSG]}</span></p>`));
    expect(named(StateCard(bodyProps({ ...stopping, slowStop: true }, { afterExit: ways(stopOffer()) })))).toEqual(["Cancel"]);
  });

  it("leaves Resume here after exit's own wait as it was", () => {
    const out = html(createElement(StateCard, bodyProps(armed, { afterExit: ways(stopOffer()) })));
    expect(out).toContain(en[AFTER_EXIT_WAITING_MSG]);
    expect(out).toContain(en[AFTER_EXIT_HOW_MSG]);
    expect(out).not.toContain(en[STOP_STOPPING_MSG]);
  });
});

describe("a stop that did not happen", () => {
  const reasons = Object.keys(STOP_ISSUE_MSG) as StopElsewhereReason[];

  it("says why in one line, with Resume here after exit still below it", () => {
    expect(new Set(reasons)).toEqual(new Set([
      "unsupported", "not-elsewhere", "unverifiable", "not-found", "ambiguous", "background", "shared-parent", "changed", "signal-failed", "network",
    ]));
    for (const reason of reasons) {
      const props = bodyProps({ ...elsewhere, stopIssue: reason }, { afterExit: ways(stopOffer()) });
      const out = html(createElement(StateCard, props));
      expect(out, reason).toContain(`<p class="ts-text" role="status">${en[STOP_ISSUE_MSG[reason]]}</p>`);
      expect(out, `${reason}: the one line`).not.toContain(en[STOP_OFFER_MSG]);
      const tree = StateCard(props);
      expect(button(tree, en[AFTER_EXIT_MSG]), reason).not.toBeNull();
      expect(button(tree, "Not now"), reason).not.toBeNull();
      // Only where pressing it again could go another way does the stop stay.
      if (STOP_FINAL.has(reason)) {
        expect(button(tree, en[STOP_ELSEWHERE_MSG]), reason).toBeNull();
        expect(button(tree, en[AFTER_EXIT_MSG])?.props.className, `${reason}: the fallback leads`).toBe("btn primary");
      } else {
        expect(button(tree, en[STOP_ELSEWHERE_MSG])?.props.className, reason).toBe("btn primary");
        expect(button(tree, en[AFTER_EXIT_MSG])?.props.className, reason).toBe("btn");
      }
    }
  });

  it("names each reason as the deck means it", () => {
    expect(en[STOP_ISSUE_MSG.unverifiable]).toBe(en[STOP_ISSUE_MSG["not-found"]]);
    expect(en[STOP_ISSUE_MSG.unverifiable]).toBe(en[STOP_ISSUE_MSG.ambiguous]);
    expect(en[STOP_ISSUE_MSG.unverifiable]).toContain("stopped nothing");
    expect(en[STOP_ISSUE_MSG.background]).toContain("background");
    expect(en[STOP_ISSUE_MSG["shared-parent"]]).toContain("inside that Claude session");
    expect(en[STOP_ISSUE_MSG.changed]).toContain("Try again");
    for (const plain of ["unsupported", "signal-failed", "network", "not-elsewhere"] as const) {
      expect(en[STOP_ISSUE_MSG[plain]], plain).toBe("Could not stop it here. Use Resume here after exit instead.");
    }
  });

  it("is said only while nothing is armed", () => {
    const out = html(createElement(StateCard, bodyProps({ ...armed, stopIssue: "changed" }, { afterExit: ways(stopOffer()) })));
    expect(out).not.toContain(en[STOP_ISSUE_MSG.changed]);
  });
});

describe("the stage's wiring", () => {
  it("hands the stop to the card beside Resume here after exit, which is wired as it was", () => {
    const stage = read("../components/terminal/TerminalStage.tsx");
    // Resume here after exit, untouched.
    expect(stage).toMatch(/arm: \(\) => \{ armedAt\.current = Date\.now\(\); session\.resumeAfterExit\(\); \}/);
    expect(stage).toMatch(/if \(!repeatedPress\(e, Date\.now\(\) - armedAt\.current\)\) session\.stopWaitingForExit\(\);/);
    expect(stage).toMatch(/afterExit=\{afterExit\}/);
    // The stop rides on that offer, so it is shown exactly where it is.
    expect(stage).toMatch(/\.\.\.\(stopElsewhere \? \{ stop: stopElsewhere \} : \{\}\)/);
    expect(stage).toMatch(/void session\.checkStopElsewhere\(\)\.then\(/);
    // The rest of a double-click or a held Enter on the press that asked
    // confirms nothing; the confirm arms as the wait's own press does.
    expect(stage).toMatch(/if \(repeatedPress\(e, Date\.now\(\) - stopAskedAt\.current\)\) return;\s*armedAt\.current = Date\.now\(\);\s*setStopAsk\(null\);\s*session\.confirmStopElsewhere\(\);/);
    expect(stage).toMatch(/session\.cancelStopElsewhere\(\);/);
  });

  it("puts the focus back on the card's way on when a stop's wait ends with Claude still there", () => {
    const stage = read("../components/terminal/TerminalStage.tsx");
    // The wait's Cancel stands in the confirm's slot, which the offer does not
    // draw: once the wait ends (Cancel, or the stop refused) the focus it held
    // would be the page's. Only from there: focus taken elsewhere stays.
    expect(stage).toMatch(/const stopWait = phase\.kind === "not-attachable" && phase\.awaitingExit === true && phase\.stopping === true;/);
    expect(stage).toMatch(/const ended = wasStopWait\.current && !stopWait;/);
    expect(stage).toMatch(/if \(!ended\) return;\n\s*const active = document\.activeElement;\n\s*if \(active && active !== document\.body\) return;/);
    expect(stage).toMatch(/querySelector<HTMLElement>\('\.ts-card \[data-stop-elsewhere="stop"\], \.ts-card \[data-after-exit="arm"\]'\)\?\.focus\(\);/);
    // The wait's Cancel and the button it ends on are not one node.
    const wait = StateCard(bodyProps(stopping, { afterExit: ways(stopOffer()) }));
    const back = StateCard(bodyProps(elsewhere, { afterExit: ways(stopOffer()) }));
    expect(slotOf(wait, "cancel")).not.toBe(slotOf(back, "stop"));
  });
});

describe("the words", () => {
  const keys = [
    STOP_ELSEWHERE_MSG, STOP_OFFER_MSG, STOP_CONFIRM_TITLE_MSG, STOP_CONFIRM_WHAT_MSG, STOP_WARN_TURN_MSG, STOP_WARN_QUESTION_MSG,
    STOP_WARN_UNSENT_MSG, STOP_CONFIRM_MSG, STOP_STOPPING_MSG, STOP_SLOW_MSG, ...new Set(Object.values(STOP_ISSUE_MSG)),
  ];

  it("says every new line in all ten languages", () => {
    expect(keys).toHaveLength(15);
    for (const lang of ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ro", "zh-CN", "zh-TW"] as const) {
      const catalog = catalogFor(lang) as Record<string, string>;
      for (const key of keys) {
        expect(catalog[key], `${lang} ${key}`).toBeTruthy();
        if (lang !== "en") expect(catalog[key], `${lang} ${key} is translated`).not.toBe(en[key]);
      }
      // The title keeps the session's name; the lines that send the reader to
      // the other way name its button, and to Sessions by its title.
      expect(catalog[STOP_CONFIRM_TITLE_MSG], lang).toContain("{name}");
      expect(catalog[STOP_ISSUE_MSG.unverifiable], lang).toContain(catalog[AFTER_EXIT_MSG]);
      expect(catalog[STOP_ISSUE_MSG.network], lang).toContain(catalog[AFTER_EXIT_MSG]);
      expect(catalog[STOP_ISSUE_MSG.background], lang).toContain(catalog["board.list.title"]);
    }
  });
});
