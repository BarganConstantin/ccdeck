// What the README's first screen spends itself on (#440), and where the hero
// image lives (#439).
//
// The prose was never the problem. `--workspace` explaining that every matching
// deck draws the session while the log still gets one copy, the WARNING on share
// blobs, the note that a restart is refused under --no-persist because there is
// nothing to replay — that is the writing of someone who has hit these cases,
// and none of it is deletable. What was wrong was the order: the two paragraphs
// that disclose what the deck writes and what leaves the machine sat in the two
// highest-value slots on the page — the second paragraph of "Why", and the line
// directly under `npx ccdeck` — where a reader who has not yet decided they want
// the tool met "it rewrites my auth file" and 109 words on 20-byte GETs before
// they had run anything. Both are now under "What it touches", where a reader
// who HAS decided goes looking, and both moved verbatim.
//
// So the regression this file guards is deletion and re-inlining, in both
// directions. A future tidy-up that drops either passage silently removes the
// only place the deck admits what it writes; one that pastes either back into
// "Why" or "Quick start" puts the objection back in front of the desire. The
// passages are therefore asserted word for word AND asserted to appear exactly
// once, since a copy left behind reads as an accident on a page this careful.
//
// The hero is asserted by location only. The shot itself still shows the
// pre-rename wordmark, which no test can see and no edit to this repo can fix —
// it needs re-taking on a current build. What CAN be pinned is that the file
// exists, that it is not embedded from the repo root under a screenshot tool's
// timestamped filename, and that it is reachable at full size, because GitHub
// renders it at roughly half scale. The caption that currently explains the old
// wordmark is deliberately NOT pinned: it has to go the day the shot is
// replaced, and a test holding it in place would be pinning a lie.
//
// PLAIN NODE. The READMEs are read as text; nothing here imports a module that
// touches the filesystem on its own.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");
const readme = read("README.md");

/** Where a heading starts. Headings are matched at line start so a mention of
 *  a section's name inside a paragraph is not mistaken for it.
 *
 *  A heading that is not there is a failure naming the heading, never a -1
 *  handed back to the caller (#628). Every ordering check below is an
 *  inequality, and -1 is smaller than every real offset, so a missing heading
 *  satisfied whichever comparison it was on the wrong side of: `toBeLessThan`
 *  passed when the LEFT heading was gone, `toBeGreaterThan` when the RIGHT one
 *  was. Renaming `## Why` to `## Why ccdeck?` — a section left exactly where it
 *  is — turned "answers what it is and what it does before how to run it" into
 *  a case that compared nothing and stayed green however far that section then
 *  moved. #461 is a plan to restructure this page, and a heading rename is the
 *  single most likely edit in that work, so the miss is caught once here rather
 *  than at fifteen call sites where the next assertion added would forget it.
 *  A heading genuinely meant to be optional wants its own helper, not this one. */
const at = (heading: string) => {
  const i = readme.indexOf(`\n${heading}\n`);
  expect(i, `README.md has no heading "${heading}" — the assertion using it would be comparing against -1`).toBeGreaterThan(-1);
  return i;
};

/** How many times a passage appears — the check that a move was a move. */
const times = (needle: string) => readme.split(needle).length - 1;

/** The two paragraphs, exactly as they read before they were moved. */
const WRITES =
  "It never steers an agent or edits your code, but it is not read-only either — besides the hook entry and its own event log, it manages the two tools it leans on, and it refreshes the Codex token it reads quota with, rewriting `~/.codex/auth.json` the way `codex` itself does.";
const NETWORK =
  "What does go out is short and ordinary: a ~20-byte version check against the npm registry";

describe("the disclosures the README must keep, and keep in one place", () => {
  it("gives them a section of their own", () => {
    // The lookup is the assertion: at() fails, naming the heading, when the
    // section is renamed or gone. This used to spell the `.toBeGreaterThan(-1)`
    // out — it was the one heading of ten that was guarded, and the guard now
    // covers every call site in the file instead of just this one.
    at("## What it touches");
  });

  it("still says, word for word, what the deck writes", () => {
    expect(readme).toContain(WRITES);
    expect(times(WRITES)).toBe(1);
  });

  it("still says, word for word, what leaves the machine", () => {
    expect(readme).toContain(NETWORK);
    expect(readme).toContain("`AGENTS_DECK_NO_INSTALL=1` turns off everything but the quota reads");
    expect(readme).toContain("no `uv` binary is fetched, the managed installs stay");
    expect(times(NETWORK)).toBe(1);
  });

  it("keeps both of them out of the two slots they used to occupy", () => {
    // The section a passage lands in is the whole point of the move, so the
    // test asks where it is rather than only that it exists somewhere.
    const touches = at("## What it touches");
    expect(readme.indexOf(WRITES)).toBeGreaterThan(touches);
    expect(readme.indexOf(NETWORK)).toBeGreaterThan(touches);
  });

  it("leaves the three-beat line under the install command, and a way through to the rest", () => {
    // "No config file. No account. No telemetry." is the one claim on the page
    // most tools in this category cannot honestly make. Moving the detail out
    // from under it is only an improvement while the line itself stays put.
    const quick = at("## Quick start");
    const three = readme.indexOf("No config file. No account. No telemetry —");
    expect(three).toBeGreaterThan(quick);
    expect(three).toBeLessThan(at("## Requirements"));
    expect(readme).toContain("[What it touches](#what-it-touches)");
  });
});

describe("the order a first-time reader meets the page in", () => {
  it("answers what it is and what it does before how to run it", () => {
    expect(at("## Why")).toBeLessThan(at("## What you get"));
    expect(at("## What you get")).toBeLessThan(at("## Quick start"));
  });

  it("answers whether it runs here right after telling them to run it", () => {
    // The platform badge links to #requirements, which is a mitigation for a
    // section that used to be eleventh of twelve — badges get scanned, not
    // clicked, and "do I need Node, does this work on Windows" is a question a
    // stranger has before they have any reason to hunt for the answer.
    expect(readme).toContain("](#requirements)");
    expect(at("## Requirements")).toBeGreaterThan(at("## Quick start"));
    expect(at("## Requirements")).toBeLessThan(at("## How it works"));
  });

  it("puts the disclosures after the mechanism they disclose", () => {
    expect(at("## What it touches")).toBeGreaterThan(at("## How it works"));
  });

  it("leaves the post-install sections below the ones a converting reader wants", () => {
    // ## Updating and ### Restarting are 415 words answering a question only an
    // existing user has ever asked, and they used to sit above ## Options.
    expect(at("## Options")).toBeLessThan(at("## Updating"));
    expect(at("## Uninstall")).toBeLessThan(at("## Updating"));
    expect(at("### Restarting")).toBeGreaterThan(at("## Updating"));
  });

  it("carries the positioning line where a stranger reads it", () => {
    // "One canvas. No tabs. No kanban." is not a design note. Two of the tools
    // in this category advertise exactly those, one as tabs for multi-session
    // and one as a Kanban board. It used to be below Uninstall.
    const line = readme.indexOf("One canvas. No tabs. No kanban.");
    expect(line).toBeGreaterThan(at("## What you get"));
    expect(line).toBeLessThan(at("## Quick start"));
  });

  it("leads the feature table with the rows no competitor claims", () => {
    const table = readme.slice(at("## What you get"), at("## Quick start"));
    const rows = table.split("\n").filter(l => l.startsWith("| **"));
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toContain("**Blocked on you**");
    expect(rows[1]).toContain("**Cost and quota, live**");
  });
});

describe("the first two lines, which are the whole first impression (#461)", () => {
  /** Everything above the badges — the h1 and whatever states the case. */
  const hero = readme.slice(0, readme.indexOf("[![npm]"));

  it("states the problem before it names the tool", () => {
    // The page used to open on "A live canvas for your AI agents", which is a
    // category. A category tells a reader which shelf this sits on and leaves
    // them to work out whether they are standing at it; the problem does the
    // deciding for them. Both offsets are asserted so a deleted line fails here
    // rather than passing an inequality against -1.
    const problem = hero.indexOf("An agent session is a tree. Your terminal shows it as a scroll.");
    const answer = hero.indexOf("**ccdeck draws the tree**");
    expect(problem, "the README no longer opens by stating the problem").toBeGreaterThan(-1);
    expect(answer, "the README no longer answers the problem it opens with").toBeGreaterThan(-1);
    expect(problem).toBeLessThan(answer);
  });

  it("keeps the answer above the fold, not below the install command", () => {
    // Badges and `npx ccdeck` are what a scanner's eye lands on next. The two
    // lines only do their job while they are still the first thing read.
    expect(hero).toContain("**ccdeck draws the tree**");
  });

  it("does not let the scan line promise subagents to a Codex user", () => {
    // The noun list under the hero is read as a feature list with no provider
    // attached to any entry, which is exactly where an unqualified "subagents"
    // becomes the claim `codex-copy.test.ts` refuses: codexObjToPayload emits
    // no SubagentStart, so a Codex session is a root and its tools. The word
    // belongs in the tagline, where it can name the CLI, and nowhere that reads
    // as spanning both.
    // Found by what it says, not by the word it happens to start with: an
    // anchored prefix would stop matching the moment a noun is prepended, which
    // is the exact edit this case exists to catch, and it would then fail
    // naming a missing line instead of the claim that was added.
    const heroBlock = readme.slice(0, readme.indexOf("</div>"));
    const scan = heroBlock.split("\n").map(l => l.trim())
      .find(l => l.includes(" · ") && l.includes("no telemetry") && !l.startsWith("["));
    expect(scan, "the README no longer carries the noun line under the hero image").toBeTruthy();
    expect(scan).not.toMatch(/subagent/i);
    // The claims it does make are each answered by a row in the table below.
    for (const noun of ["cost", "quota", "blocked on you", "no telemetry"]) {
      expect(scan).toContain(noun);
    }
  });
});

describe("the hero image", () => {
  /** Every path the README embeds, in order. */
  const embedded = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map(m => m[1])
    .filter(p => !/^https?:/.test(p));

  it("is one local file, and it is there", () => {
    expect(embedded).toHaveLength(1);
    expect(existsSync(join(repo, embedded[0]))).toBe(true);
  });

  it("is not a screenshot tool's filename sitting in the repo root", () => {
    // 13 entries in the root, sorted with directories first: a file named
    // image_<date>_<time>.png lands in a visitor's first field of view, above
    // the rendered README, on a repo whose whole pitch is care.
    expect(embedded[0]).toBe("assets/canvas.png");
    expect(embedded[0]).not.toMatch(/^image_/);
  });

  it("is reachable at full size, because GitHub renders it at about half scale", () => {
    // The old shot was 1917 logical px in a ~890px column and its labels were a
    // smear. The replacement is framed at 1600 and shot at 2x, so the same
    // column shows the same content about 20% larger; the link stays for the
    // reader who wants the pixels.
    expect(readme).toContain(`[![`);
    expect(readme).toContain(`](${embedded[0]})](${embedded[0]})`);
  });

  it("no longer apologises for itself", () => {
    // The caption used to say the shot predated the rename. That sentence was
    // honest and correct, and a caption admitting the page's only evidence is
    // out of date is a thing a visitor reads before they read anything else.
    // It came out with the shot it described, and this is what keeps it out.
    expect(readme).not.toMatch(/older shot/i);
    expect(readme).not.toMatch(/still called `agents-deck`/);
  });

  it("was not shot against somebody's real work", () => {
    // The reason it was replaced (#441). The previous canvas showed client
    // project names, source file names and a spend figure, on the front page of
    // a public repo, in the one image a reader is invited to open full size.
    // The generator is committed so the shot can be retaken without waiting for
    // something photogenic to happen in real work.
    const gen = join(repo, "assets", "canvas-demo.mjs");
    expect(existsSync(gen), "assets/canvas-demo.mjs is gone — the hero can no longer be retaken from generated data").toBe(true);
    const src = readFileSync(gen, "utf8");
    // The two commands that turn it back into the picture.
    expect(src).toContain("--history");
    expect(src).toContain("--workspace");
    // And the warning that matters, because the panel is open by default.
    expect(src).toMatch(/accounts panel CLOSED/i);
    expect(readme).toContain("assets/canvas-demo.mjs");
  });
});

describe("the social preview card (#441)", () => {
  // Not embedded anywhere — GitHub reads it from Settings, not from the page —
  // so nothing else in this repo would notice it going missing, being replaced
  // by a screenshot at whatever size the screen happened to be, or growing past
  // the 1 MB the upload form refuses. It is checked here because this is the
  // file that already owns "what a stranger sees first", and the card is the
  // half of that a reader meets before they ever reach the README.
  const card = join(repo, "assets", "social-preview.png");

  /** width/height out of the IHDR, which is always the first chunk. */
  const png = () => {
    const b = readFileSync(card);
    expect(b.subarray(1, 4).toString("latin1"), "assets/social-preview.png is not a PNG").toBe("PNG");
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  };

  it("is there, and is the size GitHub asks for", () => {
    expect(existsSync(card), "assets/social-preview.png is gone — every shared link renders the grey default card").toBe(true);
    const { w, h } = png();
    expect({ w, h }).toEqual({ w: 1280, h: 640 });
  });

  it("stays under the 1 MB the upload form accepts", () => {
    // Headroom rather than the limit itself: a card re-rendered with more detail
    // should fail here, where the message says why, and not in a browser upload
    // dialog months later.
    expect(png().bytes).toBeLessThan(700_000);
  });

  it("keeps the source it was rendered from, so it can be re-rendered", () => {
    // An asset whose source is lost is an asset that can never be corrected —
    // the wordmark shot in assets/canvas.png is exactly that, and is why the
    // README still carries a caption apologising for a stale screenshot.
    const html = join(repo, "assets", "social-preview.html");
    expect(existsSync(html), "assets/social-preview.html is gone — the card can no longer be re-rendered").toBe(true);
    const src = readFileSync(html, "utf8");
    expect(src).toContain("width:1280px;height:640px");
    // The claims on the card are the README's, and drift between them is the
    // failure this catches: a card promising something the page does not.
    expect(src).toContain("An agent session is a tree.");
    expect(src).toContain("npx ccdeck");
    expect(src).not.toMatch(/subagents ·/);
  });
});

describe("the two npm badges, which name two different packages", () => {
  it("says which package the download count belongs to", () => {
    // Deliberate — one tarball goes out under three names and the counts are
    // per name — but `npm/v/ccdeck` beside an unlabelled `npm/dm/agents-deck`,
    // under an h1 that says ccdeck, reads as a copy-paste slip. Labelling it is
    // the honest fix; calling it "all names" would be a new false string, since
    // the badge counts one of the three.
    expect(readme).toContain("npm/dm/agents-deck");
    expect(readme).toContain("label=agents-deck%20downloads");
  });
});

// The stub package's own README used to be the ccdeck npm page, and had its own
// two cases here: no embedded image, no disclosure paragraph. #340 removed the
// stub — ccdeck is now this tarball republished under a third name — so the
// ccdeck page renders THIS README, hero and disclosure and all, and every case
// above applies to it. Nothing was dropped; one of the two pages stopped
// existing and the other one already had the coverage.
