// The Windows toast has to ask for a template that has room for what it writes.
//
// This is a regression test for a bug that shipped and could never have worked:
// `GetTemplateContent(0)` is ToastImageAndText01, which has ONE text node, and
// the script fills two. `$n.Item(1)` threw "Specified argument was out of the
// range of valid values" on every Windows machine, the `.catch(() => null)`
// turned that into a null, and `notify()` returned false. The Browser Watch
// reaction that depends on it has therefore never once raised a notification on
// Windows, and nothing said so — `available()` still offers "notify" there,
// because the platform genuinely does support toasts.
//
// Measured on Windows 10 19045, enumerating the stock templates:
//
//   0 ToastImageAndText01   1 text node    <- what shipped
//   4 ToastText01           1 text node
//   5 ToastText02           2 text nodes   <- title + body, no image slot
//   6 ToastText03           2 text nodes
//   3 ToastImageAndText04   3 text nodes
//   7 ToastText04           3 text nodes
//
// and then, in the logged-on user's own session via `schtasks /IT` rather than
// over SSH: template 0 FAILED, template 5 SHOWN.
//
// THE SSH PART MATTERS FOR WHOEVER RE-RUNS THIS. Every process started over SSH
// on Windows lands in session 0, which has no desktop, so `CreateToastNotifier`
// there fails with "The notification platform is unavailable" no matter which
// template it was handed — including the correct one. A check run over SSH
// cannot tell a fixed toast from a broken one, which is why the proof had to be
// pushed into the interactive session.
//
// A unit test cannot raise a toast, so this pins the one thing a unit test can:
// that the script asks for a template whose text-node count matches the number
// of nodes it fills. That is exactly the invariant that was violated.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../../server/browser-react.mjs", import.meta.url)),
  "utf8",
);

/** Text nodes in each stock ToastTemplateType, read off Windows itself rather
 *  than off the documentation. */
const TEXT_NODES: Record<string, number> = {
  "0": 1, "1": 2, "2": 2, "3": 3, "4": 1, "5": 2, "6": 2, "7": 3,
};

describe("the Windows toast script", () => {
  it("asks for a template with room for both lines it writes", () => {
    const asked = src.match(/GetTemplateContent\((\d+)\)/);
    expect(asked, "the toast script no longer calls GetTemplateContent").not.toBeNull();
    const index = asked![1];

    // Every `$n.Item(N)` the script fills. The highest N it touches has to be
    // inside the template it asked for, or the call throws at runtime and the
    // notification silently never happens.
    const filled = [...src.matchAll(/\$n\.Item\((\d+)\)/g)].map(m => Number(m[1]));
    expect(filled.length, "the toast script no longer fills any text node").toBeGreaterThan(0);

    const need = Math.max(...filled) + 1;
    const have = TEXT_NODES[index];
    expect(have, `GetTemplateContent(${index}) is not a stock template index`).toBeDefined();
    expect(have).toBeGreaterThanOrEqual(need);
  });

  it("still writes a title and a body, so the template choice stays load-bearing", () => {
    // If somebody reduces this to one line, the assertion above would pass with
    // template 0 again and the comment explaining why 5 was chosen would rot
    // into a lie. This is what makes the pair meaningful.
    const filled = [...src.matchAll(/\$n\.Item\((\d+)\)/g)].map(m => Number(m[1]));
    expect(filled).toContain(0);
    expect(filled).toContain(1);
  });

  it("keeps both strings out of the script source", () => {
    // Unrelated to the template, and the reason it is guarded here is that the
    // fix touched this exact string. The title and body reach PowerShell through
    // the environment, never interpolated into the command — the discipline the
    // rest of this file keeps because `body` can carry a hostname somebody else
    // put in the browser's history.
    expect(src).toContain("$env:CCDECK_TOAST_TITLE");
    expect(src).toContain("$env:CCDECK_TOAST_BODY");
  });
});
