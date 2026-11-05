// Who a Codex login is, as Local network names it — a leaf with nothing but
// node:crypto under it, because the Codex panel's reader (codex-profiles.mjs)
// needs the same name for the share dialog, and that reader is also copied
// into the self-contained terminal helper (see codex-terminal.mjs), which must
// not pull the LAN engine in after it. The rules that use the name are
// lan-codex.mjs's; the store that reads it off disk is lan-codex-store.mjs.
import { createHash } from "node:crypto";

/** Every Codex key starts with this, so one `shared` list holds both kinds and
 *  a key says which store it belongs to without a second field to agree with. */
export const CODEX_KEY_PREFIX = "codex:";

const short = value => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * The identity of one Codex account across decks: its email and its ChatGPT
 * workspace — one address can be in two workspaces, and those are two quotas.
 *
 * NOT ITS REFRESH TOKEN, which a renewal replaces: keyed on that, an account
 * would be a stranger to itself a week later and every round would add it
 * again. NOT THE RAW WORKSPACE ID either, which nothing here needs to show: it
 * is hashed, as the Codex panel hashes it for its own label.
 *
 * Null for a login with no email, which is an API key rather than an account.
 */
export function codexLanKey(email, accountId) {
  const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!mail) return null;
  const workspace = typeof accountId === "string" && accountId ? short(accountId) : "";
  return `${CODEX_KEY_PREFIX}${mail}@@${workspace}`;
}

/** A refresh token as a deck may say it: a hash, never the token. */
export const tokenHash = token => (typeof token === "string" && token ? short(token) : null);

function claimsOf(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch { return null; }
}

/** Who a Codex login is, as Local network names it, and the hash of the
 *  refresh token it carries — or null for an API key, or a file that is not a
 *  ChatGPT login. The email is the id_token's: unsigned here, so it names a row
 *  and chooses nothing that could overwrite a login (see codexSyncAction). */
export function codexLoginOf(auth) {
  if (!auth || typeof auth !== "object" || auth.auth_mode === "apikey") return null;
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object" || typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  const claims = claimsOf(tokens.id_token);
  const email = typeof claims?.email === "string" ? claims.email.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 254) : "";
  const account = typeof tokens.account_id === "string" && tokens.account_id
    ? tokens.account_id
    : claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  const key = codexLanKey(email, typeof account === "string" ? account : "");
  return key ? { key, email, rt: tokenHash(tokens.refresh_token) } : null;
}
