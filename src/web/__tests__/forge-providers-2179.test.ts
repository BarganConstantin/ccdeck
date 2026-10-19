// #2179: GitHub and GitLab as providers of the integrations core (#2178),
// src/server/integrations/forge.mjs.
//
// What these pin: both register beside Jira; a GitHub connection is always
// github.com, a GitLab one gitlab.com unless the form says it is the user's own
// instance, whose address is held to the core's rules (https, kept under its
// path); a blank token on an edit keeps the saved one and a new connection
// needs one; a token refused while the form is checked is "auth", and refused
// on Test, after it worked, "expired"; the reads are forge-routes.mjs's, bad
// parameters answered "invalid"; and an unnamed connection is called by its
// login on GitHub and its host on GitLab.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { githubProvider, gitlabProvider } from "../../server/integrations/forge.mjs";
// @ts-expect-error — plain JS module, no types
import { getProvider, providerList } from "../../server/integrations/registry.mjs";
// @ts-expect-error — plain JS module, no types
import "../../server/integrations/providers.mjs";

const token = ["ghp", "TEST"].join("_");

async function failure(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    return err as { kind: string; message: string; field?: string };
  }
  throw new Error("expected a failure");
}

describe("registered beside Jira", () => {
  it("as github and gitlab", () => {
    expect(providerList()).toEqual(expect.arrayContaining([
      { kind: "jira", label: "Jira" }, { kind: "github", label: "GitHub" }, { kind: "gitlab", label: "GitLab" },
    ]));
    expect(getProvider("github")).toBe(githubProvider);
    expect(getProvider("gitlab")).toBe(gitlabProvider);
  });
});

describe("the connect form", () => {
  it("makes every GitHub connection a github.com one", () => {
    expect(githubProvider.parseInput({ token, baseUrl: "https://evil.example" })).toEqual({ baseUrl: "https://github.com", secret: token, meta: {} });
  });

  it("makes a GitLab connection gitlab.com unless it is the user's own instance", () => {
    expect(gitlabProvider.parseInput({ where: "cloud", token, baseUrl: "https://git.example.com" }).baseUrl).toBe("https://gitlab.com");
    expect(gitlabProvider.parseInput({ token }).baseUrl).toBe("https://gitlab.com");
    expect(gitlabProvider.parseInput({ where: "self", token, baseUrl: "git.example.com/gitlab/" }).baseUrl).toBe("https://git.example.com/gitlab");
  });

  it("holds an instance's address to the core's rules", async () => {
    const http = await failure(() => gitlabProvider.parseInput({ where: "self", token, baseUrl: "http://git.example.com" }));
    expect(http).toMatchObject({ kind: "invalid", field: "baseUrl" });
    expect(await failure(() => gitlabProvider.parseInput({ where: "self", token, baseUrl: "" }))).toMatchObject({ kind: "invalid", field: "baseUrl" });
  });

  it("keeps the saved token when an edit leaves it blank, and asks for one otherwise", async () => {
    for (const provider of [githubProvider, gitlabProvider]) {
      expect(provider.parseInput({ token: "  " }, { conn: {}, secret: "saved" }).secret).toBe("saved");
      expect(await failure(() => provider.parseInput({ token: "" }))).toMatchObject({ kind: "invalid", field: "token" });
    }
  });

  it("names an unnamed connection by its login on GitHub and its host on GitLab", () => {
    expect(githubProvider.defaultName({ baseUrl: "https://github.com", account: { login: "alice" } })).toBe("alice");
    expect(gitlabProvider.defaultName({ baseUrl: "https://git.example.com/gitlab", account: { login: "alice" } })).toBe("git.example.com");
  });
});

describe("the client", () => {
  const refused = async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } });

  it("calls a refused token wrong while the form is checked, and expired on Test", async () => {
    for (const [provider, baseUrl] of [[githubProvider, "https://github.com"], [gitlabProvider, "https://git.example.com"]] as const) {
      const client = provider.createClient({ baseUrl }, token, { fetchImpl: refused });
      expect((await failure(client.validate({ phase: "validate" }))).kind).toBe("auth");
      expect((await failure(client.validate({ phase: "use" }))).kind).toBe("expired");
    }
  });

  it("keeps the token origins and the image fetch the core reads", () => {
    const gh = githubProvider.createClient({ baseUrl: "https://github.com" }, token);
    const gl = gitlabProvider.createClient({ baseUrl: "https://git.example.com/gitlab" }, token);
    expect(gh.allowedOrigins).toEqual(["https://api.github.com"]);
    expect(gl.allowedOrigins).toEqual(["https://git.example.com"]);
    expect(typeof gh.fetchAsset).toBe("function");
    expect(typeof gl.fetchAsset).toBe("function");
  });

  it("answers the panel's reads, refusing a malformed one before the forge hears of it", async () => {
    let asked = 0;
    const client = gitlabProvider.createClient({ baseUrl: "https://git.example.com" }, token, { fetchImpl: async () => { asked++; return refused(); } });
    const bad = await gitlabProvider.routes(client, "GET", "branches", new URLSearchParams("repo=../etc"));
    expect(bad).toMatchObject({ status: 400, body: { ok: false, error: { kind: "invalid" } } });
    expect((await gitlabProvider.routes(client, "GET", "nothing-here", new URLSearchParams())).status).toBe(404);
    expect(asked).toBe(0);
  });
});
