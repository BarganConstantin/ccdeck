// The page's three ways into reports.mjs (#1853): the person's answer to the
// question, an error the page caught, and the feedback dialog. The page never
// talks to api.ccdeck.dev itself — this server does, which is also why the
// install id never has to reach the page.

import { reportsVetoed } from "./deck-prefs.mjs";
import { readBody, send } from "./http-io.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { REPORTS_API, installFacts, reporter } from "./reports.mjs";

async function readJson(req, res, limit) {
  const raw = await readBody(req, res, limit).catch(() => null);
  try {
    const body = JSON.parse(raw ?? "");
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** `POST /api/reports` `{ on }`: the answer to "send anonymous reports?". */
export async function handleReportsWrite(req, res, { report = reporter } = {}) {
  const body = await readJson(req, res, 1_000);
  if (typeof body?.on !== "boolean") return send(res, 400, { ok: false, reason: "bad_request" });
  await report.setReports(body.on);
  return send(res, 200, { ok: true, reports: heldPrefs.current().reports, reportsVetoed: reportsVetoed() });
}

/** `POST /api/client-error` `{ message, stack? }`: an error the page caught. Sent only if reports are on. */
export async function handleClientError(req, res, { report = reporter } = {}) {
  const body = await readJson(req, res, 16_000);
  if (typeof body?.message !== "string") return send(res, 400, { ok: false, reason: "bad_request" });
  const stack = typeof body.stack === "string" ? body.stack : undefined;
  const sent = await report.reportError("web", { message: body.message, stack });
  return send(res, 202, { ok: true, sent });
}

/**
 * `POST /api/feedback` `{ kind, title, body, contact? }`: the feedback dialog.
 *
 * Not gated on the reports answer: pressing Send is its own answer, for this
 * one message. AGENTS_DECK_NO_INSTALL=1 still wins, because the README promises
 * that it "turns off everything but the quota reads", and a launch script's
 * word about the machine outranks a button on the page.
 */
export async function handleFeedback(req, res, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (env.AGENTS_DECK_NO_INSTALL === "1") return send(res, 403, { ok: false, reason: "vetoed" });
  const body = await readJson(req, res, 32_000);
  if (!body) return send(res, 400, { ok: false, reason: "bad_request" });
  const facts = installFacts({ env });
  const contact = typeof body.contact === "string" && body.contact.trim() ? body.contact.trim() : undefined;
  try {
    const upstream = await fetchImpl(`${REPORTS_API}/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `ccdeck/${facts.version}` },
      body: JSON.stringify({
        kind: body.kind, title: body.title, body: body.body, contact,
        appVersion: facts.version, platform: `${facts.os}-${facts.arch}`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const answer = await upstream.json().catch(() => null);
    if (upstream.status === 202) return send(res, 200, { ok: true, issue: answer?.issue ?? null });
    if (upstream.status === 400) return send(res, 400, { ok: false, reason: "invalid", errors: answer?.errors ?? {} });
    if (upstream.status === 429) return send(res, 429, { ok: false, reason: "too_many" });
    return send(res, 502, { ok: false, reason: "unavailable" });
  } catch {
    return send(res, 502, { ok: false, reason: "unavailable" });
  }
}
