// The page's ways into reports.mjs (#1853): an error the page caught and the
// feedback dialog. (The switch in Appearance went on 2026-10-01; its route stays.) The page never
// talks to api.ccdeck.dev itself — this server does, which is also why the
// install id never has to reach the page.

import { reportsVetoed } from "./deck-prefs.mjs";
import { MAX_REQUEST_BYTES, isMultipart, readFeedbackForm, upstreamForm } from "./feedback-form.mjs";
import { readBody, readBytes, send } from "./http-io.mjs";
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

/** `POST /api/reports` `{ on }`: sets `prefs.reports`. No page control calls it since the owner
 *  removed Appearance's switch (2026-10-01); kept so a deck can still be switched off over the API. */
export async function handleReportsWrite(req, res, { report = reporter } = {}) {
  const body = await readJson(req, res, 1_000);
  if (typeof body?.on !== "boolean") return send(res, 400, { ok: false, reason: "bad_request" });
  await report.setReports(body.on);
  return send(res, 200, { ok: true, reports: heldPrefs.current().reports, reportsVetoed: reportsVetoed() });
}

/** `POST /api/client-error` `{ message, stack? }`: an error the page caught. Sent on only while reports are on. */
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
 * The API stores it, and the people who make ccdeck read it there. They may
 * open a public issue from it, never with the contact or the images; nothing
 * becomes public by being sent, which is why the answer to the page is a plain
 * "it arrived" and carries no link.
 *
 * A report with images comes as a multipart form instead, and goes on as one —
 * see feedback-form.mjs for what is checked here before it leaves. With none it
 * is the JSON post it always was.
 *
 * Not gated on the reports switch: pressing Send is its own decision, for this
 * one message. AGENTS_DECK_NO_INSTALL=1 still wins, because the README promises
 * that it "turns off everything but the quota reads", and a launch script's
 * word about the machine outranks a button on the page.
 */
export async function handleFeedback(req, res, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (env.AGENTS_DECK_NO_INSTALL === "1") return send(res, 403, { ok: false, reason: "vetoed" });
  const contentType = req.headers?.["content-type"];
  if (isMultipart(contentType)) return forwardFeedbackForm(req, res, contentType, { fetchImpl, env });
  const body = await readJson(req, res, 32_000);
  if (!body) return send(res, 400, { ok: false, reason: "bad_request" });
  const facts = feedbackFacts({ env });
  const contact = typeof body.contact === "string" && body.contact.trim() ? body.contact.trim() : undefined;
  return forwardFeedback(res, fetchImpl, {
    headers: { "content-type": "application/json", "user-agent": `ccdeck/${facts.appVersion}` },
    body: JSON.stringify({ kind: body.kind, title: body.title, body: body.body, contact, ...facts }),
    timeoutMs: JSON_TIMEOUT_MS,
  });
}

/**
 * What this deck adds to a piece of feedback, and all it adds: the ccdeck
 * version, and the system as `os-arch` — `darwin-arm64`. installFacts knows
 * more than that (the channel, the runtime, a locale, a device fingerprint)
 * and none of it goes with feedback. One function for both posts and for the
 * line the dialog draws before Send, so what the page says is sent and what
 * the API is sent are one answer and cannot drift apart.
 */
export function feedbackFacts({ env = process.env } = {}) {
  const facts = installFacts({ env });
  return { appVersion: facts.version, platform: `${facts.os}-${facts.arch}` };
}

/** `GET /api/feedback`: what a report sent from here would carry besides its
 *  words, for the dialog to say before Send. Nothing leaves the machine. */
export function handleFeedbackFacts(_req, res, { env = process.env } = {}) {
  return send(res, 200, { ok: true, ...feedbackFacts({ env }) });
}

/** Twenty seconds is plenty for a few kilobytes of JSON. */
const JSON_TIMEOUT_MS = 20_000;
/** And not for 12 MB: at 2 Mbit/s up, a line a hotel can offer, that is fifty
 *  seconds of upload before the API has read a byte of it. */
const FORM_TIMEOUT_MS = 120_000;

async function forwardFeedbackForm(req, res, contentType, { fetchImpl, env }) {
  // Over the cap, readBytes has already answered 413 too_large and the 400
  // below is a no-op; this is the answer to a read that failed some other way.
  const bytes = await readBytes(req, res, MAX_REQUEST_BYTES, { ok: false, reason: "too_large" }).catch(() => null);
  if (!bytes) return send(res, 400, { ok: false, reason: "bad_request" });
  const form = await readFeedbackForm(bytes, contentType);
  if (!form) return send(res, 400, { ok: false, reason: "bad_request" });
  if (form.problems.length > 0) return send(res, 400, { ok: false, reason: "invalid", errors: { images: form.problems } });
  const facts = feedbackFacts({ env });
  return forwardFeedback(res, fetchImpl, {
    // No content type: fetch writes the form's own, boundary and all.
    headers: { "user-agent": `ccdeck/${facts.appVersion}` },
    body: upstreamForm(form, facts),
    timeoutMs: FORM_TIMEOUT_MS,
  });
}

/** One post to the API, JSON or form, and what its answer means for the page. */
async function forwardFeedback(res, fetchImpl, { headers, body, timeoutMs }) {
  try {
    const upstream = await fetchImpl(`${REPORTS_API}/v1/feedback`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await upstream.json().catch(() => null);
    if (upstream.status === 202) return send(res, 200, { ok: true });
    if (upstream.status === 400) return send(res, 400, { ok: false, reason: "invalid", errors: answer?.errors ?? {} });
    // Its own reason rather than "unavailable": the API is up, and the fix is
    // a smaller request, which is not what "try again in a moment" says.
    if (upstream.status === 413) return send(res, 413, { ok: false, reason: "too_large" });
    if (upstream.status === 429) return send(res, 429, { ok: false, reason: "too_many" });
    return send(res, 502, { ok: false, reason: "unavailable" });
  } catch {
    return send(res, 502, { ok: false, reason: "unavailable" });
  }
}
