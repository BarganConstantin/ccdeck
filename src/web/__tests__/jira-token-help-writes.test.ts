// The Jira token help names every write the deck makes, and the scopes a
// scoped Cloud token needs for them.
//
// 3.51.0 added comments and status changes from an issue's details, but the
// help still said only that a move saves the sprint and rank, and listed the
// move scopes alone. A scoped token without write:jira-work then read the
// board, moved issues, and failed at the first comment with nothing on the
// page having said why. Atlassian's REST v3 asks write:jira-work of both
// POST …/issue/{key}/comment and POST …/issue/{key}/transitions.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LANGS = ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ro", "zh-CN", "zh-TW"];
const catalogs = Object.fromEntries(await Promise.all(LANGS.map(async lang =>
  [lang, (await import(`../i18n/areas/integrations/${lang}.ts`)).default as Record<string, string>])));
const help = readFileSync(fileURLToPath(new URL("../components/JiraTokenHelp.tsx", import.meta.url)), "utf8");

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

describe("the Jira token help", () => {
  it("hands the scoped-write sentence every scope it names, write:jira-work among them", () => {
    const passed = help.slice(help.indexOf('t("integrations.token.scopedWrite")'));
    for (const name of ["rank", "sprint", "backlog", "work"]) expect(passed).toMatch(new RegExp(`\\b${name}: <code>`));
    expect(passed).toContain("<code>write:jira-work</code>");
  });

  it("names the comment and status scope in every language", () => {
    for (const lang of LANGS) {
      expect(placeholders(catalogs[lang]["integrations.token.scopedWrite"]), lang).toEqual(["backlog", "rank", "sprint", "work"]);
    }
  });

  it("says in English that a comment or a status change is saved in Jira too", () => {
    const en = catalogs.en;
    for (const key of ["integrations.token.reads", "integrations.settings.accessBody"]) {
      expect(en[key], key).toMatch(/comment/);
      expect(en[key], key).toMatch(/status/);
    }
  });
});
