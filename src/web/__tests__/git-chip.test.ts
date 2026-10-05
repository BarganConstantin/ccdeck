// The branch chip on a card: which cards show one, what it says and how a long
// branch is shortened, and the wiring the canvas cannot be rendered to prove —
// the chip lives on the sub row, a press on it is its own and opens the agent's
// details, and it moves nothing when it lights up.
import { describe, expect, it } from "vitest";
import { branchChip, branchCandidates, fitBranch } from "../git-chip";
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
      label: "Branch feature/bargan/VCRM-9090. Open this agent's details",
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
    expect(branchCandidates("feature/bargan/VCRM-9090")).toEqual([
      "feature/bargan/VCRM-9090", "feature/…/VCRM-9090", "…/VCRM-9090", "VCRM-9090", "VCRM-…90",
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
    // The ticket leads, whole, then the cut, then the end of the name.
    expect(fitBranch(long, fitsIn(24))).toBe("VCRM-9090…and-everything");
    expect(fitBranch(long, fitsIn(13))).toBe("VCRM-9090…ing");
    expect(fitBranch(long, fitsIn(10))).toBe("VCRM-9090…");
    expect(fitBranch(long, () => false)).toBe("VCRM-9090-make-the-invoice-builder-understand-everything");
    expect(fitBranch("feature/auth-login", () => false)).toBe("auth-login");
  });
});

describe("pressing the chip", () => {
  it("reaches whatever the page installed, and nothing once it is removed", () => {
    const seen: string[] = [];
    setGitOpener(id => seen.push(id));
    openGitFor("s1::ag1");
    setGitOpener(null);
    openGitFor("s1");
    expect(seen).toEqual(["s1::ag1"]);
  });

  it("is the chip's own press: it stops at the chip, opens details, and the page installs that", () => {
    const chip = sourceOf("components/GitChip.tsx");
    expect(chip).toMatch(/onClick=\{e => \{ e\.stopPropagation\(\); openGitFor\(agentId\); \}\}/);
    expect(chip).toContain('className="git-chip"');
    const opener = sourceOf("use-git-opener.ts");
    expect(opener).toMatch(/selectAgent\(id, false\)/);
    expect(sourceOf("App.tsx")).toContain("useGitOpener({ selectAgent, focusAgent })");
  });

  it("sits last on the card's sub row, and a subagent's replaces its folder name there", () => {
    const node = sourceOf("components/AgentNode.tsx");
    const sub = node.slice(node.indexOf('<div className="sub">'), node.indexOf("</div>", node.indexOf('<div className="sub">')));
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

  it("makes the sub row a flex row only when a chip is on it", () => {
    expect(css).toContain(".agent-node .sub:has(.git-chip) { display: flex; align-items: center; }");
  });
});
