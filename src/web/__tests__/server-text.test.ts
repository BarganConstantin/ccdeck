import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { integrationText } from "../integrations/server-text";
import { OwnError, ownMessage } from "../own-error";
import { loginErrorText } from "../admin-failure";
import { imageProblem } from "../feedback";
import { claudeReasonText } from "../use-claude-settings";
import { setLanguage } from "../i18n";

describe("the deck's fixed sentences, said in the language on show", () => {
  it("leaves English as it came", () => {
    setLanguage("en");
    expect(integrationText("Enter a token.")).toBe("Enter a token.");
    expect(integrationText("Jira did not accept these credentials.")).toBe("Jira did not accept these credentials.");
    expect(integrationText("Jira is limiting requests. Try again in 30 s.")).toBe("Jira is limiting requests. Try again in 30 s.");
    expect(integrationText("https://x.test did not answer in time")).toBe("https://x.test did not answer in time");
  });
  it("translates an exact sentence and keeps the variable part of a pattern", () => {
    setLanguage("de");
    expect(integrationText("Enter a token.")).toBe("Gib ein Token ein.");
    expect(integrationText("Jira is limiting requests. Try again in 30 s.")).toBe("Jira begrenzt die Anfragen. Versuche es in 30 s erneut.");
    expect(integrationText("The deck could not reach GitHub (ECONNREFUSED). Check the URL, your network or VPN.")).toContain("ECONNREFUSED");
    expect(integrationText("This Jira write is outside the connection’s token origins.")).not.toContain("outside");
    setLanguage("en");
  });
  it("shows a provider's own words as they came, and never a prototype row", () => {
    setLanguage("de");
    expect(integrationText("Field 'x' cannot be set.")).toBe("Field 'x' cannot be set.");
    expect(integrationText("constructor")).toBe("constructor");
    expect(integrationText("")).toBe("");
    setLanguage("en");
  });
  it("says the other fixed sentences of the deck's routes too", () => {
    setLanguage("ja");
    expect(loginErrorText("the sign-in window expired")).not.toBe("the sign-in window expired");
    expect(loginErrorText("that code was not accepted — copy it again from the browser")).not.toContain("copy it again");
    expect(loginErrorText("claude auth login took too long and was stopped")).toContain("claude auth login");
    expect(loginErrorText("Error: some CLI line")).toBe("Error: some CLI line");
    expect(imageProblem("Image 2 is over 5 MB.")).toContain("5 MB");
    expect(imageProblem("Image 2 is over 5 MB.")).not.toContain("Image");
    expect(claudeReasonText("Could not read Claude Code settings. Try again.")).not.toContain("Could not");
    expect(claudeReasonText("Invalid settings request.")).not.toContain("Invalid");
    setLanguage("en");
  });
});

describe("an error shown on screen", () => {
  it("is our own sentence or the site's fallback, never a browser's English", () => {
    expect(ownMessage(new OwnError("Mine"), "Fallback")).toBe("Mine");
    expect(ownMessage(new TypeError("Failed to fetch"), "Fallback")).toBe("Fallback");
    expect(ownMessage(new DOMException("Unable to decode audio data", "EncodingError"), "Fallback")).toBe("Fallback");
    expect(ownMessage(new OwnError(""), "Fallback")).toBe("Fallback");
    expect(ownMessage("text", "Fallback")).toBe("Fallback");
  });
});

describe("the table of the deck's sentences", () => {
  // The match is on exact English, so a sentence reworded on the server would
  // fall back to English without anything failing. This is what fails instead.
  it("names only sentences the routes still send", () => {
    const dir = new URL("../../server/", import.meta.url);
    const routes = readdirSync(dir, { recursive: true })
      .map(String)
      .filter(file => file.endsWith(".mjs"))
      .map(file => readFileSync(new URL(file, dir), "utf8"))
      .join("\n")
      .replace(/\u2019/g, "'")
      .replace(/\\'/g, "'")
      .replace(/["'`]\s*\+\s*["'`]/g, "");
    const source = readFileSync(new URL("../integrations/server-text.ts", import.meta.url), "utf8");
    const table = source.slice(source.indexOf("const EXACT"), source.indexOf("const PATTERNS"));
    const sentences = [...table.matchAll(/^  "(.+)": "[\w.]+",$/gm)].map(row => row[1]);
    expect(sentences.length).toBeGreaterThan(50);
    // Built on the server from a field's label or a version, so not one literal.
    const composed = /^Enter your |^Your .+ is not a valid URL\.$|^This server runs Jira of an unknown version/;
    expect(sentences.filter(sentence => !composed.test(sentence) && !routes.includes(sentence))).toEqual([]);
  });
});
