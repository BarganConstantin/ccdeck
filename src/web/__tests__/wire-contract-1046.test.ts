// #1046: types.ts is the wire contract, and tsc checks the half of it that is
// declared. The undeclared half was a free-for-all because of one line —
// `[key: string]: any` — so six load-bearing fields the reducer reads every
// second typechecked at `any`, and three other declarations had drifted from
// what the server actually sends without anything going red.
//
// None of this was a live crash: every reader defends itself. That is the point
// worth pinning. `HookEnvelope.payload` was declared required and non-nullable
// while the server has a path whose purpose is to send null, and THREE separate
// authors independently wrote around it — reducer.ts's `env.payload ?? {}`,
// settlesInFlightCall's `env?.payload`, and chimeFor, which gave up on the
// interface and declared its own nullable shape. A type that three people work
// around is not describing the wire.
//
// These read the declarations rather than the runtime, because a declaration is
// what was wrong. A source-text guard is the weaker instrument in general; here
// it is the only one that can see the defect at all, since every consequence
// was already defended against.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const types = read("../types.ts");
const server = read("../../server/index.mjs");
const quota = read("../../server/quota.mjs");
const selfUpdate = read("../../server/self-update.mjs");
const app = read("../App.tsx");
const panel = read("../components/UsagePanel.tsx");
const chip = read("../version-chip.ts");
const sound = read("../sound.ts");
const lanSocket = read("../../server/lan-socket.mjs");

/** The body of an interface or type alias, comments stripped. */
function decl(source: string, name: string): string {
  const m = new RegExp(`(?:interface|type) ${name}\\s*=?\\s*\\{`).exec(source);
  expect(m, `${name} is not declared`).not.toBeNull();
  let depth = 0, out = "";
  for (let i = source.indexOf("{", m!.index); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (!depth) break; }
    out += source[i];
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const declares = (body: string, field: string) =>
  new RegExp(`(?:^|[;{\\s])${field}\\??\\s*:`, "m").test(body);

describe("the payload contract names what the reducer reads (#1046)", () => {
  const payload = decl(types, "HookPayload");

  // Each of these is emitted by the server and read by the reducer. The table
  // is the issue's, re-derived here from both sides so it cannot go stale.
  const SIX: [string, string][] = [
    ["model", 'hook_event_name: "ModelObserved"'],
    ["subagentModels", "subagentModels,"],
    ["usage", 'hook_event_name: "UsageObserved"'],
    ["context", 'hook_event_name: "ContextObserved"'],
    ["kind", 'hook_event_name: "OutputObserved"'],
    ["at", 'hook_event_name: "OutputObserved"'],
  ];

  for (const [field, emittedNear] of SIX) {
    it(`declares \`${field}\`, which the server emits and the reducer reads`, () => {
      expect(server, `the server no longer emits ${field}`).toContain(emittedNear);
      expect(declares(payload, field), `${field} typechecks at any, via the index signature`).toBe(true);
    });
  }

  it("keeps the index signature, because the wire really is open-ended", () => {
    // Not a defect to remove — /api/event accepts whatever a CLI sends and the
    // deck forwards fields it has no opinion about. What changed is that the
    // DECLARED set stopped being arbitrary.
    expect(payload).toMatch(/\[key: string\]: any;/);
  });
});

describe("an envelope can carry no payload, and now says so (#1046)", () => {
  const envelope = decl(types, "HookEnvelope");

  it("declares payload nullable, because the server has a path that sends null", () => {
    // The containment for a payload it cannot serialize: the seq is still
    // spent, so no resuming client is left with a hole it cannot ask about.
    expect(server).toContain("evt.payload = null;");
    expect(server).toContain("evt.unserializable = true;");
    expect(envelope).toMatch(/payload:\s*HookPayload \| null;/);
    expect(declares(envelope, "unserializable")).toBe(true);
  });

  it("leaves the three guards that were written around the lie typechecking", () => {
    // They were correct all along; they simply had nothing to be correct
    // against. If any of these disappears, the nullable declaration has stopped
    // being load-bearing and somebody should know.
    expect(read("../reducer.ts")).toMatch(/env\.payload \?\? \{\}/);
    expect(sound).toMatch(/payload\?: \{ hook_event_name\?: string \} \| null/);
  });
});

describe("the two lookup tables a caller can choose the key of (#1046)", () => {
  it("asks whether the refusal map has a ROW, since the key comes off the wire", () => {
    // `msg.why` is a field in a frame written by the other machine. Every member
    // of Object.prototype answers a plain bracket read with an inherited value
    // that is neither nullish nor falsy, so `?? "the other deck refused this
    // handshake"` never fired for one — and `new Error(Object).message` is
    // "function Object() { [native code] }", which lan-engine files as
    // lastRound.error and the LAN panel prints verbatim.
    expect(lanSocket).toMatch(/Object\.hasOwn\(REFUSALS, msg\.why\)/);
    expect(lanSocket).not.toMatch(/\}\[msg\.why\]/);
  });

  it("asks the same of CHIMES, whose key is hook_event_name off /api/event", () => {
    // `Record<string, Chime>` typed the read as Chime and never undefined,
    // which is what made the missing guard invisible to tsc.
    expect(sound).toMatch(/Object\.hasOwn\(CHIMES, name\)/);
    expect(sound).not.toMatch(/const CHIMES: Record<string, Chime>/);
  });
});

describe("the fields the server computed and the client dropped (#1046)", () => {
  it("declares checkFailedAt, and the chip says npm was not reached", () => {
    // Computed, serialised, delivered — and declared nowhere on this side, so
    // it was dropped at the door. checkedAt deliberately does not move on a
    // failure, so a machine behind a proxy showed `checked 3h ago` beside a
    // cached `npm has vX` and offered no update, with the one fact that
    // explained it unread in the response.
    expect(selfUpdate).toMatch(/checkFailedAt: marker\?\.failedAt \?\? null,/);
    expect(declares(decl(app, "VersionInfo"), "checkFailedAt")).toBe(true);
    expect(declares(decl(chip, "VersionChipCopy"), "checkFailedAgo")).toBe(true);
    expect(chip).toMatch(/could not reach npm/);
    // And the accessible name too: the chip looks identical either way, so a
    // reader who cannot see the tooltip needs it most.
    expect(chip).toMatch(/npm could not be reached/);
  });

  it("only says it when the failure is newer than the last success", () => {
    // Otherwise it describes a problem that has already gone away.
    expect(app).toMatch(/version\.checkFailedAt > \(version\.checkedAt \?\? 0\)/);
  });

  it("declares the four pay-as-you-go fields the quota route spreads", () => {
    // A user on a plan with extra credits saw the 5h and 7d bars and no sign
    // they were spending against a monthly top-up limit — the one number on
    // this panel with a hard financial edge.
    for (const f of ["extraEnabled", "extraUsedCredits", "extraMonthlyLimit", "extraCurrency"]) {
      expect(quota, `the server no longer sends ${f}`).toContain(`result.${f}`);
      expect(declares(decl(panel, "QuotaData"), f), `${f} is still dropped`).toBe(true);
    }
  });

  it("draws the top-up as a proportion, not as an amount in an unverified unit", () => {
    // `used_credits` and `monthly_limit` arrive in whatever unit upstream uses
    // and this deck cannot confirm whether that is currency or cents. A
    // percentage is true in any unit; a "$3.40" off an unverified scale is the
    // confidently wrong money figure this panel is careful not to produce.
    expect(panel).toMatch(/quota\.extraUsedCredits \/ quota\.extraMonthlyLimit/);
    expect(panel).toMatch(/Extra credits \(month/);
    // And no bar at all when there is no denominator to measure against.
    expect(panel).toMatch(/extra usage credits: on/);
  });
});
