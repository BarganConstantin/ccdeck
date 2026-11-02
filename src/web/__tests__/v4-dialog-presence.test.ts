// R3-3: one shared Dialog, and a dialog that can leave (audit D1, J2, C4).
//
// V4's motion rules for a dialog: Open is scrim opacity and dialog opacity and
// scale 0.96 to 1 on Base 200; Close is scrim, opacity and scale 0.98 on Exit
// 150; reduced motion is opacity only; a key opens and closes with no motion;
// closing during the open or reopening during the close turns around from the
// current frame. A closing dialog holds no focus, Tab, Escape or pointer input.
//
// Plain node, no DOM and no renderer (like modal-focus-trap.test.ts): the
// decision is the pure functions in dialog-presence.ts, driven here on a fake
// clock exactly as Dialog.tsx drives them; what needs a document is pinned by
// reading the source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXIT_SLACK_MS, finish, holdsInput, isDrawn, lastInputWasKey, settle, startPresence, type Presence,
} from "../dialog-presence";
import { createDismissStack } from "../modal-dismiss";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${web}${rel}`, "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

/** What Dialog.tsx's DialogPresence does with the model: a render per flag
 *  change, and a timer for the exit. */
function owner(initial: boolean, ctx: { instant: boolean; hasContent: boolean }) {
  let p: Presence = startPresence(initial);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const set = (open: boolean) => {
    p = settle(p, open, ctx);
    if (timer) { clearTimeout(timer); timer = null; }
    if (p.closing) timer = setTimeout(() => { p = finish(p); timer = null; }, 150 + EXIT_SLACK_MS);
  };
  return { set, get p() { return p; }, get drawn() { return isDrawn(p); } };
}

describe("DialogPresence model", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("closes with the flag set for the exit, then unmounts", () => {
    const o = owner(true, { instant: false, hasContent: true });
    o.set(false);
    expect(o.p).toEqual({ open: false, closing: true });
    expect(o.drawn).toBe(true);
    vi.advanceTimersByTime(149);
    expect(o.drawn).toBe(true);
    vi.advanceTimersByTime(EXIT_SLACK_MS + 1);
    expect(o.p).toEqual({ open: false, closing: false });
    expect(o.drawn).toBe(false);
  });

  it("reopening during the close keeps the node and clears the flag", () => {
    const o = owner(true, { instant: false, hasContent: true });
    o.set(false);
    vi.advanceTimersByTime(60);
    const drawnBefore = o.drawn;
    o.set(true);
    // Never undrawn between the two: the same node, so the CSS transition
    // turns around from where it is rather than from 0.
    expect(drawnBefore).toBe(true);
    expect(o.p).toEqual({ open: true, closing: false });
    vi.advanceTimersByTime(1000);
    expect(o.drawn).toBe(true);
  });

  it("a close that came from a key unmounts at once", () => {
    const o = owner(true, { instant: true, hasContent: true });
    o.set(false);
    expect(o.drawn).toBe(false);
  });

  it("a flag that never rendered anything has nothing to keep", () => {
    const o = owner(false, { instant: false, hasContent: false });
    o.set(true);
    o.set(false);
    expect(o.drawn).toBe(false);
  });

  it("settle returns the same object when nothing changed", () => {
    const p = startPresence(true);
    expect(settle(p, true, { instant: false, hasContent: true })).toBe(p);
    const g = startPresence(false);
    expect(settle(g, false, { instant: false, hasContent: true })).toBe(g);
    expect(finish(p)).toBe(p);
  });

  it("reads the key from input-modality's flag on the root", () => {
    expect(lastInputWasKey({ dataset: { motion: "instant" } })).toBe(true);
    expect(lastInputWasKey({ dataset: {} })).toBe(false);
    expect(lastInputWasKey(null)).toBe(false);
  });

  it("the exit timer is the exit token plus a fallback margin", () => {
    const src = read("components/Dialog.tsx");
    expect(src).toMatch(/tokenMs\("--dur-exit"\) \+ EXIT_SLACK_MS/);
    expect(src).toMatch(/e\.propertyName === "opacity"/);
  });
});

describe("a closing dialog holds nothing", () => {
  it("holdsInput is the one question", () => {
    expect(holdsInput(false)).toBe(true);
    expect(holdsInput(true)).toBe(false);
  });

  it("with its entry popped, Escape belongs to what is under it", () => {
    const stack = createDismissStack();
    const under = vi.fn();
    const leaving = vi.fn();
    stack.push(under);
    const pop = stack.push(leaving);
    expect(stack.isTop(leaving)).toBe(true);
    pop(); // what useModalDismiss's effect cleanup does the moment close starts
    expect(stack.dismissTop()).toBe(true);
    expect(leaving).not.toHaveBeenCalled();
    expect(under).toHaveBeenCalledTimes(1);
  });

  const hook = code(read("components/use-modal-dismiss.ts"));

  it("the hook reads the presence context and acts on it", () => {
    expect(hook).toMatch(/const active = holdsInput\(useDialogClosing\(\)\);/);
    // The stack entry exists only while active.
    expect(hook).toMatch(/useEffect\(\(\) => \(active \? modalStack\.push\(dismiss, layer, kind\) : undefined\), \[dismiss, layer, kind, active\]\);/);
    // Focus enters when active and goes back when it stops being: the cleanup
    // runs at the start of the close, not at the unmount.
    expect(hook).toMatch(/if \(!active\) return;\s*const opener = document\.activeElement/);
    expect(hook).toMatch(/shouldRestoreFocus\(opener, document\.activeElement\)\) opener!\.focus\(\)/);
    expect(hook).toMatch(/\}, \[active\]\);/);
    // Tab is trapped only while active.
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*if \(!active\) return;\s*const onKey/);
    expect(hook).toMatch(/\}, \[dismiss, active\]\);/);
  });
});

describe("the shell", () => {
  const shell = code(read("components/Dialog.tsx"));

  it("renders the shared markup with the state on the scrim", () => {
    expect(shell).toMatch(/modal-backdrop/);
    expect(shell).toMatch(/role="presentation"/);
    expect(shell).toMatch(/data-state=\{closing \? "closing" : "open"\}/);
    expect(shell).toMatch(/role="dialog"/);
    expect(shell).toMatch(/aria-modal="true"/);
    expect(shell).toMatch(/aria-labelledby=\{labelledBy\}/);
    expect(shell).toMatch(/\{\.\.\.scrim\}/);
  });

  it("makes the leaving node inert, and keeps the last children while it leaves", () => {
    expect(shell).toMatch(/closing \? \{ inert: "" \} : \{\}/);
    expect(shell).toMatch(/if \(open\) last\.current = children\(when as Truthy<T>\);/);
    expect(shell).toMatch(/<PresenceContext\.Provider value=\{value\}>\{last\.current\}/);
  });

  it("the × is the kit's icon button, with the label as name and title", () => {
    expect(shell).toMatch(/className="glyph-btn" onClick=\{onClick\} aria-label=\{label\} title=\{label\}/);
  });
});

// --- every dialog goes through the shell and its mount through the presence ---

const COMPONENTS = fileURLToPath(new URL("../components/", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? tsxFiles(`${dir}${e.name}/`) : e.name.endsWith(".tsx") ? [`${dir}${e.name}`] : []);
}

/** Real exceptions to "a scrim is the shared shell's". */
const SCRIM_ALLOWLIST: readonly { file: string; why: string }[] = [
  { file: "Dialog.tsx", why: "it is the shell" },
  { file: "QuickOpen.tsx", why: "a command field with its own keyframes and unmount-at-once (D19 removes its motion); it shares only the scrim's class, and dialogs.css keeps the shared transition off it" },
];

describe("every dialog is the shared shell", () => {
  const files = tsxFiles(COMPONENTS);

  it("no component draws its own modal-backdrop", () => {
    const offenders = files
      .filter(f => /["'`]modal-backdrop[ "'`]/.test(code(readFileSync(f, "utf8"))))
      .map(f => f.slice(COMPONENTS.length))
      .filter(f => !SCRIM_ALLOWLIST.some(a => a.file === f));
    expect(offenders).toEqual([]);
  });

  it("every allowlisted exception says why", () => {
    for (const a of SCRIM_ALLOWLIST) expect(a.why.length).toBeGreaterThan(10);
  });

  /** The dialog components whose mounts must go through DialogPresence. */
  const DIALOGS = [
    "AccountAttentionModal", "AccountProjectsModal", "AccountsUsageReport", "AddAccountDialog",
    "AddCodexAccountDialog", "BrowserWatchModal", "ClearConfirm", "ContextModal", "ExploreIntegrationsModal",
    "FeedbackDialog", "GuideModal", "IntegrationModal", "KeyboardHelp", "LanAddDeckModal", "LanNetworkMap",
    "LanPairRequestModal", "LanPeerModal", "LanSetupModal", "ProcessListModal", "QuotaHistoryModal",
    "ReleaseNotesModal", "SectionHistoryModal", "SessionSummary", "SessionUsageModal", "SettingsModal",
    "ShareAccountsDialog", "HostsDialog", "ToolAuditModal", "ToolModal", "TrafficRadar", "UsageHistoryModal",
    "AccountCapacityDialog",
  ];
  /** A mount that is not an open/close of its own: the component's own file
   *  declares it, or the mount is the lazy chunk's fallback. */
  const MOUNT_ALLOWLIST: readonly { file: string; name: string; why: string }[] = [
    { file: "LanPairRequestModal.tsx", name: "LanPairRequestModal", why: "the dialog's own declaration and its presence-wrapped mount are read together below" },
  ];

  it("every mount of a dialog sits inside a DialogPresence", () => {
    const bad: string[] = [];
    for (const f of files) {
      const rel = f.slice(COMPONENTS.length);
      const src = code(readFileSync(f, "utf8"));
      for (const name of DIALOGS) {
        const re = new RegExp(`<${name}(?![A-Za-z])`, "g");
        for (const m of src.matchAll(re)) {
          if (MOUNT_ALLOWLIST.some(a => a.file === rel && a.name === name)) continue;
          const before = src.slice(0, m.index);
          const open = before.lastIndexOf("<DialogPresence");
          const close = before.lastIndexOf("</DialogPresence>");
          if (open === -1 || close > open) bad.push(`${rel}: <${name}`);
        }
      }
    }
    // App.tsx and the other non-component files too.
    for (const rel of ["App.tsx"]) {
      const src = code(read(rel));
      for (const name of DIALOGS) {
        for (const m of src.matchAll(new RegExp(`<${name}(?![A-Za-z])`, "g"))) {
          const before = src.slice(0, m.index);
          if (before.lastIndexOf("<DialogPresence") === -1 || before.lastIndexOf("</DialogPresence>") > before.lastIndexOf("<DialogPresence")) bad.push(`${rel}: <${name}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// --- the sheet ---

describe("dialogs.css: transitions, not keyframes", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, selector).not.toBeNull();
    return m![1];
  };

  it(".modal and its scrim have no animation, only transitions on the Base token and the house ease", () => {
    expect(rule(".modal")).not.toMatch(/animation\s*:/);
    expect(rule(".modal-backdrop")).not.toMatch(/animation\s*:/);
    expect(rule(".modal")).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\), transform var\(--dur-base\) var\(--ease\)/);
    expect(rule(".modal-backdrop")).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\)/);
  });

  it("opens from opacity 0 and the enter scale", () => {
    expect(css).toMatch(/@starting-style\s*\{\s*\.modal-backdrop\s*\{\s*opacity:\s*0;\s*\}\s*\}/);
    expect(css).toMatch(/@starting-style\s*\{\s*\.modal\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(var\(--enter-scale\)\);\s*\}\s*\}/);
  });

  it("closes on the Exit token to the exit scale, and takes no pointer input", () => {
    const scrim = rule('.modal-backdrop[data-state="closing"]');
    expect(scrim).toMatch(/opacity:\s*0/);
    expect(scrim).toMatch(/pointer-events:\s*none/);
    expect(scrim).toMatch(/transition-duration:\s*var\(--dur-exit\)/);
    const surface = rule('.modal-backdrop[data-state="closing"] > .modal');
    expect(surface).toMatch(/opacity:\s*0/);
    expect(surface).toMatch(/transform:\s*scale\(var\(--exit-scale\)\)/);
    expect(surface).toMatch(/transition-duration:\s*var\(--dur-exit\)/);
    expect(read("styles/tokens.css")).toMatch(/--exit-scale:\s*0\.98;/);
  });

  it("reduced motion is opacity only, with the same durations", () => {
    const m = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.modal\s*\{\s*transition-property:\s*opacity;\s*\}\s*@starting-style\s*\{\s*\.modal\s*\{\s*transform:\s*none;\s*\}\s*\}\s*\.modal-backdrop\[data-state="closing"\] > \.modal\s*\{\s*transform:\s*none;\s*\}\s*\}/.exec(css);
    expect(m).not.toBeNull();
  });

  it("a key turns every motion off", () => {
    expect(css).toMatch(/:root\[data-motion="instant"\] :is\(\.modal-backdrop, \.modal\)\s*\{\s*transition:\s*none;\s*\}/);
  });

  it("popIn is gone: nothing else used it", () => {
    expect(css).not.toMatch(/popIn\s*[{\s]/);
  });
});

describe("dialogs.css: the header and the × are V4's Figma", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, selector).not.toBeNull();
    return m![1];
  };

  it("the header band is 44 at the default density, with the 1px rule below it", () => {
    const reading = read("styles/reading.css");
    expect(/:root\[data-density="tighter"\],\s*:root\[data-density="compact"\]\s*\{[^}]*--dialog-head-h:\s*44px;/.exec(reading)).not.toBeNull();
    const head = rule(".modal-head");
    expect(head).toMatch(/min-height:\s*var\(--dialog-head-h\)/);
    expect(head).toMatch(/box-sizing:\s*content-box/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--line-soft\)/);
    expect(head).toMatch(/padding:\s*0 8px 0 16px/);
    expect(head).toMatch(/align-items:\s*center/);
  });

  it("the footer is 48 with the rule above it", () => {
    const foot = rule(".modal-foot");
    expect(foot).toMatch(/min-height:\s*var\(--dialog-foot-h\)/);
    expect(foot).toMatch(/box-sizing:\s*content-box/);
    expect(read("styles/reading.css")).toMatch(/--dialog-foot-h:\s*48px;/);
  });

  it("the × is 28x28, radius --r-ctl, a 14px glyph", () => {
    const x = rule(":where(.modal-head, .modal-actions) .glyph-btn");
    expect(x).toMatch(/width:\s*28px/);
    expect(x).toMatch(/height:\s*28px/);
    expect(x).toMatch(/border-radius:\s*var\(--r-ctl\)/);
    expect(x).toMatch(/font-size:\s*calc\(14px/);
  });

  it("the Usage header's buttons and the recap pin lose the circle", () => {
    expect(rule(".up-header-right > .glyph-btn,\n.agent-node .recap-pin")).toMatch(/border-radius:\s*var\(--r-ctl\)/);
    expect(rule('.agent-node .recap-pin[aria-expanded="true"]')).toMatch(/border-radius:\s*var\(--r-ctl\)/);
  });
});
