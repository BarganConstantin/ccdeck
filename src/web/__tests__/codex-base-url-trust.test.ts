// A live OpenAI Bearer token was sent wherever a config file said.
//
// codex-quota's readBaseUrl matched `chatgpt_base_url` out of
// ~/.codex/config.toml with a loose line regex, stripped the quotes, and used
// the result verbatim in
// `fetch(base + usagePath(base), {headers: {Authorization: `Bearer ${…}`}})`.
// Only chatgpt.com and chat.openai.com got special path handling; every other
// scheme and host — `http://`, a raw IP, anything — passed straight through. So
// anything able to write that TOML, or to set $CODEX_HOME and point it at its
// own, redirected a live ChatGPT session token to a host of its choosing, in
// cleartext if it liked. codex-auth had the same shape for
// $CODEX_REFRESH_TOKEN_URL_OVERRIDE, which chooses where the SINGLE-USE refresh
// token is POSTed.
//
// The Codex CLI honours both keys; the difference is that those credentials are
// its own, and the deck is a bystander that reads them. So the deck checks
// before it attaches anything, and says so rather than going quietly dark.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Sandboxed CODEX_HOME, set before the dynamic import: both codex modules read
// the path once at module load, and the real ~/.codex holds a real login.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-base-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });

// A credential file with no readable `exp` and no `last_refresh`, so
// shouldRefresh answers false and nothing here can spend a refresh token even
// if the guard under test were removed.
writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
  tokens: { access_token: "test-access-token-not-a-jwt", refresh_token: "test-refresh-token" },
}));

const config = (body: string) => writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), body);

// @ts-expect-error — plain JS module, no types
const { isCredentialHost, forceCodexRefresh } = await import("../../server/codex-auth.mjs");
// @ts-expect-error — plain JS module, no types
const { fetchCodexQuota } = await import("../../server/codex-quota.mjs");

describe("isCredentialHost", () => {
  it("accepts the hosts the Codex credentials belong to", () => {
    for (const url of [
      "https://chatgpt.com/backend-api",
      "https://chat.openai.com/backend-api",
      "https://api.openai.com/v1",
      "https://auth.openai.com/oauth/token",
      "https://some-tenant.chatgpt.com/backend-api",   // OpenAI moves subdomains
      "https://CHATGPT.COM/backend-api",               // hosts are case-insensitive
    ]) {
      expect(isCredentialHost(url), url).toBe(true);
    }
  });

  it("refuses plaintext http, whoever is on the other end", () => {
    expect(isCredentialHost("http://chatgpt.com/backend-api")).toBe(false);
    expect(isCredentialHost("http://127.0.0.1:9/")).toBe(false);
  });

  it("refuses a host that is merely spelled like one of ours", () => {
    for (const url of [
      "https://chatgpt.com.evil.example/",     // a different registrable domain
      "https://chatgpt.com@evil.example/",     // userinfo, not a host
      "https://evil.example/chatgpt.com",      // a path
      "https://notopenai.com/",                // suffix without the dot
      "https://openai.com.br/",
      "https://192.0.2.1/",
      "ftp://chatgpt.com/",
      "//chatgpt.com/",                        // not an absolute URL at all
      "chatgpt.com",
      "",
      null,
      undefined,
    ]) {
      expect(isCredentialHost(url), String(url)).toBe(false);
    }
  });
});

// The other destination, and the dearer credential. isCredentialHost above can
// be perfectly right while nothing asks it: `refreshUrl` reverted to
// `return override || DEFAULT` keeps every case above green and posts the
// user's single-use refresh token wherever the environment says, over plain
// http if it likes — and the user is logged out of Codex the next time the real
// CLI tries to refresh. So these cases spend the token for real, against a
// transport that records where it went.
//
// `forceCodexRefresh` rather than a quota read: the credential file above has
// no readable `exp` on purpose, so nothing here refreshes on its own, and the
// forced path is the one that reaches doRefresh with the token on disk. The
// transport refuses every request, which is also what keeps auth.json exactly
// as it was written — a refresh that never came back writes nothing.
describe("CODEX_REFRESH_TOKEN_URL_OVERRIDE, where the refresh token is POSTed", () => {
  const DEFAULT_URL = "https://auth.openai.com/oauth/token";
  const realFetch = globalThis.fetch;
  const prevOverride = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
  const authFile = join(process.env.CODEX_HOME!, "auth.json");
  const authBefore = readFileSync(authFile, "utf8");
  let posts: { url: string; method?: string; refreshToken?: string }[] = [];
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    posts = [];
    globalThis.fetch = ((input: unknown, init?: { method?: string; body?: string }) => {
      posts.push({
        url: String((input as { url?: string })?.url ?? input),
        method: init?.method,
        refreshToken: JSON.parse(String(init?.body ?? "{}")).refresh_token,
      });
      return Promise.reject(new Error("test: no network"));
    }) as typeof fetch;
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    logged.mockRestore();
    if (prevOverride === undefined) delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
    else process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = prevOverride;
    writeFileSync(authFile, authBefore);
  });

  /** Set the override, spend the refresh token once, and say where it went. */
  async function refreshWith(override: string) {
    process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = override;
    const r = await forceCodexRefresh("test-access-token-not-a-jwt");
    // The refusing transport ends every attempt the same way, which is the
    // proof it got as far as asking — and that nothing was written.
    expect(r).toMatchObject({ ok: false, reason: "refresh_failed" });
    expect(readFileSync(authFile, "utf8")).toBe(authBefore);
    expect(posts, "exactly one refresh attempt").toHaveLength(1);
    expect(posts[0]).toMatchObject({ method: "POST", refreshToken: "test-refresh-token" });
    return posts[0].url;
  }

  const saidOverride = () => logged.mock.calls.map(c => c.join(" "))
    .filter(s => s.includes("CODEX_REFRESH_TOKEN_URL_OVERRIDE"));

  it("ignores an override naming a host that is not OpenAI's, and says so", async () => {
    expect(await refreshWith("https://evil.example/oauth/token")).toBe(DEFAULT_URL);
    // Falling back rather than failing keeps a stale override working; the log
    // line is what stops the fallback being the silent kind.
    expect(saidOverride()).toHaveLength(1);
    expect(saidOverride()[0]).toContain("evil.example");
  });

  it("ignores a plaintext override even on OpenAI's own host", async () => {
    expect(await refreshWith("http://auth.openai.com/oauth/token")).toBe(DEFAULT_URL);
  });

  it("ignores a host that only begins with an OpenAI one", async () => {
    expect(await refreshWith("https://auth.openai.com.evil.example/t")).toBe(DEFAULT_URL);
  });

  it("reads a blank override as no override at all", async () => {
    // What `export CODEX_REFRESH_TOKEN_URL_OVERRIDE=$UNSET_THING` leaves
    // behind. Not a misconfiguration worth a log line, just an unset knob.
    expect(await refreshWith("   ")).toBe(DEFAULT_URL);
    expect(saidOverride()).toEqual([]);
  });

  it("still honours an override that names an OpenAI host over https", async () => {
    // The Codex CLI supports this knob for staging and FedRAMP tenants, and a
    // guard that refused those too would break a working login.
    expect(await refreshWith("https://staging.auth.openai.com/oauth/token"))
      .toBe("https://staging.auth.openai.com/oauth/token");
    expect(saidOverride()).toEqual([]);
  });

  it("never lets the token leave for a host outside openai.com and chatgpt.com", async () => {
    for (const hostile of [
      "https://evil.example/oauth/token",
      "http://auth.openai.com/oauth/token",
      "https://auth.openai.com.evil.example/t",
      "https://chatgpt.com@evil.example/oauth/token",
      "http://127.0.0.1:9/oauth/token",
    ]) {
      posts = [];
      writeFileSync(authFile, authBefore);
      // Spelled out here rather than asked of isCredentialHost, so a guard that
      // loosened its own rule cannot vouch for where it sent the token.
      const { protocol, hostname } = new URL(await refreshWith(hostile));
      expect(protocol, `${hostile} sent the token in cleartext`).toBe("https:");
      expect(/(^|\.)(openai|chatgpt)\.com$/.test(hostname), `${hostile} sent the token to ${hostname}`).toBe(true);
    }
  });
});

// #580 put a floor under forced reads: two `force: true` calls inside
// FORCE_POLL_MS are one request upstream, and the second is answered from the
// cache without asking anyone. Every case below is written as "a forced read that
// goes out and is refused at the destination", so each is given a minute of its
// own instead of inheriting the previous case's. The clock is moved rather than
// waited on, the way read-cost-ceiling.test.ts moves it.
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);

describe("fetchCodexQuota against an untrusted base URL", () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeAll(() => {
    // Recorded rather than stubbed to fail: a test that asserts "no request was
    // made" has to be able to see the request it is claiming did not happen.
    globalThis.fetch = ((input: unknown) => {
      calls.push(String((input as { url?: string })?.url ?? input));
      return Promise.reject(new Error("test: no network"));
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    for (const k of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmTempDir(DIR);
  });

  beforeEach(() => {
    calls = [];
    skew += 5 * 60_000;   // see the note above the describe
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("makes no request at all when config.toml points somewhere else", async () => {
    config('chatgpt_base_url = "http://127.0.0.1:9/"\n');
    const r = await fetchCodexQuota({ force: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("untrusted_base_url");
    expect(calls).toEqual([]);
  });

  it("refuses an https host outside the allowlist too, not just plaintext", async () => {
    config('chatgpt_base_url = "https://collector.evil.example/backend-api"\n');
    const r = await fetchCodexQuota({ force: true });
    expect(r.reason).toBe("untrusted_base_url");
    expect(calls).toEqual([]);
  });

  it("says why, once, rather than going dark", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    config('chatgpt_base_url = "https://another.evil.example/"\n');
    await fetchCodexQuota({ force: true });
    await fetchCodexQuota({ force: true });
    const said = spy.mock.calls.map(c => c.join(" ")).filter(s => /another\.evil\.example/.test(s));
    // A 60-second poll must not turn one misconfiguration into a log flood.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/chatgpt_base_url/);
  });

  it("still lets the real endpoint through, which is the case all this protects", async () => {
    config('chatgpt_base_url = "https://chatgpt.com/backend-api"\n');
    const r = await fetchCodexQuota({ force: true });
    // The stub rejects, so this ends as fetch_error — the point is that it got
    // as far as asking.
    expect(r.reason).toBe("fetch_error");
    expect(calls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  });

  it("uses the default endpoint when there is no config.toml", async () => {
    rmSync(join(process.env.CODEX_HOME!, "config.toml"), { force: true });
    await fetchCodexQuota({ force: true });
    expect(calls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  });
});
