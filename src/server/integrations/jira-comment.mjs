// A single comment, with no caller-selected upstream URL, visibility or fields.
import { errorFromFetchFailure, errorFromStatus, integrationError } from "./errors.mjs";
import { isSafeTarget, originOf } from "./proxy.mjs";
const KEY = /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/;
export const MAX_COMMENT_LENGTH = 10000;

// Cloud API v3 uses ADF; Server/DC API v2 accepts its native text format.
export function commentBody(text, cloud) {
  if (!cloud) return text;
  return { type: "doc", version: 1, content: text.split("\n").map(line => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })) };
}
export function createJiraComment({ secret, origins, sign, authCheck, fetchImpl = globalThis.fetch, rest, cloud, invalidate }) {
  return async (key, body, signal) => {
    if (!KEY.test(key) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_COMMENT_LENGTH) {
      throw integrationError("invalid", "Enter a comment of up to 10,000 characters.");
    }
    const url = `${rest}/issue/${encodeURIComponent(key)}/comment`;
    if (!isSafeTarget(url) || !origins().includes(originOf(url))) throw integrationError("permission", "This Jira write is outside the connection's token origins.");
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 15000); timer.unref?.();
    let res;
    try {
      try { res = await fetchImpl(url, { method: "POST", redirect: "manual", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "ccdeck", ...sign(secret) }, body: JSON.stringify({ body: commentBody(body.text, cloud) }), signal: controller.signal }); }
      catch (err) { const failure = errorFromFetchFailure(err, "Jira"); failure.message = "The comment could not be confirmed. Refresh the issue before sending again."; throw failure; }
      if (res.status >= 300 && res.status < 400) throw integrationError("upstream", "Jira redirected the comment. Refresh the issue before sending again.");
      const refused = authCheck(res.headers, secret);
      if (refused) throw integrationError("expired", refused, { status: 401 });
      if (res.status !== 201) {
        if (!res.ok && res.status < 500) throw errorFromStatus(res.status, res.headers, { label: "Jira" });
        throw integrationError("upstream", "The comment could not be confirmed. Refresh the issue before sending again.");
      }
      return { status: 200, body: { ok: true, issueKey: key } };
    } finally { invalidate(); clearTimeout(timer); signal?.removeEventListener("abort", stop); await res?.body?.cancel().catch(() => {}); }
  };
}
