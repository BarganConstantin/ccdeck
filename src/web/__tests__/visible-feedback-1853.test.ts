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
// dialogs hook, and the Appearance switch and its note stay where they were.
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

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const runs = read("../components/TopbarRuns.tsx");
const dialogs = read("../use-dialogs.ts");
const deckDialogs = read("../components/DeckDialogs.tsx");
const feedback = read("../components/FeedbackDialog.tsx");
const boundary = read("../components/ErrorBoundary.tsx");
const popover = read("../components/AccountIssuePopover.tsx");
const accounts = read("../components/AccountsPanel.tsx");

// ── the scrub, mirrored in the browser for the words shown before Send ────────

describe("scrubReport takes identifying text out of a message shown on the page", () => {
  it.each([
    // The user segment goes; the tail stays, so a stack still says where — the
    // same shape the server's scrub keeps (scrubbing, in reports-1853.test.ts).
    ["/home/alice/x threw", "~/x threw"],
    ["/Users/Bob/Library/ccdeck", "~/Library/ccdeck"],
    ["C:\\Users\\Bob Smith\\AppData\\ccdeck", "~\\AppData\\ccdeck"],
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
    expect(feedback).toMatch(/export interface FeedbackPrefill/);
    expect(feedback).toMatch(/useState<Kind>\(initialKind \?\? "bug"\)/);
    expect(feedback).toMatch(/useState\(initialBody \?\? ""\)/);
    // The title is never seeded — a person names their own report.
    expect(feedback).toMatch(/const \[title, setTitle\] = useState\(""\)/);
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
    expect(dialogs).toMatch(/useModalGate\(\{[\s\S]*?keyHelpOpen, releaseNotes,\s*feedbackOpen,\s*\}\)/);
  });

  it("clears the prefill when the dialog closes, so a blank open cannot inherit one", () => {
    expect(deckDialogs).toMatch(/initialKind=\{feedbackPrefill\?\.initialKind\}/);
    expect(deckDialogs).toMatch(/initialBody=\{feedbackPrefill\?\.initialBody\}/);
    expect(deckDialogs).toMatch(/setFeedbackOpen\(false\); setFeedbackPrefill\(null\)/);
  });
});

// ── door one: the topbar ─────────────────────────────────────────────────────

describe("the topbar's Feedback button", () => {
  /** The opening tag and body of the button, up to its close. */
  const button = (() => {
    const at = runs.indexOf('aria-label="Send feedback"');
    expect(at, "no Send feedback button in TopbarRuns.tsx").toBeGreaterThan(-1);
    return runs.slice(runs.lastIndexOf("<button", at), runs.indexOf("</button>", at));
  })();

  it("is a topbar icon button that opens the dialog through the one door", () => {
    expect(button).toMatch(/className="btn icon-btn"/);
    expect(button).toMatch(/onClick=\{onFeedback\}/);
    expect(button).toMatch(/aria-haspopup="dialog"/);
    expect(button).toMatch(/title="Send feedback/);
  });

  it("draws its glyph on the topbar's one icon spec (#837), and says its word beside it", () => {
    expect(button).toMatch(/<svg width="13" height="13" viewBox="0 0 14 14"[\s\S]*?strokeWidth="1\.4"/);
    // It was a bare glyph beside the theme button, on the reasoning that the
    // bar's words were a set of seven. At the toolbar's --muted, next to
    // "Sound" and "Browser watch", the bubble read as nothing at all and the
    // owner could not find it. It says its word now, from the width where the
    // busiest bar still holds it (topbar-words-836.test.ts).
    expect(button).toMatch(/<span className="tb-word-wide">Feedback<\/span>/);
  });

  it("sits in the settings run, and opens the same dialog Appearance's Send feedback does", () => {
    // Both call onFeedback; App routes that through the dialogs hook's one door.
    expect(button.indexOf("onFeedback")).toBeGreaterThan(-1);
    expect(runs).toMatch(/onFeedback=\{\(\) => \{ setAppearanceMenuOpen\(false\); onFeedback\(\); \}\}/);
    expect(app).toMatch(/onFeedback=\{\(\) => dialogs\.openFeedback\(\)\}/);
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
    expect(boundary).toMatch(/className="error-fallback" role="alert"/);
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
