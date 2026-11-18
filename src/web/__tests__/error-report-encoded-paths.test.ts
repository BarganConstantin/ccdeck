// A path written percent-encoded is still a path.
//
// A page report's stack carried the home folder of the machine it came from,
// encoded: Puppeteer (which chrome-devtools-mcp drives the browser with) names
// the code it evaluates `pptr:<function>;<call site>`, the call site run
// through encodeURIComponent, and V8 writes that name into every frame of it.
// No pattern of either scrub looks for `%2FUsers%2F`, so the frame went out
// whole. Both scrubs now read every run of escapes back first; a character a
// path pattern ends a path at (a space, a quote, …) stays escaped, so one path
// is still one word. Nothing else about the text changes: a `%` that starts no
// escape is a percent, and a run that is not UTF-8 stays as it was.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { scrub } from "../../server/reports.mjs";
import { scrubReport } from "../report-errors";

const HOME = "/Users/alice";
const ROOT = "/Users/alice/.npm/_npx/1a2b3c/node_modules/ccdeck";

// The frame the report carried, with a made-up user name in it.
const PPTR_FRAME =
  "    at pptr:evaluateHandle;performEvaluation%20(file%3A%2F%2F%2FUsers%2Falice%2F.npm%2F_npx%2Fba38acecdf97096f%2Fnode_modules%2Fchrome-devtools-mcp%2Fbuild%2Fsrc%2Ftools%2Fscript.js%3A182%3A69):1:294";

/** Both scrubs, by the name a failure message shows. */
const SCRUBS: [string, (text: string) => string][] = [
  ["the server's scrub", text => scrub(text, HOME, ROOT)],
  ["the page's scrub", scrubReport],
];

describe.each(SCRUBS)("%s", (_name, run) => {
  it("takes the home folder and the path out of a frame written percent-encoded", () => {
    const out = run(PPTR_FRAME);
    expect(out).not.toContain("alice");
    expect(out).not.toMatch(/%2F/i);
    expect(out).not.toContain("ba38acecdf97096f");
    // Still a frame: where the evaluated code was, and the line and column in it.
    expect(out).toBe("    at pptr:evaluateHandle;performEvaluation%20(<path>:182:69):1:294");
  });

  it("takes out an encoded path with no scheme in front, and an encoded email address", () => {
    expect(run("open %2FUsers%2Falice%2FMy%20Project%2Fx.js")).toBe("open ~/<path>");
    expect(run("EPERM C%3A%5CUsers%5CBob%20Smith%5CDesktop%5Cacme%5Cx.js")).toBe("EPERM ~\\<path>");
    expect(run("mail alice%40example.org")).toBe("mail <email>");
  });

  it("keeps a file:// URL with an escaped space in it one path", () => {
    // Read back, `Work%20Drive` would be two words, and the second would stay.
    expect(run("    at load (file:///Volumes/Work%20Drive/Acme%20Corp/plan.mjs:3:1)")).toBe("    at load (<path>:3:1)");
  });

  it("leaves a plain percent as it was", () => {
    for (const text of ["50% done", "100%", "disk 100% full, 3% left", "a 10%-off code"]) {
      expect(run(text), text).toBe(text);
    }
  });

  it("leaves a run that is not UTF-8 as it was, and does not throw on it", () => {
    expect(() => run("%E0%A4%A")).not.toThrow();
    expect(run("%E0%A4%A")).toBe("%E0%A4%A");
    expect(run("bad %FF%FE run")).toBe("bad %FF%FE run");
  });
});

describe("the server's scrub, reading a frame of the deck's own", () => {
  it("still finds the deck's package in a file:// URL whose escapes it read back", () => {
    // pathToFileURL writes `é` as `%C3%A9`; the text is read back before the
    // deck's own spellings are looked for, so they are read back the same way.
    const root = "C:\\Users\\José\\AppData\\Local\\Programs\\ccdeck\\resources\\deck";
    expect(scrub("    at f (file:///C:/Users/Jos%C3%A9/AppData/Local/Programs/ccdeck/resources/deck/src/server/tail.mjs:42:7)", "C:\\Users\\José", root))
      .toBe("    at f (ccdeck/src/server/tail.mjs:42:7)");
  });
});
