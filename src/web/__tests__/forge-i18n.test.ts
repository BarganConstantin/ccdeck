// The GitHub / GitLab panel speaks the language on show: the helpers that build
// its sentences answer in German, Japanese and both Chinese forms, and every
// "forge." key the panel's sources ask for exists in English.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { en } from "../i18n/en";
import { ciMark, durationWords, forgeErrorWords, markWord } from "../forge-panel";
import { allReposLabel, divergeWords, emptyChangesWords, moreLabel, noMatchWords, pipelineSourceWords } from "../forge-lists";
import { approvalWords, changeSections, commitsWords, namesWords } from "../forge-detail";
import { forgeNouns } from "../forge-types";

afterEach(() => { setLanguage("en"); resetLanguageForTest(); });

describe("forge sentences in another language", () => {
  it("names the forges' own things per language", () => {
    setLanguage("de");
    expect(forgeNouns("gitlab").changes).toBe("Merge Requests");
    expect(forgeNouns("github").runs).toBe("Workflow-Läufe");
    setLanguage("ja");
    expect(forgeNouns("github").change).toBe("プルリクエスト");
    setLanguage("zh-CN");
    expect(forgeNouns("gitlab").pipeline).toBe("流水线");
    setLanguage("zh-TW");
    expect(forgeNouns("gitlab").repo).toBe("專案");
  });

  it("translates marks, durations and counts", () => {
    setLanguage("de");
    expect(markWord(ciMark("failed"))).toBe("fehlgeschlagen");
    expect(durationWords(192)).toBe("3 Min. 12 s");
    expect(commitsWords(1)).toBe("1 Commit");
    expect(commitsWords(1250)).toBe("1.250 Commits");
    expect(approvalWords({ approvedBy: [], approvalsLeft: 1 })?.text).toBe("Benötigt noch 1 weitere Genehmigung");
    expect(namesWords(["A", "B", "C"])).toBe("A, B und C");
    setLanguage("ja");
    expect(durationWords(3840)).toBe("1時間04分");
    expect(moreLabel(20, 56)).toBe("さらに読み込む · 20/56");
  });

  it("builds empty and failure sentences around the right nouns", () => {
    setLanguage("de");
    expect(emptyChangesWords("gitlab", { state: "open", filter: "all", acrossRepos: false })).toBe("Keine offenen Merge Requests in diesem Projekt.");
    expect(noMatchWords("Branches", " x ")).toBe("Keine Branches zu „x“ gefunden.");
    expect(allReposLabel("github")).toBe("Alle Repositories");
    expect(divergeWords(1, 0, null)).toBe("Gegenüber dem Standard-Branch: 1 Commit zurück, 0 voraus");
    expect(forgeErrorWords("github", { kind: "rate-limit", message: "x", retryAfter: 20 }).detail).toBe("Versuche es in 20 s erneut.");
    setLanguage("zh-TW");
    expect(emptyChangesWords("gitlab", { state: "merged", filter: "all", acrossRepos: false })).toBe("在此專案中，沒有已合併的合併請求。");
    expect(pipelineSourceWords("push")).toBe("推送");
    expect(pipelineSourceWords("some_new_event")).toBe("some new event");
    expect(changeSections("github", { discussions: 1, commits: 2, pipelines: 3, files: 4 } as never).map(s => s.label)).toEqual(["對話", "提交", "檢查", "變更的檔案"]);
  });

  it("keeps the server's detail text as it arrived", () => {
    setLanguage("ja");
    const words = forgeErrorWords("gitlab", { kind: "upstream", message: "502 Bad Gateway" });
    expect(words.detail).toBe("502 Bad Gateway");
    expect(words.title).toBe("GitLab がエラーを返しました");
  });
});

describe("forge keys", () => {
  it("every forge.* key a source names exists in English", () => {
    const root = join(__dirname, "..");
    const files = [
      ...readdirSync(join(root, "components/forge")).map(f => join(root, "components/forge", f)),
      join(root, "components/ForgeHtml.tsx"),
      ...["forge-panel.ts", "forge-lists.ts", "forge-detail.ts", "forge-types.ts"].map(f => join(root, f)),
    ];
    const missing: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/"(forge\.[A-Za-z0-9_.]+)"/g)) {
        const k = m[1];
        if (!(k in en) && !(`${k}.other` in en)) missing.push(`${file.slice(root.length + 1)}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
