// Five ways the interface offered a behaviour without offering its control.
//
//   #800  the session list had no control on screen at all — only the L key
//   #801  the Notifications switch said "on" while the browser had never
//         been asked, and the ask lived behind a button that only appears
//         while a session is already stuck
//   #802  the empty hero told a --scope/--workspace user to run an agent in
//         "any folder", which is the one thing that cannot work for them
//   #803  a failed write was captioned "Could not read" and erased by the
//         read poll ten seconds later
//   #804  the deck restarted its own server by default, with the switch that
//         stops it only inside a banner that can be dismissed
//
// None of these has a wrong value anywhere; each is a control and a behaviour
// that were gated on different things. Where the rule is a pure function it is
// called — emptyScope and autoRestartStep both are — and where it lives in JSX
// the source is read, which is what this suite can reach without a DOM.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyScope } from "../scope";
import { autoRestartStep } from "../restart";
import { notifyReach } from "../notify-reach";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const soundMenu = read("../components/SoundMenu.tsx");
const watchModal = read("../components/BrowserWatchModal.tsx");
const css = read("../styles.css");

describe("#800 — the session list", () => {
  it("has a button in the top bar again, not only a key", () => {
    // The rail that documents `L` is itself closed on a fresh install, and a
    // mouse-only user had no route to the list at all.
    expect(app).toContain("onClick={toggleSessionList}");
    expect(app).toContain('aria-label="Toggle session list"');
  });

  it("tells a screen reader what the button controls, and only while it exists", () => {
    // `aria-controls` pointing at an unmounted id is a dangling reference; the
    // four buttons beside it already follow this rule.
    expect(app).toContain("aria-expanded={sessionListOpen}");
    expect(app).toContain('aria-controls={sessionListOpen ? "session-list" : undefined}');
    // And the id it names must be the one the panel actually renders.
    expect(read("../components/SessionList.tsx")).toContain('id="session-list"');
  });

  it("still names the shortcut, so the button teaches the key rather than replacing it", () => {
    expect(app).toContain('title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}');
    expect(app).toContain('if (e.key === "l" || e.key === "L") toggleSessionList();');
  });
});

describe("#801 — what the Notifications switch is saying", () => {
  // The defect took three passes to name properly, and the last one is the
  // reason this block is written against a pure function rather than a shape.
  //
  //   first  — the switch said "on" while the browser had never been asked, and
  //            the ask lived behind a button that only appears while a session
  //            is already stuck.
  //   then   — the ask became a row under the switch, which read as a third
  //            setting; then two rows naming the two notifiers, which read as
  //            two more.
  //   now    — three different things were sharing one column of controls: what
  //            the user WANTS, what the browser ALLOWS, and which of the deck's
  //            two notifiers carries a given alert. Only the first is a
  //            setting. The second is one sentence. The third is never on
  //            screen as a control at all — it survives as the clause that
  //            stops a refusal reading as silence.

  it("keeps the switch answering exactly one question, and answering it alone", () => {
    expect(soundMenu).toContain('aria-checked={notifyOn}');
    expect(app).toContain('notifyPermission={notifySupported ? notifyPermission : "unsupported"}');
    // Nothing about the browser reaches the switch's own label or state — that
    // is what "on" above "needs permission" was, and a switch cannot contradict
    // itself if it never mentions the other question.
    const sw = soundMenu.slice(soundMenu.indexOf('id="sm-notify-label"'));
    expect(sw.slice(0, sw.indexOf("</label>"))).not.toContain("notifyPermission");
  });

  it("finishes the job on the press, rather than reporting that it did not", () => {
    // The user's own reply to a switch reading "on" over a missing permission:
    // if it is on, why must I do something else? `requestPermission()` needs a
    // user gesture and the press IS one, so the prompt goes up on the same
    // press — off to on only, and only while the browser can still be asked.
    expect(app).toContain('if (want && typeof Notification !== "undefined" && Notification.permission === "default") {');
    expect(app).toContain("askNotifyRef.current();");
    // Through a ref, because the asker is declared below the toggle and a
    // dependency on it would rebuild the callback for nothing.
    expect(app).toContain("askNotifyRef.current = askForNotifications;");
  });

  it("says whether it can reach you in one sentence, in the user's words", () => {
    for (const p of ["granted", "default", "denied", "unsupported"] as const) {
      const r = notifyReach(false, p);
      expect(r.line, p).toMatch(/^[A-Z]/);
      expect(r.line, p).toMatch(/\.$/);
      // Not the vocabulary the wiring is written in. "tab hidden", "no tab
      // open", "permission", "sseClients" are how this repo talks about it.
      expect(r.line.toLowerCase(), p).not.toMatch(/\bpermission\b|\btab\b|\bhidden\b|\bsse\b/);
    }
    expect(notifyReach(false, "granted").line).toContain("you're away");
  });

  it("never puts the two notifiers on screen as two things to configure", () => {
    // They ARE two — the page raises one while the deck is open in the
    // background, the server raises one when no page exists at all — and they
    // are exclusive by construction, so both being live is full cover. That is
    // worth ONE clause, because it changes what a refusal means. It is not
    // worth a row each: nobody outside this repo asks which mechanism fired.
    expect(soundMenu).not.toContain("This tab, when hidden");
    expect(soundMenu).not.toContain("The deck, when no tab is open");
    for (const p of ["denied", "unsupported"] as const) {
      expect(notifyReach(false, p).line, p).toContain("once this page is closed");
    }
  });

  it("offers a button in the one state where a button can do anything", () => {
    // A refusal cannot be re-raised by any page, so `denied` and `unsupported`
    // say where the remedy lives instead of offering a control that would
    // silently fail — the failure browser-react.mjs refuses to ship for its own
    // reactions. `granted` has nothing to offer. That leaves exactly one.
    expect(notifyReach(false, "default").ask).toBe(true);
    for (const p of ["granted", "denied", "unsupported"] as const) {
      expect(notifyReach(false, p).ask, p).toBe(false);
    }
    expect(soundMenu).toContain("{reach.ask && (");
    expect(soundMenu).toContain('<button type="button" className="btn sm-reach-ask" onClick={onAskNotify}>');
    expect(app).toContain("onAskNotify={askForNotifications}");
  });

  it("lets the launch veto outrank the browser, because it silences both halves", () => {
    // AGENTS_DECK_NO_NOTIFY=1 is not "the switch is off": it is somebody else's
    // decision, the press cannot undo it until the next start, and it stops the
    // server-side notifier too — which is more than any browser setting can do.
    // So it answers first, whatever the permission says.
    for (const p of ["granted", "default", "denied", "unsupported"] as const) {
      const r = notifyReach(true, p);
      expect(r.ask, p).toBe(false);
      expect(r.tone, p).toBe("blocked");
      expect(r.line, p).toContain("saved for the next start");
    }
    // And the switch still moves, because the preference is still the user's.
    expect(soundMenu).toContain("onClick={onToggleNotify}");
  });

  it("hides the whole answer when there is no question", () => {
    // Switch off, nothing to say: a sentence about what the browser will allow
    // is noise beside a channel the user has turned off.
    expect(soundMenu).toContain("{notifyOn && (");
  });

  it("styles every class it renders", () => {
    for (const cls of ["sm-switches", "sm-switch", "sm-switch-label", "sm-toggle",
                       "sm-toggle-knob", "sm-reach", "sm-reach-line", "sm-reach-ask"]) {
      expect(css, `.${cls} is unstyled`).toContain(cls);
    }
    // The tone is a data attribute, not a third class, so the sweep in
    // unstyled-class.test.ts keeps checking the one class this line has.
    expect(css).toContain('.sm-reach-line[data-tone="ok"]');
    expect(css).toContain('.sm-reach-line[data-tone="todo"]');
  });
});

describe("#802 — the empty hero and the scope it was started with", () => {
  it("renders the scoped sentence instead of 'any folder'", () => {
    // The one user for whom the canvas stays empty is exactly the one who
    // started the deck with --scope or --workspace and then ran an agent
    // outside that tree; this told them to do the thing that cannot work.
    const scoped = emptyScope("/w/paycore");
    expect(scoped.kind).toBe("scoped");
    expect(scoped.workspace).toBe("/w/paycore");
    expect(scoped.tail).toContain("--workspace/--scope");
    expect(app).toContain("const scope = emptyScope(workspace);");
    expect(app).toContain('{scope.kind === "scoped" ? (');
  });

  it("keeps the 'any folder' sentence for a deck that is not scoped", () => {
    // The other direction: on an unscoped deck the old copy is the true one and
    // must survive.
    expect(emptyScope("").kind).toBe("machine");
    expect(emptyScope(null).kind).toBe("unknown");
    expect(app).toContain("Run <code>claude</code> or <code>codex</code> in any folder.");
  });

  it("is handed the workspace at the call site, which is what was missing", () => {
    expect(app).toContain("<EmptyHero live={live} everConnected={everConnected} providers={providers} workspace={workspace} />");
    expect(app).toContain("function agentNoneCopy(providers: Providers, workspace: string | null) {");
  });
});

describe("#803 — a failed write in Browser Watch", () => {
  it("has its own slot, so the read poll cannot erase it", () => {
    // `save` and `load` shared one `error`, the render captioned it "Could not
    // read", and the ten-second poll's `setError(null)` wiped it — leaving a
    // panel that looked healthy with the setting unchanged.
    expect(watchModal).toContain("const [writeError, setWriteError] = useState<string | null>(null);");
    expect(watchModal).toContain("setWriteError(e instanceof Error ? e.message : String(e));");
    // The read path still clears the read error, which is correct: a poll that
    // succeeded IS the answer to "can the deck be reached".
    expect(watchModal).toContain("setError(null);");
    // And it does not clear the write one.
    expect(watchModal, "the poll erases the write error again")
      .not.toMatch(/setError\(null\);\s*\n\s*setWriteError\(null\);/);
  });

  it("says what actually failed, and stands until the user acts", () => {
    expect(watchModal).toContain('<span className="bw-row-label">Could not save that setting</span>');
    expect(watchModal).toContain("onClick={() => setWriteError(null)}");
    expect(watchModal).toContain('role="alert"');
    for (const cls of ["bw-write-err", "bw-write-err-x"]) {
      expect(css, `.${cls} is unstyled`).toContain(cls);
    }
  });

  it("clears itself when a later write succeeds", () => {
    // A message that outlives the problem is the same defect facing the other
    // way. The clear is after the reload and inside the try, so only a write
    // that actually landed counts.
    const save = watchModal.slice(watchModal.indexOf("const save = useCallback"));
    const ok = save.indexOf("setWriteError(null);");
    const caught = save.indexOf("} catch (e) {");
    expect(ok).toBeGreaterThan(-1);
    expect(ok, "the success clear is in the catch").toBeLessThan(caught);
  });

  it("reconciles the quiet select with the store on every poll that is not a save", () => {
    // `q === null ? … : q` only ever wrote on the transition out of null, so
    // after the first snapshot the local value won forever — while the
    // paragraph above it rendered `snap.settings.quietMinutes` from the server.
    // One dialog, two different settings, nothing able to correct it.
    expect(watchModal).toContain("if (!savingRef.current) setQuiet(next?.settings?.quietMinutes ?? 15);");
    expect(watchModal, "the null-only follow is back")
      .not.toContain("setQuiet(q => (q === null ? next?.settings?.quietMinutes ?? 15 : q));");
    // A ref rather than the state, because `saving` as a dependency of `load`
    // would rebuild the callback on every save and restart both the mount fetch
    // and the ten-second interval keyed on it.
    expect(watchModal).toContain("const savingRef = useRef(false);");
    expect(watchModal).toContain("savingRef.current = true;");
    expect(watchModal).toContain("savingRef.current = false;");
  });
});

describe("#804 — the deck restarting itself", () => {
  it("is armed only while the switch that stops it is on screen", () => {
    // The behaviour was keyed on `notice?.kind`; the switch renders inside
    // `noticeOpen && notice`. Dismiss the banner with its × and the server
    // still exited, respawned and reloaded the page thirty seconds after the
    // last agent went quiet, with no control anywhere in the app.
    const NOW = 1_800_000_000_000;
    const gate = {
      enabled: true, kind: "restart" as const, canRestart: true, busy: false,
      idleSince: NOW - 10 * 60_000, now: NOW,
    };
    expect(autoRestartStep({ ...gate, noticeOpen: false }).restart).toBe(false);
    expect(autoRestartStep({ ...gate, noticeOpen: true }).restart).toBe(true);
    expect(app).toContain("noticeOpen,");
    expect(app).toContain("}, [autoRestart, notice?.kind, version?.canRestart, noticeOpen, now, askRestart]);");
  });

  it("keeps the default the useful one, because the switch is now always beside it", () => {
    // Defaulting to off would leave every user on a version they already have
    // installed until they found a switch they have no reason to look for. The
    // defect was reachability, not the default — so the default stays.
    expect(app).toContain('window.localStorage.getItem(AUTO_RESTART_KEY) !== "0"');
  });
});
