// An account row's ⋯ opens a menu over the column now, not a form inside the
// row (AccountsPanel, AnchoredPopover). It used to open the row into a block —
// name field, slot picker, share and remove at once — that pushed every
// account under it down the panel.
//
// The panel cannot be rendered here — plain node, no DOM — so this reads the
// markup and the sheet the way manage-block.test.ts does, and pins the shape of
// the interaction: what the row may hold, what the menu offers and in what
// order, which controls exist only once their item is chosen, where the
// surface sits, and which colours its states are allowed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Markup without its comments: they quote the shapes they replaced. */
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const panel = strip(read("../components/AccountsPanel.tsx"));
const popover = strip(read("../components/AnchoredPopover.tsx"));
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rules only: a reduced-motion override is not the resting look. */
const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
const RULES = [...topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")),
  body: m[2],
}));
function decl(selector: string, prop: string): string | null {
  const body = RULES.filter(r => r.sels.includes(selector)).map(r => r.body).join(";");
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/** One account's row, from its <li> to its </li>. */
const row = /<li key=\{a\.num\} className=\{`ap-account[\s\S]*?<\/li>/.exec(panel)![0];

/** One view of the popover, up to the next view or the popover's end. */
function view(name: "menu" | "rename" | "move" | "share"): string {
  const at = panel.indexOf(`menu.view === "${name}" &&`);
  expect(at, name).toBeGreaterThan(-1);
  const ends = ["menu", "rename", "move", "share"]
    .map(n => panel.indexOf(`menu.view === "${n}" &&`, at + 1))
    .concat(panel.indexOf("</AnchoredPopover>", at))
    .filter(i => i > at);
  return panel.slice(at, Math.min(...ends));
}

describe("the row keeps its shape when its ⋯ is pressed", () => {
  it("holds no form control and no manage block of its own", () => {
    expect(row).not.toMatch(/<input|<select|<form/);
    expect(row).not.toMatch(/ap-manage-\$\{|role="group"/);
    expect(row).not.toMatch(/menuFor === a\.num && \(/);
  });

  it("opens from a trigger that says what it opens, and for which account", () => {
    const trigger = /<button type="button" id=\{`ap-more-\$\{a\.num\}`\}[\s\S]*?<\/button>/.exec(row)![0];
    expect(trigger).toMatch(/aria-haspopup="menu"/);
    expect(trigger).toMatch(/aria-expanded=\{menuFor === a\.num\}/);
    expect(trigger).toMatch(/aria-controls=\{menuFor === a\.num \? `ap-menu-\$\{a\.num\}` : undefined\}/);
    expect(trigger).toMatch(/title="More actions"/);
    // The account in the name, from the account's own data.
    expect(trigger).toMatch(/aria-label=\{`More actions for \$\{a\.email \?\? a\.alias \?\? `account \$\{a\.num\}`\}`\}/);
    // Drawn, not typed.
    expect(trigger).toMatch(/<svg[^>]*aria-hidden/);
    expect(trigger).not.toMatch(/⋯/);
  });
});

describe("the menu", () => {
  it("offers its items in the order they are reached for, the irreversible one last", () => {
    // Four always, and a fifth — holding the account out of rotation, or
    // putting it back — whenever that means something: it moved here off the
    // row, where it was a word under every account while auto-switch ran.
    const menu = view("menu");
    expect([...menu.matchAll(/role="menuitem"/g)]).toHaveLength(5);
    const order = [">Rename</button>", ">Move to slot…</button>", ': "Share"}', ': "Hold out of rotation"}', 'role="separator"', ': "Remove"}']
      .map(s => menu.indexOf(s));
    expect(order.every(i => i >= 0), order.join()).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("carries the error colour on Remove alone", () => {
    expect([...panel.matchAll(/ap-menu-item danger/g)]).toHaveLength(1);
    expect(view("menu")).toMatch(/className=\{`ap-menu-item danger\$\{confirmRemove === a\.num \? " armed" : ""\}`\}/);
  });

  it("shows no field until its item is chosen", () => {
    expect(view("menu")).not.toMatch(/<input|<select/);
    expect(view("rename")).toMatch(/id=\{`ap-alias-\$\{a\.num\}`\}/);
    expect(view("move")).toMatch(/id=\{`ap-slot-\$\{a\.num\}`\}/);
    expect(panel.match(/id=\{`ap-alias-/g)).toHaveLength(1);
    expect(panel.match(/id=\{`ap-slot-/g)).toHaveLength(1);
  });

  it("gives every form a way out that is a word, not a gesture to discover", () => {
    for (const v of ["rename", "move"] as const) expect(view(v)).toMatch(/>Cancel<\/button>/);
    expect(view("share")).toMatch(/>Done<\/button>/);
  });

  it("saves a name on Enter through a form, and sends a move only from its button", () => {
    expect(view("rename")).toMatch(/<form className="ap-pop-form" onSubmit=/);
    // #516: a keystroke in the picker is a proposal, never a move.
    expect(view("move")).not.toMatch(/<form/);
    expect(view("move")).toMatch(/onClick=\{\(\) => doSlot\(a\.num, picked, commit\)\}/);
  });
});

describe("where the surface sits", () => {
  it("is drawn at the top of the document, so the column that scrolls cannot clip it", () => {
    expect(popover).toMatch(/createPortal\(/);
    expect(popover).toMatch(/document\.body,\s*\);/);
    expect(decl(".anchored-popover", "position")).toBe("fixed");
  });

  it("answers Escape, holds Tab in a form and hands focus back through the shared hook", () => {
    expect(popover).toMatch(/useModalDismiss<HTMLDivElement>\(/);
  });

  it("sits on the sound menu's layer and wears its radius", () => {
    expect(decl(".anchored-popover", "z-index")).toBe(decl(".sound-menu", "z-index"));
    expect(decl(".anchored-popover", "border-radius")).toBe(decl(".sound-menu", "border-radius"));
  });

  it("arrives in under 160ms without growing, and only fades when motion is reduced", () => {
    const anim = decl(".anchored-popover", "animation")!;
    expect(Number(/(\d+)ms/.exec(anim)![1])).toBeLessThanOrEqual(160);
    const frames = /@keyframes pop-from-anchor\s*\{([\s\S]*?)\n\}/.exec(css)![1];
    expect(frames).not.toMatch(/scale/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.anchored-popover \{ animation: fadeIn/);
  });

  it("keeps the black shadow off the white page", () => {
    expect(decl(":root[data-theme=\"light\"] .anchored-popover", "box-shadow")).toMatch(/^0 1px 2px rgba\(15, 23, 42,/);
  });
});

describe("the states, in the deck's neutral rather than its accent", () => {
  it("draws items as rows, not pills, and answers the pointer and the keyboard with the control fill", () => {
    expect(decl(".ap-menu-item", "border")).toBe("0");
    expect(decl(".ap-menu-item", "border-radius")).not.toBe("999px");
    for (const sel of [".ap-menu-item:hover:not(:disabled)", ".ap-menu-item:focus-visible"]) {
      expect(decl(sel, "background"), sel).toBe("var(--ctl-fill)");
    }
    const states = RULES.filter(r => r.sels.some(s => /^\.ap-menu-item(?!\.danger)[:[]/.test(s)));
    expect(states.map(r => r.body).join(";")).not.toMatch(/--accent/);
  });

  it("gives Remove the error colour's wash when it is pointed at, and the fill once armed", () => {
    expect(decl(".ap-menu-item.danger:hover:not(:disabled)", "background"))
      .toBe("color-mix(in srgb, var(--err) 12%, transparent)");
    expect(decl(".ap-menu-item.danger.armed", "background")).toBe("var(--err)");
    // The pointed-at states cannot paint the wash back over an armed item.
    expect(decl(".ap-menu-item.danger.armed:hover:not(:disabled)", "background")).toBe("var(--err)");
  });

  it("keeps the ⋯ quieter than `switch`: a fill when answered, never an outline", () => {
    expect(decl(".ap-more", "border")).toBe("0");
    expect(decl(".ap-more:hover", "border-color")).toBeNull();
    expect(decl(".ap-more:hover", "background")).toBe("var(--ctl-fill)");
    expect(decl(".ap-more[aria-expanded=\"true\"]", "background")).toMatch(/var\(--text\)/);
    expect(RULES.filter(r => r.sels.some(s => s.startsWith(".ap-more"))).map(r => r.body).join(";"))
      .not.toMatch(/--accent/);
  });
});
