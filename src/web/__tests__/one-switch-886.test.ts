// #886: the four on/off switches were four implementations with 35 CSS rules
// between them — `.ap-auto-state`, `.ver-auto`, `.sm-toggle` and `.bw-toggle` —
// so every fix to a switch, its focus, its press or its reduced-motion answer
// had to land four times, and their geometry had drifted apart unmeasured.
// There is one `.switch` now, and it owns the track, the knob, the on-state
// (read off aria-checked), hover, press, focus and disabled.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const SOURCES = ["App.tsx", ...readdirSync(join(web, "components"))
  .filter(f => f.endsWith(".tsx")).map(f => `components/${f}`)]
  // Comments stripped: several of these files still explain the old classes by name.
  .map(rel => [rel, read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")] as const);

const count = (re: RegExp) => SOURCES.reduce((n, [, src]) => n + (src.match(re)?.length ?? 0), 0);

/** The body of the rule written for exactly this selector. */
function body(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? "";
}

describe("every switch is the one switch (#886)", () => {
  it("draws each role=switch as .switch with a knob inside it", () => {
    const switches = count(/role="switch"/g);
    // Thirteen since discovery over Tailscale added its own switch and the two
    // permissions under it; fourteen since Claude FM's mute (#1208), which is a
    // switch and not a speaker glyph because it is an on/off setting that is
    // remembered, and it sits in the Appearance menu under the character switch;
    // fifteen since invite-only pairing (#1236), which was two native radios
    // before it was made one of these.
    expect(switches, "the fifteen switches in the app").toBe(15);
    expect(count(/className="switch(?: ap-auto-state)?"/g)).toBe(switches);
    expect(count(/<span className="switch-knob" \/>/g)).toBe(switches);
  });

  it("leaves no second implementation in the markup", () => {
    for (const [rel, src] of SOURCES) {
      expect(src, rel).not.toMatch(/sm-toggle|bw-toggle/);
      // No class restating the ARIA state the sheet reads for itself.
      expect(src, rel).not.toMatch(/ap-auto-state\$\{|ver-auto\$\{/);
    }
  });

  it("leaves no second implementation in the sheet", () => {
    for (const gone of [".sm-toggle", ".bw-toggle", ".ap-auto-state.live", ".ap-auto-state::after", ".ver-auto i", ".ver-auto.on"]) {
      expect(css, gone).not.toContain(gone);
    }
    // What `.ap-auto-state` still says is only where the switch sits.
    expect(body(".ap-auto-state").trim()).toBe("margin-left: auto;");
  });
});

describe("the one switch owns its states (#886)", () => {
  it("reads on from aria-checked", () => {
    expect(body('.switch[aria-checked="true"]')).toMatch(/background:\s*var\(--accent\)/);
    expect(body('.switch[aria-checked="true"] .switch-knob')).toMatch(/translateX\(12px\)/);
  });

  it("answers hover, press, focus and disabled in one place", () => {
    // Hover is the pointer's feedback, drawn in the foreground like every
    // other control's; the accent stays for the on state and the focus ring.
    expect(body(".switch:hover:not(:disabled)")).toMatch(/border-color:\s*var\(--text\)/);
    expect(body(".switch:active:not(:disabled)")).toMatch(/transform:\s*scale\(0\.97\)/);
    expect(body(".switch:focus-visible")).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(body(".switch:disabled")).toMatch(/opacity:\s*var\(--dim-off\)/);
  });

  it("keeps the geometry the LAN dialog's spacing was argued from", () => {
    const track = body(".switch");
    expect(track).toMatch(/width:\s*30px/);
    expect(track).toMatch(/height:\s*18px/);
    const knob = body(".switch-knob");
    expect(knob).toMatch(/width:\s*12px/);
    expect(knob).toMatch(/height:\s*12px/);
  });

  it("lets the version banner's armed switch keep its warning, and nothing else differ", () => {
    expect(body('.ver-banner .switch[aria-checked="true"]')).toMatch(/background:\s*var\(--warn\)/);
    // The forced-colours block (#871) restates the banner's switch in system
    // colours. That is the same switch answering a Contrast theme, not a second
    // context drawing it differently, so its cascade is read separately.
    const open = "@media (forced-colors: active) {";
    const at = css.indexOf(open);
    let close = at;
    for (let depth = 0, i = at + open.length - 1; at > -1 && i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { close = i; break; }
    }
    const normal = at > -1 ? css.slice(0, at) + css.slice(close + 1) : css;
    const overrides = [...normal.matchAll(/(?:^|\n)([^{}\n]*\.switch\b[^{}\n]*)\{/g)].map(m => m[1].trim())
      .filter(sel => !sel.startsWith(".switch"));
    expect(overrides).toEqual(['.ver-banner .switch[aria-checked="true"]']);
  });
});
