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
  it("reads the browser's permission as well as the deck's setting", () => {
    // Two different questions. With the switch on and the permission unasked,
    // the deck's own desktop notifier works and the page's does not — so "on"
    // alone was a promise the tab could not keep.
    expect(soundMenu).toContain('notifyPermission: "default" | "granted" | "denied" | "unsupported";');
    // The gate is named now rather than inlined — one `asking`, read by the
    // row below it and by the switch above, which squares its corners to meet
    // it. Asserted as the definition plus its two uses rather than as one
    // literal expression, so the guarantee survives the next tidy-up: what
    // must hold is that the ask appears only with the switch on, the machine
    // not overruling it, and the browser not yet answered.
    expect(soundMenu).toContain('const asking = notifyOn && !notifyVetoed && notifyPermission === "default";');
    expect(soundMenu).toContain("{asking && (");
    expect(app).toContain('notifyPermission={notifySupported ? notifyPermission : "unsupported"}');
  });

  it("puts the ask on that row, so it does not depend on a session being stuck", () => {
    // It used to live only on the blocked-count button, which appears solely
    // while something is waiting — on a machine whose sessions rarely block,
    // the feature could not be switched on at all.
    expect(soundMenu).toContain('<button type="button" className="btn sm-notice" onClick={onAskNotify}>');
    expect(app).toContain("onAskNotify={askForNotifications}");
  });

  it("offers no button for a permission no page may re-raise", () => {
    // `denied` gets a sentence. A control that silently does nothing is worse
    // than no control, and `requestPermission()` cannot undo a refusal.
    // The two branches are separate conditions rather than a ternary now, and
    // between them they still cover the enum exactly: `asking` is the
    // `default` case, this is `denied` and `unsupported`, and `granted` draws
    // nothing. No permission reaches both, and none reaches neither.
    expect(soundMenu).toContain('notifyPermission === "denied" || notifyPermission === "unsupported"');
    expect(soundMenu).toMatch(/notifyPermission === "denied"\s*\n?\s*\? "This browser is blocking notifications/);
    // And the refused case is prose. A `<button>` anywhere in that branch
    // would be the control that silently does nothing.
    const deniedBranch = soundMenu.slice(soundMenu.indexOf('notifyPermission === "denied" ||'));
    expect(deniedBranch.slice(0, deniedBranch.indexOf("</div>"))).not.toContain("<button");
  });

  it("styles every class it renders", () => {
    for (const cls of ["sm-notify", "sm-switch-joined",
                       "sm-notice", "sm-notice-text", "sm-notice-act", "sm-notice-note"]) {
      expect(css, `.${cls} is unstyled`).toContain(cls);
    }
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
