// #2179: forge-panel.ts holds what the GitHub and GitLab panels know besides
// the drawing.
//
// What these pin: a read's path and how its failure arrives (the integrations'
// one envelope, or the deck's own answer when there is none); when a kept
// answer is drawn as it is, asked again, or marked stale; that every CI and
// review state has a mark and a word; GitLab's "999+"; the Branches page's
// active/stale split and the review list's waiting/approved split; the search
// over loaded rows and what counts as a pasted reference; and that a
// remembered view survives anything unreadable in the store, field by field.
import { describe, expect, it } from "vitest";
import {
  changeBadge, ciMark, DEFAULT_VIEW, divergeCount, durationWords, fetchForge, forgeErrorWords, forgeReadPath, FRESH_MS,
  isStale, loadForgeView, looksLikeRef, matchesQuery, normaliseView, readDue, splitBranches, splitReviews,
  tabAllowsAllProjects, type ForgePrefs,
} from "../forge-panel";
import type { CiState, ForgeBranch, ForgeChange } from "../forge-types";

const api = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failure(p: Promise<unknown>) {
  try { await p; } catch (err) { return (err as { info: unknown }).info; }
  throw new Error("expected a failure");
}

describe("reads", () => {
  it("leaves empty parameters out of the path", () => {
    expect(forgeReadPath("changes", { repo: "group/project", filter: "all", cursor: null, sort: "" }))
      .toBe("changes?repo=group%2Fproject&filter=all");
    expect(forgeReadPath("issues")).toBe("issues");
  });

  it("hands back the data, or the envelope's error as it came", async () => {
    expect(await fetchForge(api(200, { ok: true, data: [1, 2] }), "x")).toEqual([1, 2]);
    expect(await failure(fetchForge(api(429, { ok: false, error: { kind: "rate-limit", message: "slow", retryAfter: 30 } }), "x")))
      .toEqual({ kind: "rate-limit", message: "slow", retryAfter: 30 });
  });

  it("reports an answer without the envelope as the deck's", async () => {
    expect(await failure(fetchForge(api(503, "<html>restarting</html>"), "x")))
      .toEqual({ kind: "upstream", message: "the deck answered 503", status: 503 });
    expect(await failure(fetchForge(async () => { throw new TypeError("Failed to fetch"); }, "x")))
      .toEqual({ kind: "unreachable", message: "the deck did not answer" });
  });

  it("asks again only when the answer is old or the user asks", () => {
    const now = 1_000_000;
    expect(readDue({ data: null, loadedAt: null, error: null }, now)).toBe(true);
    expect(readDue({ data: 1, loadedAt: now - FRESH_MS + 1, error: null }, now)).toBe(false);
    expect(readDue({ data: 1, loadedAt: now - FRESH_MS, error: null }, now)).toBe(true);
    expect(readDue({ data: 1, loadedAt: now, error: null }, now, true)).toBe(true);
  });

  it("is stale when it is drawn from an answer whose refresh failed", () => {
    expect(isStale({ data: [1], loadedAt: 1, error: { kind: "unreachable", message: "x" } })).toBe(true);
    expect(isStale({ data: null, loadedAt: null, error: { kind: "unreachable", message: "x" } })).toBe(false);
    expect(isStale({ data: [1], loadedAt: 1, error: null })).toBe(false);
  });
});

describe("words", () => {
  it("gives every CI state a mark and a word", () => {
    const states: CiState[] = ["success", "failed", "running", "pending", "canceled", "skipped", "manual", "none"];
    for (const s of states) {
      const m = ciMark(s);
      expect(m.mark, s).toBeTruthy();
      expect(m.word, s).toBeTruthy();
    }
    expect(ciMark(null)).toEqual(ciMark("none"));
    expect(ciMark("failed")).toMatchObject({ word: "failed", tone: "bad" });
  });

  it("badges a change by what matters most", () => {
    expect(changeBadge({ state: "open", draft: true, approved: true }).word).toBe("Draft");
    expect(changeBadge({ state: "open", draft: false, approved: true }).word).toBe("Approved");
    expect(changeBadge({ state: "open", draft: false, approved: false }).word).toBe("Open");
    expect(changeBadge({ state: "merged", draft: false, approved: false }).word).toBe("Merged");
  });

  it("writes counts and durations the way the forge's pages do", () => {
    expect(divergeCount(1000)).toBe("999+");
    expect(divergeCount(29)).toBe("29");
    expect(divergeCount(null)).toBe("–");
    expect(durationWords(45)).toBe("45s");
    expect(durationWords(192)).toBe("3m 12s");
    expect(durationWords(3840)).toBe("1h 04m");
    expect(durationWords(null)).toBeNull();
  });

  it("names each failure in the forge's own name, with its recovery", () => {
    expect(forgeErrorWords("gitlab", { kind: "expired", message: "x" })).toMatchObject({ title: "The GitLab token has expired", action: "connection" });
    expect(forgeErrorWords("github", { kind: "unreachable", message: "x" })).toMatchObject({ title: "GitHub did not answer", action: "retry" });
    expect(forgeErrorWords("gitlab", { kind: "rate-limit", message: "x", retryAfter: 20 }).detail).toBe("Try again in 20s.");
  });
});

const branch = (name: string, stale: boolean, isDefault = false) => ({ name, stale, isDefault }) as ForgeBranch;
const change = (key: string, approvedByMe: boolean) => ({ key, approvedByMe }) as ForgeChange;

describe("groups and search", () => {
  it("splits branches as the Branches page does, the default branch never stale", () => {
    const { active, stale } = splitBranches([branch("a", false), branch("develop", true, true), branch("old", true)]);
    expect(active.map(b => b.name)).toEqual(["a", "develop"]);
    expect(stale.map(b => b.name)).toEqual(["old"]);
  });

  it("splits review requests into waiting on me and approved by me", () => {
    const { waiting, approved } = splitReviews([change("g/p!1", false), change("g/p!2", true)]);
    expect(waiting.map(c => c.key)).toEqual(["g/p!1"]);
    expect(approved.map(c => c.key)).toEqual(["g/p!2"]);
  });

  it("searches loaded rows by key, number or words of the title", () => {
    const row = { key: "group/project!5093", number: 5093, title: "Agent tablet two-column cards" };
    expect(matchesQuery(row, "")).toBe(true);
    expect(matchesQuery(row, "!5093")).toBe(true);
    expect(matchesQuery(row, "tablet cards")).toBe(true);
    expect(matchesQuery(row, "invoice")).toBe(false);
    expect(matchesQuery({ name: "feature/x-9295" }, "9295")).toBe(true);
  });

  it("asks the forge only for a URL or a full key", () => {
    expect(looksLikeRef("https://gitlab.example.com/group/project/-/merge_requests/5093")).toBe(true);
    expect(looksLikeRef("https://github.com/owner/repo/pull/12")).toBe(true);
    expect(looksLikeRef("group/sub/project!45")).toBe(true);
    expect(looksLikeRef("owner/repo#12")).toBe(true);
    expect(looksLikeRef("5093")).toBe(false);
    expect(looksLikeRef("tablet")).toBe(false);
  });

  it("lets only cross-project tabs read without a project", () => {
    expect(tabAllowsAllProjects("gitlab", "branches")).toBe(false);
    expect(tabAllowsAllProjects("gitlab", "changes")).toBe(true);
    expect(tabAllowsAllProjects("gitlab", "issues")).toBe(true);
    expect(tabAllowsAllProjects("github", "issues")).toBe(false);
  });
});

describe("the remembered view", () => {
  const prefs = (stored: unknown): ForgePrefs => ({
    read: <T,>(_key: string, check: (v: unknown) => v is T) => (check(stored) ? stored : undefined),
    write: () => {},
  });

  it("is the default when nothing, or nothing readable, is stored", () => {
    expect(loadForgeView(prefs(undefined))).toEqual(DEFAULT_VIEW);
    expect(loadForgeView(prefs("garbage"))).toEqual(DEFAULT_VIEW);
  });

  it("keeps each readable field and drops each unreadable one", () => {
    expect(normaliseView({ repo: "group/project", tab: "changes", filter: "everyone", state: "merged", open: ["stale", 3] }))
      .toEqual({ ...DEFAULT_VIEW, repo: "group/project", tab: "changes", state: "merged", open: ["stale"] });
  });
});
