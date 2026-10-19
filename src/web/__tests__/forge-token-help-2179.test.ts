// #2179: the help beside a GitHub or GitLab token field.
//
// What these pin: it asks for read access and nothing more — repo + read:org
// for a classic GitHub token, the read-only fine-grained permissions with
// Contents among them (branches and commits need it), read_api on GitLab; the
// "make one" link goes to the forge's own token page, on the GitLab instance
// that was typed (under its path too), and is left out while what was typed is
// not an address; and every link opens outside the deck.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ForgeTokenHelp, { forgeTokenUrl } from "../components/forge/ForgeTokenHelp";

describe("where a token is made", () => {
  it("is GitHub's own page, prefilled with the classic scopes", () => {
    expect(forgeTokenUrl("github")).toBe("https://github.com/settings/tokens/new?scopes=repo,read:org&description=ccdeck");
    expect(forgeTokenUrl("github", null, "fine-grained")).toBe("https://github.com/settings/personal-access-tokens/new");
  });

  it("is the GitLab instance that was typed, under its path, asking for read_api", () => {
    expect(forgeTokenUrl("gitlab", "")).toBe("https://gitlab.com/-/user_settings/personal_access_tokens?name=ccdeck&scopes=read_api");
    expect(forgeTokenUrl("gitlab", "https://git.example.com/gitlab/"))
      .toBe("https://git.example.com/gitlab/-/user_settings/personal_access_tokens?name=ccdeck&scopes=read_api");
  });

  it("takes an address typed without its scheme, as the deck does", () => {
    expect(forgeTokenUrl("gitlab", "git.example.com")).toBe("https://git.example.com/-/user_settings/personal_access_tokens?name=ccdeck&scopes=read_api");
  });

  it("is nowhere while what was typed is not an address", () => {
    expect(forgeTokenUrl("gitlab", "git")).toBeNull();
    expect(forgeTokenUrl("gitlab", "javascript:alert(1)")).toBeNull();
    expect(forgeTokenUrl("gitlab", "ftp://git.example.com")).toBeNull();
  });
});

describe("what the help says", () => {
  const html = (kind: "github" | "gitlab", baseUrl?: string) => renderToStaticMarkup(createElement(ForgeTokenHelp, { kind, baseUrl }));

  it("asks GitHub for read access only, Contents included", () => {
    const out = html("github");
    expect(out).toContain("<code>repo</code>");
    expect(out).toContain("<code>read:org</code>");
    expect(out).toMatch(/read-only access to Actions, Checks,\s+Commit statuses, Contents, Issues, Metadata and Pull requests/);
    expect(out).not.toMatch(/write|admin/i);
  });

  it("asks GitLab for read_api and names the instance it links to", () => {
    const out = html("gitlab", "https://git.example.com");
    expect(out).toContain("<code>read_api</code>");
    expect(out).toContain("Make one on git.example.com");
  });

  it("opens every link outside the deck", () => {
    for (const out of [html("github"), html("gitlab")]) {
      const links = out.match(/<a [^>]+>/g) ?? [];
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) expect(a).toMatch(/target="_blank" rel="noreferrer noopener"/);
    }
  });
});
