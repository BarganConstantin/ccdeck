// A reaction that could not act has to say so.
//
// THIS REPORTED ONLY ITS SUCCESSES, and the cost was two months of silence. An
// episode's `browser` was null the whole time, `appName(null)` is null, and both
// destructive reactions returned `unknown_browser` and pushed nothing onto the
// list the log is built from — so the panel said a finding had been handled and
// nothing had been. Nobody could have noticed from the screen.
//
// The failures that remain are ordinary and will happen. macOS asks once for
// permission to control another application and refuses forever if declined; a
// tab can be closed by hand before the poll reaches it; a browser can quit on
// its own. Each of those has to be visible, because the alternative is a reader
// believing a tab was closed that is still open.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { react } from "../../server/browser-react.mjs";

const episode = {
  host: "example.invalid",
  browser: "brave",
  count: 1,
  startMs: 1_000_000,
  endMs: 1_000_000,
  urls: [{ url: "https://example.invalid/x", timeMs: 1_000_000 }],
};

/** `run` stubbed to fail every command, which is what a refused automation
 *  permission looks like from here. */
const allFail = { run: async () => ({ ok: false, stdout: "", stderr: "not authorised" }) };
/** And one where osascript succeeds but the script reports it found no tab. */
const noSuchTab = { run: async () => ({ ok: true, stdout: "missing", stderr: "" }) };

describe("a reaction that could not act", () => {
  it("says the tab was not closed, and why", async () => {
    const done = await react("close-tab", episode, { platform: "darwin", deps: allFail });
    expect(done.some(l => /could not close https:\/\/example\.invalid\/x/.test(l))).toBe(true);
    expect(done.some(l => /script_failed/.test(l))).toBe(true);
  });

  it("distinguishes a script that ran and found nothing from one that failed", async () => {
    // Different problems with different answers: one means the automation is
    // blocked, the other means the tab was already gone. A single "could not"
    // would flatten them.
    const done = await react("close-tab", episode, { platform: "darwin", deps: noSuchTab });
    expect(done.some(l => /could not close .* — missing/.test(l))).toBe(true);
  });

  it("says the browser was not quit, and why", async () => {
    const done = await react("quit-browser", episode, { platform: "darwin", deps: allFail });
    expect(done.some(l => /could not quit the browser/.test(l))).toBe(true);
  });

  it("reports an untagged episode rather than doing nothing quietly", async () => {
    // THE EXACT SHAPE OF THE TWO-MONTH BUG. `browser: null` reaches
    // `appName(null)`, which is null, so the reaction cannot name an
    // application — and used to return an empty list.
    const done = await react("close-tab", { ...episode, browser: null }, {
      platform: "darwin", deps: allFail,
    });
    expect(done.some(l => /unknown_browser/.test(l))).toBe(true);
  });

  it("still says when it worked, in the same list", async () => {
    const ok = { run: async () => ({ ok: true, stdout: "closed", stderr: "" }) };
    const done = await react("close-tab", episode, { platform: "darwin", deps: ok });
    expect(done).toContain("closed https://example.invalid/x");
    expect(done.some(l => /could not/.test(l))).toBe(false);
  });

  it("says when the notification itself did not go out", async () => {
    // The one reaction available on every platform, and it can fail too.
    const done = await react("notify", episode, { platform: "darwin", deps: allFail });
    expect(done).toContain("could not notify");
  });
});

describe("how the snapshot logs what a reaction did", () => {
  const server = readFileSync(
    fileURLToPath(new URL("../../server/browser-watch.mjs", import.meta.url)), "utf8");

  it("does not swallow a thrown reaction", () => {
    // `catch(() => [])` turned a reaction that blew up into one that had never
    // been asked for, and the feed then said nothing at all about a finding the
    // panel had promised to act on.
    // Scoped to the react call: `browserSurvey(...).catch(() => [])` a few
    // hundred lines up is a different question, and an empty survey is a fine
    // answer to it.
    const at = server.indexOf("deps.react ?? react");
    expect(at, "the react call has moved and this no longer reads it").toBeGreaterThan(0);
    const site = server.slice(at, at + 400);
    expect(site, "a throw is being swallowed again").not.toMatch(/\.catch\(\(\) => \[\]\)/);
    expect(site).toMatch(/catch\(err => \[`reaction failed/);
  });

  it("files a failure under warn rather than under find", () => {
    // `find` is the level for something happening. The deck being unable to do
    // what it said it would is the other thing, and the panel colours them
    // differently for the reader.
    expect(server).toMatch(/\/\^\(could not\|reaction failed\)\/\.test\(line\) \? "warn" : "find"/);
  });
});
