// Reporting a problem, made findable (#1853).
//
// The only way to tell the makers something was buried: Appearance → "Help
// improve ccdeck" → "Send feedback…", behind the theme and a radio, and the
// owner could not find it. And when the deck itself crashed there was nothing at
// all — a render error blanked the page, with no message and no way to report
// what had happened.
//
// So there are three new doors, all onto the one feedback dialog:
//   - a "Feedback" button in the topbar's utility run, beside the two
//     settings, where a product keeps its help;
//   - an error boundary around the whole app that shows a calm pane with Reload
//     and Send report, the report opened already filled in as a bug;
//   - a quiet "Report this" on an account warning's popover.
// The dialog gained a prefill (initialKind, initialBody), threaded through the
// dialogs hook.
//
// The Appearance section it was buried in — "Help improve ccdeck", with the
// usage-reports switch, its note and "Send feedback…" — is gone (the owner's
// call, 2026-10-01). Reports stay on, with AGENTS_DECK_NO_REPORTS=1 the way to
// keep them off, and the topbar's Feedback button is the one door from the bar.
//
// Plain node, no renderer — the suite cannot draw React (see
// topbar-interaction.test.ts) — so the pure seams (the scrub, the crash body,
// the forward) are exercised directly and the wiring is read off the source, the
// way the topbar and modal files here already do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crashReportBody } from "../components/ErrorBoundary";
import { forwardCaughtError, scrubReport } from "../report-errors";
import { feedbackSeed } from "../feedback-draft";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
// The topbar's utility run is UtilityRun now (components/EdgeRails.tsx), and the
// controls it draws are defined in rail-items.tsx: the panel toggles left the
// bar for the window's edges (2026-10-08) and Settings and Feedback stayed.
const items = read("../rail-items.tsx");
const rails = read("../components/EdgeRails.tsx");
const edgeSheet = read("../styles/edge-rails.css").replace(/\/\*[\s\S]*?\*\//g, "");
// The Appearance menu became Settings (2026-10-07): the dialog and each
// section in it, read as one, so the negatives below still see every control
// that used to be Appearance's and every one that joined it.
const settingsSurface = [
  "../components/SettingsModal.tsx", "../components/ThemeSection.tsx", "../components/MusicSection.tsx",
  "../components/NotificationsSection.tsx", "../components/SoundsSection.tsx", "../components/SoundSwitch.tsx",
].map(read).join("\n");
const reportsHook = read("../use-reports.ts");
const dialogs = read("../use-dialogs.ts");
const deckDialogs = read("../components/DeckDialogs.tsx");
const feedback = read("../components/FeedbackDialog.tsx");
const rules = read("../feedback.ts");
const boundary = read("../components/ErrorBoundary.tsx");
const popover = read("../components/AccountIssuePopover.tsx");
const accounts = read("../components/AccountsPanel.tsx");

// ── the scrub, mirrored in the browser for the words shown before Send ────────

describe("scrubReport takes identifying text out of a message shown on the page", () => {
  it.each([
    // The user segment goes, and the rest of the path with it — the same shape
    // the server's scrub sends (error-report-paths.test.ts has every shape).
    ["/home/alice/x threw", "~/<path> threw"],
    ["/Users/Bob/Library/ccdeck", "~/<path>"],
    ["C:\\Users\\Bob Smith\\AppData\\ccdeck", "~\\<path>"],
    ["mail bob@example.org now", "mail <email> now"],
    ["token sk-ant-abcdefghijklmnop failed", "token <secret> failed"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "<secret>"],
    ["Cannot read properties of undefined (reading 'agents')", "Cannot read properties of undefined (reading 'agents')"],
  ])("%s → %s", (input, output) => {
    expect(scrubReport(input)).toBe(output);
  });

  it("survives a null or a number without throwing", () => {
    expect(scrubReport(null as unknown as string)).toBe("");
    expect(scrubReport(42 as unknown as string)).toBe("42");
  });
});

// ── the crash report the boundary opens the dialog with ──────────────────────

describe("crashReportBody seeds a report with the error and nothing that names anyone", () => {
  it("carries the message on its own when there is no component stack", () => {
    expect(crashReportBody("Cannot read properties of undefined (reading 'agents')"))
      .toBe("Cannot read properties of undefined (reading 'agents')");
  });

  it("appends the component path when React gave one", () => {
    const body = crashReportBody("boom", "\n    at AgentNode\n    at Inner");
    expect(body).toContain("boom");
    expect(body).toContain("at AgentNode");
    expect(body).toContain("at Inner");
    // The message and the stack are separated, not run together.
    expect(body.indexOf("boom")).toBeLessThan(body.indexOf("at AgentNode"));
  });

  it("scrubs a path, an address and a key out of both halves", () => {
    const body = crashReportBody(
      "EACCES on /home/alice/.claude for alice@example.com with sk-ant-abcdefghijklmnop",
      "\n    at save (/Users/alice/app/x.tsx)",
    );
    expect(body).not.toContain("alice");
    expect(body).not.toContain("example.com");
    expect(body).not.toContain("sk-ant");
    expect(body).toContain("~");
    expect(body).toContain("<email>");
    expect(body).toContain("<secret>");
  });

  it("still says something for an error with no message", () => {
    expect(crashReportBody("").length).toBeGreaterThan(0);
    expect(crashReportBody("").toLowerCase()).toContain("error");
  });

  it("keeps the seeded path to a bounded number of frames", () => {
    const long = Array.from({ length: 40 }, (_, i) => `    at C${i}`).join("\n");
    const lines = crashReportBody("boom", long).split("\n");
    // The message, a blank line, and at most a dozen frames — not all forty.
    expect(lines.length).toBeLessThan(20);
  });
});

// ── forwarding a caught error, the same route a page error takes ──────────────

describe("forwardCaughtError hands the error to the deck's own server", () => {
  it("sends the message and the stack, so a caught crash is not lost", () => {
    const sent: { message: string; stack?: string }[] = [];
    forwardCaughtError("render blew up", "at Inner", body => sent.push(body));
    expect(sent).toEqual([{ message: "render blew up", stack: "at Inner" }]);
  });

  it("sends nothing for an error with no message", () => {
    const sent: unknown[] = [];
    forwardCaughtError("", undefined, () => sent.push(true));
    forwardCaughtError(null, undefined, () => sent.push(true));
    expect(sent).toEqual([]);
  });

  it("leaves the message unscrubbed here, because the server scrubs what it forwards", () => {
    // The forward reuses report-errors' post and the server's scrub — unlike the
    // on-screen prefill, which is scrubbed here because feedback is not.
    const sent: { message: string }[] = [];
    forwardCaughtError("/home/alice/x threw", undefined, body => sent.push(body));
    expect(sent[0].message).toContain("/home/alice/x");
  });
});

// ── the dialog takes a prefill, and is unchanged without one ─────────────────

describe("the feedback dialog can be opened filled in", () => {
  it("takes an initial kind and body, defaulting to the empty blank report", () => {
    expect(rules).toMatch(/export interface FeedbackPrefill/);
    expect(feedback).toMatch(/interface Props extends FeedbackPrefill/);
    // The prefill is the seed the dialog opens on when this door kept no
    // draft; a kept draft comes first (feedback-draft-kept.test.ts runs both).
    expect(feedbackSeed({})).toEqual({ kind: "bug", body: "" });
    expect(feedbackSeed({ initialKind: "other", initialBody: "Account issue: rate limited." }))
      .toEqual({ kind: "other", body: "Account issue: rate limited." });
    expect(feedback).toMatch(/const seed = feedbackSeed\(\{ initialKind, initialBody \}\);/);
    expect(feedback).toMatch(/useState<Kind>\(kept\?\.kind \?\? seed\.kind\)/);
    expect(feedback).toMatch(/useState\(kept\?\.body \?\? seed\.body\)/);
    // It used to pin that a typed title was never seeded. There is no title
    // to type now — the title is worked out from the message as it is sent
    // (feedback-dialog-form.test.ts) — so a seeded body names a seeded report
    // the way a typed one does, and the dialog holds no title of its own.
    expect(feedback).not.toMatch(/setTitle|id="fb-title"/);
  });
});

// ── the dialogs hook threads a prefill without moving the modal gate ──────────

describe("the dialogs hook gives every opener one door", () => {
  it("has an openFeedback that seeds a prefill and opens", () => {
    expect(dialogs).toMatch(/const openFeedback = useCallback\(\(prefill\?: FeedbackPrefill\) => \{/);
    expect(dialogs).toMatch(/setFeedbackPrefill\(prefill \?\? null\)/);
    expect(dialogs).toMatch(/openFeedback,?\s/);
  });

  it("leaves the modal gate reading feedbackOpen, exactly as it did", () => {
    // The gate is what other suites pin; the prefill is new state beside it, not
    // a change to the call.
    expect(dialogs).toMatch(/useModalGate\(\{[\s\S]*?keyHelpOpen, releaseNotes,\s*feedbackOpen, trafficRadarOpen,\s*\}\)/);
  });

  it("clears the prefill when the dialog closes, so a blank open cannot inherit one", () => {
    expect(deckDialogs).toMatch(/initialKind=\{feedbackPrefill\?\.initialKind\}/);
    expect(deckDialogs).toMatch(/initialBody=\{feedbackPrefill\?\.initialBody\}/);
    expect(deckDialogs).toMatch(/setFeedbackOpen\(false\); setFeedbackPrefill\(null\)/);
  });
});

// ── door one: the topbar ─────────────────────────────────────────────────────

describe("the topbar's Feedback button", () => {
  /** Feedback's definition, from its id to the end of the item. */
  const item = (() => {
    const at = items.indexOf('id: "feedback"');
    expect(at, "no feedback control in rail-items.tsx").toBeGreaterThan(-1);
    return items.slice(at, items.indexOf("};", at));
  })();

  it("is a topbar control that opens the dialog through the one door", () => {
    expect(item).toMatch(/ariaLabel: "Send feedback"/);
    expect(item).toMatch(/kind: "dialog"/);
    expect(item).toMatch(/onPress: onFeedback/);
    // A modal behind it, so the button says so and holds no state.
    expect(rails).toMatch(/aria-haspopup=\{disclosure \? undefined : "dialog"\}/);
    // On the bar, in the utility run beside the gear, at every desktop width.
    expect(items).toMatch(/utilities: \[settings, feedback\]/);
    expect(app).toMatch(/\{!phone && <div className="actions"><UtilityRun items=\{rails\.utilities\} \/><\/div>\}/);
  });

  it("draws its glyph on the chrome's one icon spec (#837), and says its word beside it at every desktop width", () => {
    expect(item).toMatch(/glyph: <FeedbackGlyph \/>/);
    expect(read("../components/rail-glyphs.tsx")).toMatch(/export const FeedbackGlyph = \(\) => \(\s*<Glyph>/);
    // It was a bare glyph beside the theme button, on the reasoning that the
    // bar's words were a set of seven, and at the toolbar's --muted the bubble
    // read as nothing at all; the owner could not find it. Then it said its
    // word only from 1707px, where the busiest bar of eight controls still
    // held it. The controls are on the edges now, so the bar has the room at
    // every width the bar draws them: the word is the label, always, and no
    // rule in the sheet hides it.
    expect(item).toMatch(/label: "Feedback"/);
    expect(rails).toMatch(/aria-label=\{item\.ariaLabel\}/);
    expect(rails).toMatch(/variant !== "stripe" && <span className="rail-word">/);
    expect(edgeSheet).not.toMatch(/rail-btn-bar[^{]*\.rail-word[^{]*\{[^}]*display:\s*none/);
    expect(edgeSheet).not.toMatch(/\.utility-run[^{]*\{[^}]*display:\s*none/);
  });

  it("is in the phone's dock too, by its whole name, behind More", () => {
    // Under 641px the dock stands in for the stripes and the utilities, and
    // the three rare dialogs — History, Browser watch, Feedback — sit behind
    // More, where a row has the room to say "Send feedback" whole.
    expect(item).toMatch(/menu: "Send feedback"/);
    expect(app).toMatch(/more=\{\[\.\.\.rails\.right\[1\], rails\.utilities\[1\]\]\}/);
    expect(rails).toMatch(/item\.menu \?\? item\.label/);
  });

  it("is the chrome's one way to the dialog, routed through the dialogs hook's one door", () => {
    // In the body that builds the controls, onFeedback is read once: by
    // Feedback's own press, and by no other control.
    const body = items.slice(items.indexOf("}): RailItems {"));
    expect(body.match(/\bonFeedback\b/g), "onFeedback is read once, by Feedback's press").toHaveLength(1);
    expect(body).toMatch(/onPress: onFeedback/);
    expect(app).toMatch(/onFeedback: dialogs\.openFeedback,/);
  });
});

// ── Appearance no longer holds a reports switch or a second feedback door ─────

describe("Settings, which the Appearance menu became, has no Help improve ccdeck section (2026-10-01)", () => {
  /** The <SettingsModal … /> element as the dialog stack mounts it. */
  const mounted = (() => {
    const at = deckDialogs.indexOf("<SettingsModal");
    expect(at, "no SettingsModal in DeckDialogs.tsx").toBeGreaterThan(-1);
    return deckDialogs.slice(at, deckDialogs.indexOf("/>", at));
  })();

  it("draws no reports switch, no note about reports and no Send feedback button", () => {
    for (const gone of ["Help improve ccdeck", "appearance-improve", "Send usage reports", "appearance-reports", "Send feedback"]) {
      expect(settingsSurface, gone).not.toContain(gone);
    }
  });

  it("takes no reports or feedback props, and is handed none", () => {
    for (const prop of ["reportsOn", "reportsVetoed", "onToggleReports", "onFeedback"]) {
      expect(settingsSurface, prop).not.toMatch(new RegExp(`\\b${prop}\\b`));
      expect(mounted, prop).not.toMatch(new RegExp(`\\b${prop}\\b`));
    }
    expect(app).not.toMatch(/reports=\{reports\}/);
  });

  it("still reads whether reports are on, because the page's errors are forwarded only while they are", () => {
    // The switch went; the gate did not. Off until /api/prefs has been read, then
    // on unless the prefs hold false or the machine vetoed it at launch.
    expect(reportsHook).toMatch(/sending\.current = reportsOn === true && !reportsVetoed;/);
    expect(reportsHook).toMatch(/useEffect\(\(\) => forwardPageErrors\(\(\) => sending\.current\), \[\]\)/);
    expect(reportsHook).toMatch(/setReportsOn\(d\.prefs\?\.reports !== false\)/);
    expect(reportsHook).toMatch(/setReportsVetoed\(d\.reportsVetoed === true\)/);
    expect(app).toMatch(/loadReportsPrefs: reports\.loadReportsPrefs/);
    // Nothing on the page can change them any more.
    expect(reportsHook).not.toContain("/api/reports");
  });
});

// ── door two: the error boundary ─────────────────────────────────────────────

describe("the error boundary catches a render crash and offers a report", () => {
  it("is a real boundary that does not swallow the error", () => {
    expect(boundary).toMatch(/static getDerivedStateFromError/);
    expect(boundary).toMatch(/componentDidCatch\(error: Error, info: ErrorInfo\)/);
    // Logged, and forwarded the same way a page error is — not caught and dropped.
    expect(boundary).toMatch(/console\.error\(/);
    expect(boundary).toMatch(/forwardCaughtError\(error\.message, error\.stack\)/);
  });

  it("wraps the whole app in App.tsx", () => {
    expect(app).toMatch(/<ErrorBoundary>\s*<Inner \/>\s*<\/ErrorBoundary>/);
    expect(app).toMatch(/import ErrorBoundary from "\.\/components\/ErrorBoundary"/);
  });

  it("shows a calm reachable pane with Reload and Send report", () => {
    // The card is the alert, not the pane, so the report dialog is not read
    // out inside it (crash-pane-alert.test.ts draws it).
    expect(boundary).toMatch(/className="error-fallback-card" role="alert"/);
    expect(boundary).toMatch(/Something went wrong/);
    expect(boundary).toMatch(/onClick=\{\(\) => window\.location\.reload\(\)\}/);
    expect(boundary).toMatch(/>\s*Reload\s*</);
    expect(boundary).toMatch(/>\s*Send report\s*</);
    // The fallback title is not a heading — the page's one <h1> is the wordmark
    // (landmark-outline.test.ts) — and there is no scrim class that would fold
    // it into the modal sweeps.
    expect(boundary).not.toMatch(/<h[1-6][\s>]/);
    expect(boundary).not.toMatch(/backdrop/);
  });

  it("opens the dialog prefilled as a bug, seeded from the crash", () => {
    expect(boundary).toMatch(/<FeedbackDialog\s+initialKind="bug"\s+initialBody=\{crashReportBody\(error\.message, componentStack\)\}/);
  });
});

// ── door three: the account issue popover ────────────────────────────────────

describe("an account warning's popover can report itself", () => {
  it("draws a quiet Report this only when reporting is wired up", () => {
    expect(popover).toMatch(/onReport\?: \(\) => void/);
    expect(popover).toMatch(/\{onReport && \(\s*<button type="button" className="ap-issue-report" onClick=\{\(\) => \{ onClose\(\); onReport\(\); \}\}/);
  });

  it("keeps its single sign-in call, so Report this did not touch the fix", () => {
    // stale-login-badge.test.ts pins the fix; this guards the count from here.
    expect((popover.match(/onSignIn\(\)/g) ?? []).length).toBe(1);
  });

  it("is wired by the panel with the issue's words and never the account's name", () => {
    // The prefill carries what is wrong, in the product's voice; `who` is the
    // account name and is deliberately not in it.
    const at = accounts.indexOf("onReport={onReport && (()");
    expect(at, "the panel does not wire the popover's report").toBeGreaterThan(-1);
    const wiring = accounts.slice(at, accounts.indexOf("})}", at));
    expect(wiring).toMatch(/initialKind: issue\.tone === "warn" \? "bug" : "other"/);
    expect(wiring).toMatch(/initialBody: `[^`]*\$\{issue\.text\}[^`]*\$\{issue\.hint\}`/);
    expect(wiring).not.toContain("who");
    // And App hands the panel the one door.
    expect(app).toMatch(/<AccountsPanel[^>]*onReport=\{dialogs\.openFeedback\}/);
  });
});
