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
import { browserChannel, NOTIFY_NOTE, NOTIFY_VETO_NOTE } from "../notify-reach";

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
  // Four passes, and only the last one names the defect properly.
  //
  //   first  — the switch said "on" while the browser had never been asked,
  //            and the ask lived behind a button that only appears while a
  //            session is already stuck.
  //   then   — the ask became a row under the switch, which read as a third
  //            setting; then two rows naming the two notifiers, which read as
  //            two more.
  //   then   — real switches and one sentence, which fixed the picture and left
  //            the contradiction: "Notifications on" directly above "Allow
  //            notifications" still asks the reader why an on thing needs
  //            permission.
  //   now    — it was never a copy problem. "Notifications" is the feature and
  //            "Browser notifications" is ONE OF THE TWO CHANNELS it reaches
  //            you through. Two named things cannot contradict each other, and
  //            the second one is a section like the tone sections below it
  //            rather than a condition attached to the first.

  it("keeps the switch answering exactly one question, and answering it alone", () => {
    expect(soundMenu).toContain("aria-checked={notifyOn}");
    expect(app).toContain('notifyPermission={notifySupported ? notifyPermission : "unsupported"}');
    // Nothing about the browser reaches the switch or its note. That is what
    // "on" over "needs permission" was, and a control cannot contradict itself
    // if it never mentions the other question.
    const setting = soundMenu.slice(soundMenu.indexOf('<div className="sm-setting">'));
    const own = setting.slice(0, setting.indexOf("</div>"));
    expect(own).not.toContain("notifyPermission");
    expect(own).not.toContain("channel");
  });

  it("says what the switch covers, which is the only thing separating it from Sounds", () => {
    // Two identically-shaped switches whose difference lives nowhere on screen
    // is the reason this note exists: sound fires on every finished turn, this
    // fires only when something has stopped and needs a person.
    expect(NOTIFY_NOTE).toBe("Notify me when a session needs my attention.");
    expect(soundMenu).toContain("{notifyVetoed ? NOTIFY_VETO_NOTE : NOTIFY_NOTE}");
  });

  it("finishes the job on the press, rather than reporting that it did not", () => {
    // `requestPermission()` needs a user gesture and the press IS one, so the
    // prompt goes up on the same press — off to on only, and only while the
    // browser can still be asked. The button below is then the way back from a
    // prompt that was dismissed, not the main road to the permission.
    expect(app).toContain('if (want && typeof Notification !== "undefined" && Notification.permission === "default") {');
    expect(app).toContain("askNotifyRef.current();");
    // Through a ref, because the asker is declared below the toggle and a
    // dependency on it would rebuild the callback for nothing.
    expect(app).toContain("askNotifyRef.current = askForNotifications;");
  });

  it("draws the channel below the switches and above the rule, at neither rank", () => {
    // A named group with one control beside its name — the shape TURN FINISHED
    // already has — but NOT its caps heading. All caps in this menu belongs to
    // the two event groups, which are what structure it; a third one here would
    // give a capability report the rank of a section the user configures.
    const chan = soundMenu.slice(soundMenu.indexOf('aria-labelledby="sm-channel-name"'));
    expect(chan).toContain('<h3 className="sm-channel-name" id="sm-channel-name">Browser notifications</h3>');
    expect(chan).toContain('<div className="sm-channel-head">');
    expect(soundMenu).toContain('<section className="sm-channel" aria-labelledby="sm-channel-name">');
    const chanName = css.slice(css.indexOf(".sm-channel-name {"));
    expect(chanName.slice(0, chanName.indexOf("}"))).not.toContain("text-transform");
    const toneName = css.slice(css.lastIndexOf(".sm-tone-name {"));
    expect(toneName.slice(0, toneName.indexOf("}")), "the event groups lost their caps")
      .toContain("text-transform: uppercase");
    // And the head keeps a floor, so granting the permission swaps a 30px
    // button for a word without the section shortening under the press.
    expect(css).toMatch(/\.sm-channel-head \{[^}]*min-height: var\(--ctl-h\)/);
  });

  it("puts one rule between the two subjects this menu holds", () => {
    // Above it: does this deck interrupt me, and can it. Below it: what each
    // interruption sounds like. The caps headings separate the event groups
    // from each other, not the whole set of them from what comes before.
    expect(soundMenu).toContain('<div className="sm-tones">');
    expect(css).toMatch(/\.sm-tones \{[^}]*border-top: 1px solid var\(--line\)/);
  });

  it("stops the word Sound naming two different things", () => {
    // The switch said "Sound" and the per-tone <select> under it said "Sound"
    // too — one meaning on/off, the other which of three figures plays. The
    // switch is plural now and the picker is the thing it picks.
    expect(soundMenu).toContain('id="sm-sound-label">Sounds<');
    expect(soundMenu).toContain("<label htmlFor={figureId}>Tone</label>");
    expect(soundMenu).not.toMatch(/>Sound</);
  });

  it("keeps the promise identical either side of the press that grants it", () => {
    // Granting the permission should change a word on the right and nothing
    // else. A different sentence would relay the section under the pointer that
    // caused it, and would also say the feature became something else.
    expect(browserChannel("granted").note).toBe(browserChannel("default").note);
    expect(browserChannel("granted").status).toBe("Enabled");
    expect(browserChannel("default").status).toBeNull();
    expect(browserChannel("granted").ok).toBe(true);
  });

  it("speaks the user's words, not the wiring's", () => {
    for (const p of ["granted", "default", "denied", "unsupported"] as const) {
      const c = browserChannel(p);
      expect(c.note, p).toMatch(/^[A-Z]/);
      expect(c.note, p).toMatch(/\.$/);
      expect(c.note.toLowerCase(), p).not.toMatch(/\bpermission\b|\bhidden\b|\bsse\b|\bnotifier\b/);
    }
    expect(NOTIFY_NOTE.toLowerCase()).not.toMatch(/\bpermission\b|\bhook\b/);
  });

  it("never puts the two notifiers on screen as two things to configure", () => {
    // They ARE two — the page raises one while the deck is open in the
    // background, the server raises one when no page exists at all — and they
    // are exclusive by construction, so both being live is full cover. Worth
    // ONE clause, in the two states where a browser has taken the first away,
    // because there it changes what a refusal means. Never a row: nobody
    // outside this repo asks which mechanism fired.
    expect(soundMenu).not.toContain("This tab, when hidden");
    expect(soundMenu).not.toContain("The deck, when no tab is open");
    for (const p of ["denied", "unsupported"] as const) {
      expect(browserChannel(p).note, p).toContain("once this tab is closed");
    }
    // And it is NOT said in the two healthy states, where it would be noise
    // about machinery in place of a promise.
    for (const p of ["granted", "default"] as const) {
      expect(browserChannel(p).note, p).not.toContain("closed");
    }
  });

  it("offers a button in the one state where a button can do anything", () => {
    // A refusal cannot be re-raised by any page, so `denied` and `unsupported`
    // say where the remedy lives instead of offering a control that would
    // silently fail — the failure browser-react.mjs refuses to ship for its own
    // reactions. `granted` has nothing to offer. That leaves exactly one.
    expect(browserChannel("default").ask).toBe(true);
    for (const p of ["granted", "denied", "unsupported"] as const) {
      expect(browserChannel(p).ask, p).toBe(false);
    }
    expect(soundMenu).toContain("{channel.ask ? (");
    // Its own class, not `.sm-hear`: same small button in the same slot, but
    // "hear" is what the other one does, and a shared name would make every
    // `.sm-hear` lookup return a button that plays nothing.
    expect(soundMenu).toContain('<button type="button" className="btn sm-channel-action" onClick={onAskNotify}>');
    expect(app).toContain("onAskNotify={askForNotifications}");
  });

  it("hides the channel whenever it cannot deliver, rather than asking for nothing", () => {
    // Off: telling somebody to allow a channel for a feature they have just
    // switched off is asking them to work for nothing. Vetoed: the launch flag
    // silences BOTH notifiers, so the channel is moot either way — and the
    // note above has already said what happened.
    expect(soundMenu).toContain("const showChannel = notifyOn && !notifyVetoed;");
    expect(soundMenu).toContain("{showChannel && (");
    expect(NOTIFY_VETO_NOTE).toContain("saved for the next start");
    // The switch still moves under a veto, because the preference is still the
    // user's to record for the next launch.
    expect(soundMenu).toContain("onClick={onToggleNotify}");
  });

  it("styles every class it renders", () => {
    for (const cls of ["sm-switches", "sm-switch", "sm-switch-label", "sm-toggle",
                       "sm-toggle-knob", "sm-setting", "sm-note", "sm-channel-state",
                       "sm-channel", "sm-channel-head", "sm-channel-name", "sm-channel-action",
                       "sm-tones", "sm-tone", "sm-tone-head", "sm-tone-name", "sm-hear"]) {
      expect(css, `.${cls} is unstyled`).toContain(cls);
    }
    expect(css).toContain(".sm-channel-state[data-ok]");
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
      // The same rule one layer out, added later: a background tab's timers are
      // throttled rather than stopped, so a forgotten tab could restart the
      // deck under the tab in use. Set true here because THIS case is about the
      // dismissed banner, and a second `false` would make it pass for the wrong
      // reason.
      visible: true,
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
