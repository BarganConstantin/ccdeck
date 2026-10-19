// The GitHub and GitLab providers (#2179), for the integrations core's table;
// registry.mjs has the contract.
//
// Both are the same shape: a client from github-api.mjs or gitlab-api.mjs made
// for one connection — which reads, keeps its short caches, and fetches the
// images the panel draws — and the reads in forge-routes.mjs under
// /api/integrations/<kind>/<connId>/. What differs is where the forge is:
// GitHub is github.com (an Enterprise Server address can come later; the
// client already takes one), GitLab is gitlab.com or the instance the user
// typed, under its path if it has one.
import { ForgeError } from "../forge-http.mjs";
import { forgeRead } from "../forge-routes.mjs";
import { createGithubClient } from "../github-api.mjs";
import { createGitlabClient } from "../gitlab-api.mjs";
import { integrationError } from "./errors.mjs";
import { normaliseBaseUrl } from "./proxy.mjs";

const GITHUB = "https://github.com";
const GITLAB = "https://gitlab.com";

/** The token typed, or the saved one when an edit left the field blank. */
function tokenFrom(input, existing) {
  const typed = typeof input?.token === "string" ? input.token.trim() : "";
  const secret = typed || existing?.secret || null;
  if (!secret) throw integrationError("invalid", "Enter a token.", { field: "token" });
  return secret;
}

/** The client, with validate() in the core's terms: a token refused while a
 *  form is checked is a wrong one (auth); refused on Test, after it was
 *  saved, it has expired or been revoked. */
function withPhase(client) {
  return {
    ...client,
    async validate({ phase = "validate" } = {}) {
      try {
        return await client.validate();
      } catch (err) {
        if (phase === "use" && err?.kind === "auth") throw new ForgeError("expired", err.message, { status: err.status });
        throw err;
      }
    },
  };
}

const reads = (client, method, subpath, params) => forgeRead(client, method, subpath, params);

export const githubProvider = {
  kind: "github",
  label: "GitHub",
  createClient: (conn, secret, { fetchImpl } = {}) =>
    withPhase(createGithubClient({ baseUrl: conn.baseUrl || GITHUB, token: secret, fetchImpl })),
  routes: reads,
  parseInput: (input, existing) => ({ baseUrl: GITHUB, secret: tokenFrom(input, existing), meta: {} }),
  // Two GitHub connections are two accounts; the login tells them apart.
  defaultName: checked => checked?.account?.login || "GitHub",
};

export const gitlabProvider = {
  kind: "gitlab",
  label: "GitLab",
  createClient: (conn, secret, { fetchImpl } = {}) =>
    withPhase(createGitlabClient({ baseUrl: conn.baseUrl || GITLAB, token: secret, fetchImpl })),
  routes: reads,
  parseInput: (input, existing) => ({
    baseUrl: input?.where === "self"
      ? normaliseBaseUrl(input?.baseUrl, { field: "baseUrl", label: "your GitLab's address" })
      : GITLAB,
    secret: tokenFrom(input, existing),
    meta: {},
  }),
  // Two GitLab connections are usually two instances; the host tells them apart.
  defaultName: checked => {
    try { return new URL(checked.baseUrl).host; } catch { return "GitLab"; }
  },
};
