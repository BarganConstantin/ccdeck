// GET /api/hook-challenge, where a hook asks whether the process on this port
// is the deck its discovery record describes, and the token that record
// carries for it to be asked about.
//
// These lived in src/server/index.mjs, after health. The token is
// request-gates.mjs's and the proof deck-probe.mjs's; this answers with one.
// The bodies are unchanged.
import { HOOK_TOKEN } from "./request-gates.mjs";
import { challengeProof } from "./deck-probe.mjs";
import { send } from "./http-io.mjs";

/** The token this deck expects to be challenged on. Written by writeDiscovery. */
export function hookToken() { return HOOK_TOKEN; }

// GET /api/hook-challenge?nonce=… — answer a hook's challenge.
//
// The nonce is the caller's, so the answer proves knowledge of the token
// without disclosing it, and proves it for this exchange only. Answering
// freely is what the exchange requires: the hook is asking whether the process
// on this port is the deck that wrote the discovery file, and it asks precisely
// because it does not yet know — a deck that demanded credentials before
// answering could not be told apart from a stranger that refuses.
//
// So this route is an oracle, and it must stay one. That makes its answer
// useless as a credential FOR this server, and nothing here may ever accept it
// as one: a caller who can GET this can obtain a valid proof for any nonce, so
// a gate honouring proofs is a gate honouring anybody. See presentsDeckToken,
// which takes the token itself and refuses the hashed form for this reason.
//
// What the free answer does NOT give away is the token: the response is a
// one-way hash of it, and behind isTrustedRead, the read gate in front of the
// route table, a rebound page cannot see even that.
export function handleHookChallenge(_req, res, url) {
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!nonce || nonce.length > 256) return send(res, 400, { error: "bad nonce" });
  send(res, 200, { proof: challengeProof(HOOK_TOKEN, nonce) });
}
