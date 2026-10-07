// The branch chip on a card: which cards show one, what it says and how a long
// branch is shortened, and the wiring the canvas cannot be rendered to prove —
// the chip lives on the sub row, a press on it is its own and opens the agent's
// details, and it moves nothing when it lights up.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { branchChip, branchCandidates, branchFloor, fitBranch, fitChip, graphemes, rowYields, textColumns } from "../git-chip";
import { openGitFor, setGitOpener } from "../git-open";
import type { GitFacts } from "../types";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const repo = (over: Partial<GitFacts> = {}): GitFacts => ({
  state: "repo", topLevel: "/w/shop-api", name: "shop-api", mainName: "shop-api", folderName: "shop-api",
  nameDiffers: false, linkedWorktree: false, branch: "feature/bargan/VCRM-9090", detached: false, sha: "65fecee",
  unborn: false, empty: false, stale: 0, ...over,
});

describe("which cards show a branch", () => {
  it("shows a root's branch, with the full name in the tooltip", () => {
    expect(branchChip({ kind: "root", git: repo(), cwd: "/w/shop-api" })).toEqual({
      kind: "branch", name: "feature/bargan/VCRM-9090", title: "feature/bargan/VCRM-9090",
      label: "Branch feature/bargan/VCRM-9090. Open its git view",
    });
  });

  it("names a detached HEAD by its short SHA", () => {
    const c = branchChip({ kind: "root", git: repo({ branch: null, detached: true, sha: "56aee3d" }) });
    expect(c).toMatchObject({ kind: "detached", name: "56aee3d", title: "detached HEAD at 56aee3d" });
  });

  it("shows nothing for a folder in no repository, or before the server has said", () => {
    expect(branchChip({ kind: "root" })).toBeNull();
    for (const state of ["not-a-repo", "no-git", "bare", "unsafe", "gone"] as const) {
      expect(branchChip({ kind: "root", git: { state, stale: 0 } }), state).toBeNull();
    }
  });

  it("shows a deleted folder's branch only as its session's log recorded it, and says so", () => {
    const c = branchChip({ kind: "root", git: { state: "gone", branch: "feature/merged", fromLog: true, stale: 0 } });
    expect(c?.name).toBe("feature/merged");
    expect(c?.title).toContain("as the session's log last recorded it: its folder no longer exists");
    // A press shows why in the Git section rather than opening a view, so the
    // name promises no view, and the chip is marked as a value from the log.
    expect(c?.label).toBe("Branch feature/merged, as its session's log last recorded it. Its folder no longer exists");
    expect(c?.label).not.toContain("Open its git view");
    expect(c?.gone).toBe(true);
    expect(branchChip({ kind: "root", git: repo() })?.gone).toBeUndefined();
  });

  it("draws a branch from the log apart from a live one", () => {
    expect(sourceOf("components/GitChip.tsx")).toContain('data-gone={chip.gone ? "" : undefined}');
    expect(sheetText()).toContain(".git-chip[data-gone] .git-chip-name { font-style: italic; }");
    const design = readFileSync(fileURLToPath(new URL("../../../DESIGN.md", import.meta.url)), "utf8");
    const row = design.split("\n").find(l => l.startsWith("| Branch from the log |")) ?? "";
    expect(row.split(" | ")).toHaveLength(5);
    expect(row).toContain("italic");
    expect(row).toContain("as the session's log last recorded it");
  });

  it("puts a subagent's folder in its tooltip, and says which worktree and repository", () => {
    const c = branchChip({ kind: "subagent", cwd: "/w/shop-api-docs", git: repo({ branch: "docs/rate-limits", linkedWorktree: true, name: "shop-api-docs" }) });
    expect(c?.title).toBe("/w/shop-api-docs\ndocs/rate-limits\nworktree shop-api-docs of shop-api");
    expect(branchChip({ kind: "root", git: repo({ nameDiffers: true, name: "web-app", folderName: "pkg" }) })?.title)
      .toBe("feature/bargan/VCRM-9090\nrepository web-app");
    expect(branchChip({ kind: "root", git: repo({ branch: "main", unborn: true }) })?.title).toBe("main\nno commits on this branch yet");
  });
});

describe("a long branch, shortened in the middle", () => {
  it("keeps the last segment, the part people scan for", () => {
    // A segment that is only a ticket is never cut inside it.
    expect(branchCandidates("feature/bargan/VCRM-9090")).toEqual([
      "feature/bargan/VCRM-9090", "feature/…/VCRM-9090", "…/VCRM-9090", "VCRM-9090",
    ]);
    expect(branchCandidates("main")).toEqual(["main"]);
    expect(branchCandidates("fix/retry-backoff")).toEqual(["fix/retry-backoff", "…/retry-backoff", "retry-backoff",
      "retry-b…koff", "retry-…off", "retry…ff"]);
  });

  it("takes the longest spelling that fits, and the last segment whole when none does", () => {
    const fitsIn = (n: number) => (t: string) => t.length <= n;
    const long = "feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything";
    expect(fitBranch("feature/bargan/VCRM-9090", fitsIn(30))).toBe("feature/bargan/VCRM-9090");
    expect(fitBranch("feature/bargan/VCRM-9090", fitsIn(20))).toBe("feature/…/VCRM-9090");
    expect(fitBranch("feature/bargan/VCRM-9090", fitsIn(10))).toBe("VCRM-9090");
    // The ticket leads, whole, then the start of what follows it, the cut,
    // and the end of the name.
    expect(fitBranch(long, fitsIn(24))).toBe("VCRM-9090-make-th…thing");
    expect(fitBranch(long, fitsIn(16))).toBe("VCRM-9090-ma…ng");
    expect(fitBranch(long, fitsIn(13))).toBe("VCRM-9090…");
    expect(fitBranch(long, fitsIn(10))).toBe("VCRM-9090…");
    expect(fitBranch(long, () => false)).toBe("VCRM-9090-make-the-invoice-builder-understand-everything");
    expect(fitBranch("feature/auth-login", () => false)).toBe("auth-login");
  });
});

describe("a ticket, by the rule the cards and the git view share", () => {
  it("is upper-case letters and digits, a hyphen and a number: VCRM-9090, AB2-12", () => {
    expect(branchFloor("feature/bargan/VCRM-9090-make-the-invoice-builder")).toBe("VCRM-9090…");
    expect(branchFloor("fix/AB2-12-x")).toBe("AB2-12…");
    // Not a word that happens to carry a number: those are cut like any name.
    for (const name of ["chore/deps-2-bump-everything-to-latest", "feature/v2-1-release-candidate-notes", "node-22-upgrade-the-runtime", "bargan/gh-1960-git-view-follow-ups"]) {
      const floor = branchFloor(name);
      expect(floor, name).toMatch(/…./);
      expect(graphemes(floor.replace("…", "")).length, name).toBeGreaterThanOrEqual(8);
    }
    expect(branchCandidates("chore/deps-2-bump-everything-to-latest")).not.toContain("deps-2…");
  });

  it("keeps the start of what follows the ticket, as the mockup cuts it", () => {
    const cuts = branchCandidates("feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything");
    expect(cuts).toContain("VCRM-9090-make-the-invoic…nd-everything");
    expect(cuts).toContain("VCRM-9090-ma…ng");
    expect(cuts[cuts.length - 1]).toBe("VCRM-9090…");
    // Every cut leads with the ticket whole.
    for (const c of cuts.slice(3)) expect(c.startsWith("VCRM-9090"), c).toBe(true);
  });
});

describe("a branch in any script", () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const odd = [
    "feature/fixx-🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛-crash-in-the-login-flowx",
    "feat/add-𠮷野家-menu-translation-for-tokyo-shops",
    "fix/🚀-launch-the-rocket-today",
    "feature/team-👩‍💻👩‍💻👩‍💻-pairing-🇯🇵🇯🇵-flags-and-more",
    "feature/données-über-ветка-日本語ブランチ",
    "VCRM-9090-ünïcödé-🐛🐛🐛🐛-and-日本語-too",
  ];

  it("is never cut inside a character, an emoji, a flag or a joined emoji", () => {
    for (const name of odd) {
      const whole = new Set(graphemes(name));
      for (const c of [...branchCandidates(name), branchFloor(name)]) {
        expect(LONE.test(c), `${name} → ${c}`).toBe(false);
        for (const g of graphemes(c)) if (g !== "…" && g !== "/") expect(whole.has(g), `${name} → ${c}: ${g}`).toBe(true);
      }
    }
  });

  it("counts a wide character as the two columns it draws, and an emoji as two", () => {
    expect(textColumns("main")).toBe(4);
    expect(textColumns("日本語")).toBe(6);
    expect(textColumns("🐛x")).toBe(3);
    expect(textColumns("👩‍💻")).toBe(2);
    expect(textColumns("🇯🇵")).toBe(2);
    expect(textColumns("é…")).toBe(2);
  });

  it("fits what it draws in the room, whatever the script", () => {
    for (const name of odd) {
      for (let room = 6; room < 50; room++) {
        const fit = fitChip({ kind: "branch", name }, room, false);
        if (fit.give || fit.bare) continue;
        expect(textColumns(fit.label), `${name} at ${room}: ${fit.label}`).toBeLessThanOrEqual(room);
      }
    }
    // Measured in pixels by the caller's own measure: the cut keeps to it.
    const px = (t: string) => textColumns(t) * 6.02;
    const fit = fitChip({ kind: "branch", name: "feature/données-über-ветка-日本語ブランチ" }, 100, false, px);
    expect(fit).toMatchObject({ give: false, bare: false });
    expect(px((fit as { label: string }).label)).toBeLessThanOrEqual(100);
  });

  it("is measured on the card in the chip's own font, not from one character's width", () => {
    const chip = sourceOf("components/GitChip.tsx");
    expect(chip).toMatch(/const measure = monoMeasure\(CHIP_PX\);/);
    expect(chip).toMatch(/fitChip\(chip, room, canGive, measure\)/);
    expect(chip).not.toMatch(/textContent\.length/);
    // The chip's type size as the sheet sets it.
    expect(chip).toContain("const CHIP_PX = 10;");
    expect(sheetText()).toMatch(/\.git-chip \{[^}]*font: 10px\/1 var\(--font-mono\);/);
  });
});

describe("the least a chip says before it gives up its name", () => {
  it("is the ticket whole, or eight characters of a name without one", () => {
    expect(branchFloor("feature/bargan/VCRM-9090")).toBe("VCRM-9090");
    expect(branchFloor("feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything")).toBe("VCRM-9090…");
    expect(branchFloor("feature/auth-login")).toBe("auth-…gin");
    expect(branchFloor("fix/retry-backoff")).toBe("retry-…off");
    expect(branchFloor("develop")).toBe("develop");
    expect(branchFloor("main")).toBe("main");
  });
});

describe("a tight sub row gives the chip room before the chip gives up its name", () => {
  it("lets the session word go first, then the model chip's +N; a subagent keeps its word", () => {
    expect(rowYields("root", 1)).toEqual(["kind", "more"]);
    expect(rowYields("root", 0)).toEqual(["kind"]);
    expect(rowYields("subagent", 2)).toEqual(["more"]);
    expect(rowYields("subagent", 0)).toEqual([]);
  });

  const branch = (name: string) => ({ kind: "branch" as const, name });
  it("takes the longest spelling that fits when the row has room for at least the floor", () => {
    expect(fitChip(branch("feature/bargan/VCRM-9090"), 30, true)).toEqual({ give: false, label: "feature/bargan/VCRM-9090", bare: false });
    expect(fitChip(branch("feature/bargan/VCRM-9090"), 9.5, true)).toEqual({ give: false, label: "VCRM-9090", bare: false });
    expect(fitChip(branch("feature/auth-login"), 11, false)).toEqual({ give: false, label: "auth-login", bare: false });
  });

  it("asks the row for room when even the floor does not fit, and is bare only once the row has nothing left to give", () => {
    // api-fix: `session → 1 Opus 5.5 +1` left three letters' room.
    expect(fitChip(branch("feature/auth-login"), 3, true)).toEqual({ give: true });
    expect(fitChip(branch("feature/auth-login"), 3, false)).toMatchObject({ give: false, bare: true });
    // Never a ticket cut inside: no room for VCRM-9090 is the glyph alone.
    expect(fitChip(branch("feature/bargan/VCRM-9090"), 8.5, true)).toEqual({ give: true });
    expect(fitChip(branch("feature/bargan/VCRM-9090"), 8.5, false)).toMatchObject({ give: false, bare: true });
  });

  it("keeps a detached HEAD's short SHA whole, asking for room first", () => {
    const detached = { kind: "detached" as const, name: "56aee3d" };
    expect(fitChip(detached, 5, true)).toEqual({ give: true });
    expect(fitChip(detached, 5, false)).toEqual({ give: false, label: "56aee3d", bare: false });
    expect(fitChip(detached, 9, true)).toEqual({ give: false, label: "56aee3d", bare: false });
  });

  it("gives nothing away when even everything the row could give would not make room for the floor", () => {
    // A 41-character ticket on a root card: the word "session" went and the
    // chip was bare anyway. Now the row takes back what it gave and the chip
    // stands bare beside the row as it was.
    const chip = sourceOf("components/GitChip.tsx");
    expect(chip).toMatch(/if \(fit\.bare && given > 0\) \{ onGiveBack\(\); return; \}/);
    const node = sourceOf("components/AgentNode.tsx");
    expect(node).toContain("const [given, setGiven] = useState({ row: \"\", count: 0, back: false });");
    expect(node).toContain("const gaveBack = given.row === rowKey && given.back;");
    expect(node).toMatch(/canGive=\{!gaveBack && giving\.length < yields\.length\}/);
    expect(node).toMatch(/onGiveBack=\{\(\) => setGiven\(\{ row: rowKey, count: 0, back: true \}\)\}/);
  });

  it("draws the row without what it gave, and starts again whenever the row says something else", () => {
    const node = sourceOf("components/AgentNode.tsx");
    const sub = node.slice(node.indexOf('<div className="sub" title={subRowTitle(data)}>'), node.indexOf("</div>", node.indexOf('<div className="sub" title={subRowTitle(data)}>')));
    expect(sub).toContain('{kindShown && <span className="sub-kind">{data.kind === "root" ? "session" : "subagent"}</span>}');
    expect(sub).toContain("{shortModel(data.model)}{moreShown ? modelMore : \"\"}");
    expect(sub).toMatch(/<GitChip agentId=\{data\.id\} chip=\{chip\} row=\{rowKey\} given=\{giving\.length\}/);
    // The count of what was given is kept against the row it was worked out
    // for: a row that changes starts from nothing given, in the same render.
    expect(node).toContain("const giving = given.row === rowKey ? yields.slice(0, given.count) : NO_YIELDS;");
    expect(node).toContain('const rowKey = `${data.kind}|${data.childCount}|${modelSaid}|${chip?.name ?? ""}`;');
    const chip = sourceOf("components/GitChip.tsx");
    expect(chip).toMatch(/if \(fit\.give\) \{ onGive\(\); return; \}/);
    expect(chip).toContain("[chip.name, chip.kind, row, given, canGive]");
  });

  it("keeps the row's first word flush with the card's edge once the session word has gone", () => {
    expect(sheetText()).toContain(".agent-node .sub:has(.git-chip) > :first-child:not(.git-chip) { margin-left: 0; }");
  });
});

describe("pressing the chip", () => {
  it("reaches whatever the page installed, and nothing once it is removed", () => {
    const seen: string[] = [];
    setGitOpener((id, how) => seen.push(`${id} ${how}`));
    openGitFor("s1::ag1");
    openGitFor("s1::ag2", "key");
    setGitOpener(null);
    openGitFor("s1");
    expect(seen).toEqual(["s1::ag1 pointer", "s1::ag2 key"]);
  });

  it("is the chip's own press: it stops at the chip, opens the git view, and the page installs that", () => {
    const chip = sourceOf("components/GitChip.tsx");
    // Pressed with Enter or Space, it opens the view at once; clicked, it slides in.
    expect(chip).toMatch(/onClick=\{e => \{ e\.stopPropagation\(\); openGitFor\(agentId, pressHow\(e\)\); \}\}/);
    expect(chip).toContain('className="git-chip"');
    const opener = sourceOf("use-git-opener.ts");
    expect(opener).toMatch(/selectAgent\(id, false\);\s*openGitView\(id, how\);/);
    expect(sourceOf("App.tsx")).toContain("useGitOpener({ selectAgent, openGitView: openGitViewFromChip })");
    expect(sourceOf("App.tsx")).toMatch(/\(agentId: string, how: GitViewHow\) => openGitView\(how, \{ agentId \}\)/);
  });

  it("sits last on the card's sub row, and a subagent's replaces its folder name there", () => {
    const node = sourceOf("components/AgentNode.tsx");
    const sub = node.slice(node.indexOf('<div className="sub" title={subRowTitle(data)}>'), node.indexOf("</div>", node.indexOf('<div className="sub" title={subRowTitle(data)}>')));
    expect(sub).toContain("<GitChip ");
    expect(sub.indexOf("<GitChip ")).toBeGreaterThan(sub.indexOf("model-chip"));
    expect(sub).toContain('data.kind === "subagent" && !chip ? ` · ${data.cwdBasename}` : ""');
  });
});

describe("the chip's look", () => {
  const css = sheetText();
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("is edgeless at rest and lights its edge on hover and focus, colour only", () => {
    expect(rule(".git-chip")).toContain("border: 1px solid transparent");
    expect(rule(".git-chip")).toMatch(/transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, transform 120ms ease;/);
    expect(css).toMatch(/\.git-chip:hover,\s*\.git-chip:focus-visible \{ border-color: var\(--ctl-edge\); background: var\(--ctl-fill\); color: var\(--text\); \}/);
  });

  it("is fitted to the card's widest inner width as the sheet states it", async () => {
    const { CARD_INNER_MAX } = await import("../components/GitChip");
    const card = /\n\.agent-node \{([^}]*)\}/.exec(css)![1];
    const max = Number(/max-width: (\d+)px/.exec(card)![1]);
    const [, , right, , left] = /padding: (\d+)px (\d+)px (\d+)px (\d+)px/.exec(card)!.map(Number);
    expect(card).toContain("border: 1px solid");
    expect(CARD_INNER_MAX).toBe(max - left - right - 2);
  });

  it("keeps the gaps GitChip counts on: 4px from glyph to name, 6px from its neighbour", () => {
    expect(rule(".git-chip")).toContain("gap: 4px;");
    expect(css).toContain(".agent-node .sub:has(.git-chip) > :nth-last-child(2):not(.git-chip) { margin-right: 6px; }");
    const chip = sourceOf("components/GitChip.tsx");
    expect(chip).toContain("const NAME_GAP = 4;");
    expect(chip).toContain("const CHIP_GAP = 6;");
    expect(css).toContain(".git-chip[data-bare] .git-chip-name { display: none; }");
  });

  it("keeps the keyboard's ring inside the sub row, which hides its overflow", () => {
    expect(rule(".agent-node .sub")).toContain("overflow: hidden");
    expect(css).toContain(".git-chip:focus-visible { outline-offset: -2px; }");
    expect(css).not.toContain(".git-chip:focus-visible { outline-offset: 1px; }");
  });

  it("makes the sub row a flex row only when a chip is on it", () => {
    expect(css).toContain(".agent-node .sub:has(.git-chip) { display: flex; align-items: center; }");
    // What is on the row before the chip keeps its width; only the chip shrinks.
    expect(css).toMatch(/\.agent-node \.sub:has\(\.git-chip\) > \.sub-kind,\s*\.agent-node \.sub:has\(\.git-chip\) > \.spawn-badge,\s*\.agent-node \.sub:has\(\.git-chip\) > \.model-chip \{ flex: none; \}/);
  });
});
