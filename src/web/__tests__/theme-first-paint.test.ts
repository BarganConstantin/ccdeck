// #331: a light-theme user saw the dark deck on every single load.
//
// The attribute the whole stylesheet keys on was written from a useEffect, and
// effects run after the browser has painted. Worse, the sheet's first rule is
// `:root, :root[data-theme="dark"]`, so the attribute-less frame is not an
// unstyled one the eye forgives as loading — it is the finished dark deck,
// `color-scheme: dark` included, which drags the browser's own scrollbars and
// form controls along with it. Those are chrome, not CSS: they repaint on their
// own schedule and the correction is visible.
//
// The preference was already known synchronously — App reads it in a useState
// initialiser — so only the DOM write was late, and no bundle can make it early
// enough: the entry is a module script, module scripts are deferred, and the
// browser may paint while that chunk is still in flight. The fix is a classic
// inline script in <head>, which is parser-blocking and therefore runs before a
// frame exists.
//
// That script cannot import theme.ts — an import would make it a module and
// defer it again, which is the bug — so the rule is written twice. Rather than
// trust the two copies to stay in step, this suite EXECUTES the inlined text
// against a fake window and compares its answer to resolveTheme() over the same
// inputs, throwing store included. Plain node, no DOM: `new Function` with
// `window` and `document` as parameters shadows the globals the script reaches
// for, so the browser is never involved.
//
// #885 added a second input to that one rule: what the MACHINE asks for, when
// nothing is stored. Everything above still holds — the copies must agree, and
// the answer must still arrive before the first frame — so the media query is
// written twice as well, and `boot()` below now models it alongside the store.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTheme, storedTheme, systemPrefersLight, THEME_KEY, type Theme } from "../theme";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../index.html");
const app = read("../App.tsx");
const css = read("../styles.css");

/** The bootstrap's body, and where it sits. A `<script>` with no attributes at
 *  all is the whole point: Vite rewrites only the tags carrying a `src` or a
 *  `type="module"`, and the browser defers only those same two, so "no
 *  attributes" is simultaneously what survives the build and what beats the
 *  paint. */
function bootstrapOf(source: string): { body: string; at: number } {
  const m = /<script>([\s\S]*?)<\/script>/.exec(source);
  if (!m) throw new Error("no attribute-less inline <script> in the document");
  return { body: m[1], at: m.index };
}

type Refusal = "getter" | "getItem" | "missing";

/** What the machine says, as `boot` has to model it. "light" and "dark" are an
 *  OS with a preference; "none" is a browser whose `matchMedia` matches
 *  neither, "absent" is one that has no `matchMedia` at all, and "throws" is
 *  one whose call raises — the deck has to come up in all five. */
type System = "light" | "dark" | "none" | "absent" | "throws";

/**
 * Runs the shipped bootstrap over one store and one machine, and reports the
 * data-theme it wrote, the key it asked for and the media query it asked with.
 *
 * `stored` is the value the tab has; a Refusal instead models a browser that
 * will not hand the store over — the getter itself raising SecurityError under
 * "Block All Cookies" is the real-world case, and the one a try around getItem
 * alone would miss.
 */
function boot(
  stored: string | null | Refusal,
  system: System = "dark",
): { applied?: string; asked?: string; queried?: string } {
  const out: { applied?: string; asked?: string; queried?: string } = {};
  const refuse = () => { throw new Error("SecurityError: The operation is insecure."); };
  const store = { getItem: (key: string) => { out.asked = key; return stored as string | null; } };

  const window = Object.defineProperty({}, "localStorage",
    stored === "getter" ? { get: refuse }
    : stored === "getItem" ? { value: { getItem: refuse } }
    : stored === "missing" ? { value: undefined }
    : { value: store }) as Record<string, unknown>;

  if (system !== "absent") {
    window.matchMedia = (query: string) => {
      out.queried = query;
      if (system === "throws") throw new TypeError("matchMedia is not a function");
      // The real object answers the query it was handed. Modelled the same way
      // so a bootstrap that asked for `(prefers-color-scheme: dark)` and then
      // inverted the answer would be visible here rather than passing.
      return { matches: system === "none" ? false : query.includes(system) };
    };
  }

  const document = { documentElement: {
    setAttribute(name: string, value: string) { if (name === "data-theme") out.applied = value; },
  } };

  new Function("window", "document", bootstrapOf(html).body)(window, document);
  return out;
}

describe("resolveTheme", () => {
  it("treats only the exact string light as light", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("falls back to dark for a value nothing wrote or this version cannot read", () => {
    // null is both "never chosen" and "store refused" — readStored collapses
    // the two — and an unknown string is what a future version could leave
    // behind. All three land on the default the sheet already paints, on a
    // machine that has not asked for anything else.
    for (const value of [null, undefined, "", "LIGHT", "system", "purple"]) {
      expect(resolveTheme(value)).toBe("dark");
    }
  });

  it("hands every one of those to the machine instead, when the machine asked for light (#885)", () => {
    // THE DEFECT, in one line. Measured in Firefox 155 against the built
    // dist/web/index.html with an empty store and the OS set to light:
    // (prefers-color-scheme: light) matched, (…: dark) did not, and the
    // document still came up data-theme="dark". Every value that means "this
    // deck has never been told" has to reach the same second question.
    for (const value of [null, undefined, "", "LIGHT", "system", "purple"]) {
      expect(resolveTheme(value, true), `${String(value)} ignored the machine`).toBe("light");
      expect(resolveTheme(value, false)).toBe("dark");
    }
  });

  it("lets a stored choice outrank the machine, in both directions", () => {
    // The machine decides what "never chosen" means and nothing else. A reader
    // who pressed T on a light desktop asked for dark ON PURPOSE, and an OS
    // preference that could overturn that would make the toggle unusable — it
    // would come back every reload.
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("still answers without a browser at all, which is where it is first called", () => {
    // systemPrefersLight guards `matchMedia` with a typeof INSIDE its try, and
    // this file runs in bare node with no window — so this is the real absent
    // case rather than a mock of one. App calls storedTheme from a useState
    // initialiser and src/web has no error boundary: a throw here is a blank
    // deck, not a lost preference.
    expect(() => systemPrefersLight()).not.toThrow();
    expect(systemPrefersLight()).toBe(false);
  });

  it("survives a matchMedia that throws rather than losing the mount", () => {
    const glob = globalThis as unknown as Record<string, unknown>;
    glob.matchMedia = () => { throw new TypeError("Illegal invocation"); };
    try {
      expect(() => systemPrefersLight()).not.toThrow();
      expect(systemPrefersLight()).toBe(false);
    } finally { delete glob.matchMedia; }
  });

  it("asks whether the machine wants LIGHT, not whether it wants dark", () => {
    // Not the same question, and the difference is the whole default. A browser
    // with no preference at all matches `light` and matches neither `dark` nor
    // `no-preference`, so `not (prefers-color-scheme: dark)` and
    // `(prefers-color-scheme: light)` agree on every machine that HAS a
    // preference and disagree on the ones that do not.
    const glob = globalThis as unknown as Record<string, unknown>;
    let asked = "";
    glob.matchMedia = (q: string) => { asked = q; return { matches: true }; };
    try {
      expect(systemPrefersLight()).toBe(true);
      expect(asked).toBe("(prefers-color-scheme: light)");
    } finally { delete glob.matchMedia; }
  });

  it("gives the deck a theme even when the browser refuses the store", () => {
    // storedTheme goes through readStored, whose guard wraps the localStorage
    // property read itself. Nothing here may throw: App calls this from a
    // useState initialiser and src/web has no error boundary, so a throw
    // escaping it rejects root.render() and leaves a blank deck.
    const glob = globalThis as unknown as Record<string, unknown>;
    glob.window = Object.defineProperty({}, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: The operation is insecure."); },
    });
    try {
      expect(() => storedTheme()).not.toThrow();
      expect(storedTheme()).toBe("dark");
    } finally { delete glob.window; }
  });
});

describe("the inline bootstrap in index.html", () => {
  it("runs before the module script that renders the app", () => {
    // The ordering IS the fix. main.tsx cannot host this: `<script
    // type="module">` is deferred, so it executes after the parse and the
    // browser is free to paint the stylesheet's default first.
    const module = html.indexOf('<script type="module"');
    expect(module).toBeGreaterThan(-1);
    expect(bootstrapOf(html).at).toBeLessThan(module);
  });

  it("sits in <head>, where the parser reaches it before any element can paint", () => {
    expect(bootstrapOf(html).at).toBeLessThan(html.indexOf("</head>"));
  });

  it("applies the stored preference on the very first parse", () => {
    expect(boot("light")).toEqual({ applied: "light", asked: THEME_KEY });
    expect(boot("dark").applied).toBe("dark");
  });

  it("asks for the key every other version of the deck wrote", () => {
    // A renamed key throws nothing and logs nothing: it reads as an empty store
    // and silently discards the choice of everyone upgrading into this build.
    expect(boot("light").asked).toBe("agent-dag.theme");
    expect(THEME_KEY).toBe("agent-dag.theme");
  });

  it("still writes a theme when the store throws, rather than stopping the parse", () => {
    // An exception escaping a parser-blocking script in <head> is not a lost
    // preference, it is a document that never gets its attribute — the dark
    // deck for a light user, permanently, on exactly the profiles that were
    // already the fragile ones.
    for (const refusal of ["getter", "getItem", "missing"] as const) {
      expect(() => boot(refusal)).not.toThrow();
      expect(boot(refusal).applied).toBe("dark");
    }
  });

  it("reaches the same answer as resolveTheme for every input, so the two copies cannot drift", () => {
    // The bootstrap is dependency-free by necessity, which makes it a second
    // implementation of one rule. This is the seam that keeps it honest — and
    // since #885 the rule has two inputs, so the seam runs over both.
    for (const system of ["light", "dark", "none", "absent", "throws"] as const) {
      const light = system === "light";
      for (const stored of [null, "light", "dark", "", "LIGHT", "system", "purple"]) {
        const expected: Theme = resolveTheme(stored, light);
        expect(boot(stored, system).applied, `${String(stored)} on a ${system} machine`).toBe(expected);
      }
      expect(boot("getter", system).applied).toBe(resolveTheme(null, light));
    }
  });

  it("boots into the theme the machine asked for when nothing is stored (#885)", () => {
    // WHAT WAS OBSERVED: Firefox 155, headless, ui.systemUsesDarkTheme = 0,
    // serving the built dist/web/index.html over 127.0.0.1 with an empty
    // store — (prefers-color-scheme: light) true, (…: dark) false,
    // localStorage["agent-dag.theme"] null, and the document came up
    // data-theme="dark". With the same prefs and ui.systemUsesDarkTheme = 1 it
    // also came up dark, which is right by accident rather than by decision.
    expect(boot(null, "light").applied, "a light desktop still gets the dark deck").toBe("light");
    expect(boot(null, "dark").applied).toBe("dark");
  });

  it("asks the machine for light rather than for the absence of dark", () => {
    // The one query that differs on a browser reporting no preference at all,
    // which is the case that decides the deck's default for everyone who has
    // never touched an OS theme setting.
    expect(boot(null, "light").queried).toBe("(prefers-color-scheme: light)");
  });

  it("does not ask the machine at all once a choice is stored", () => {
    // The T toggle has to survive a reload on a machine that disagrees with it,
    // and the cheapest proof is that the query is never even run.
    const onLight = boot("dark", "light");
    expect(onLight.applied).toBe("dark");
    expect(onLight.queried, "the machine was consulted over a stored choice").toBeUndefined();
    const onDark = boot("light", "dark");
    expect(onDark.applied).toBe("light");
    expect(onDark.queried).toBeUndefined();
  });

  it("still writes a theme where matchMedia is missing or refuses", () => {
    // Two separate `try`s in the shipped text, because a store that throws and
    // a matchMedia that throws are different failures — one catch around both
    // would let a blocked store skip the machine entirely, which is precisely
    // the profile that has no stored preference to fall back on.
    for (const system of ["absent", "throws"] as const) {
      expect(() => boot(null, system)).not.toThrow();
      expect(boot(null, system).applied).toBe("dark");
      expect(boot("getter", system).applied).toBe("dark");
    }
  });

  it("adds no flash in the other direction for the default theme", () => {
    // A dark user is the untouched case only because the sheet's no-attribute
    // block and its dark block are the same block. If they are ever split, the
    // bootstrap writing "dark" starts changing the first frame too, and this is
    // the line that says so.
    expect(css).toMatch(/^\uFEFF?:root,\s*:root\[data-theme="dark"\]\s*\{/);
    expect(boot(null).applied).toBe("dark");
  });
});

// These two read App.tsx as text because a React component cannot be rendered
// in bare node. #378 loosened them from exact source lines to patterns: what
// they own is that App's first theme comes from storedTheme and that the toggle
// still writes both places, and none of that changes when somebody wraps the
// initialiser in an arrow or hoists documentElement into a local. A test that
// fails on a reformat teaches people to delete tests.
describe("App", () => {
  it("starts from the same resolution the bootstrap used, not a second rule", () => {
    // `useState<Theme>(storedTheme)` and `useState<Theme>(() => storedTheme())`
    // are the same lazy initialiser written two ways. What may not change is
    // WHICH function answers, because a second rule here is the drift the whole
    // file exists to prevent.
    expect(app, "App no longer takes its first theme from storedTheme")
      .toMatch(/useState<Theme>\(\s*(?:\(\)\s*=>\s*)?storedTheme\s*(?:\(\s*\))?\s*\)/);
    expect(app).not.toContain('readStored("agent-dag.theme")');
  });

  it("keeps the effect that persists the toggle", () => {
    // Redundant on first mount — the bootstrap already wrote that attribute
    // from that value — and deliberately not guarded: see App.tsx. Every later
    // run is the T toggle, which is the only reason it is still here.
    // Not pinned to `document.documentElement` spelled out: hoisting the root
    // into a local changes nothing about the write, and the write is the fact.
    expect(app, "the toggle no longer writes data-theme")
      .toMatch(/\.dataset\.theme\s*=\s*theme/);
    expect(app, "the toggle no longer persists the choice")
      .toMatch(/localStorage\.setItem\(\s*THEME_KEY\s*,\s*theme\s*\)/);
  });
});

describe("the built output", () => {
  // Hoisted out of the test body so the missing-artifact case can be a *visible*
  // skip. It used to be `if (!existsSync(dist)) return;` inside the test, which
  // reports green and silent — indistinguishable from having actually checked
  // the artifact, on every machine that had not run a build. CI builds before
  // it runs the suite (.github/workflows/publish.yml), so this never skips
  // there; locally it now says so in the reporter instead of pretending.
  const dist = fileURLToPath(new URL("../../../dist/web/index.html", import.meta.url));

  it.skipIf(!existsSync(dist))("carries the bootstrap ahead of the bundle", () => {
    // Vite copies an attribute-less inline script through verbatim and injects
    // its own tags around it, but "verbatim" is a claim about a tool, so it is
    // checked against the real artifact when one is on disk. `npm run build`
    // runs from prepublishOnly, so the publish path always has one.
    const built = readFileSync(dist, "utf8");
    expect(bootstrapOf(built).body).toContain(THEME_KEY);
    // The machine half has to survive the copy too: a minifier that dropped the
    // media query would leave every first-time light user on the dark deck and
    // nothing else would change, which is exactly how #885 went unnoticed.
    expect(bootstrapOf(built).body).toContain("(prefers-color-scheme: light)");
    expect(bootstrapOf(built).at).toBeLessThan(built.indexOf('<script type="module"'));
    expect(bootstrapOf(built).at).toBeLessThan(built.indexOf("</head>"));
  });
});
