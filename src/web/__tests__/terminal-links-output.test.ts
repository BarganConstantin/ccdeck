// Which URL a Ctrl+click on the pane's output opens, through the web-links
// addon the stage loads (use-terminal-session.ts) and the stage's own rule
// (terminal-links.ts) with its URL rule: the whole address with its query and
// fragment, without the punctuation around it in any of the deck's languages,
// the same from either row of one that wrapped, and one tab per press. The addon runs here on xterm.js's headless build, which
// has the same buffer the browser's has; only the hover and the click itself
// need a browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { URL_IN_OUTPUT, openLink } from "../terminal-links";
// @ts-expect-error — plain .mjs test kit, no types
import * as kit from "./utf8-frames-kit.mjs";

const X = kit.headlessXterm();

interface Link { text: string; range: { start: { x: number; y: number }; end: { x: number; y: number } }; activate(e: MouseEvent, text: string): void }
interface Provider { provideLinks(y: number, cb: (links: Link[] | undefined) => void): void }

afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

/** The output written to a headless xterm of `cols` columns, with the stage's
 *  link handler behind the addon, and the links the addon finds on a row. */
async function pane(output: string, cols = 80, urlRegex: RegExp | undefined = URL_IN_OUTPUT) {
  const term = new X.Terminal({ cols, rows: 12, allowProposedApi: true });
  await new Promise<void>(done => term.write(output, done));
  let provider: Provider | null = null;
  // The headless build has no link providers: the addon is handed the buffer
  // and keeps the provider it registers.
  const host = { get buffer() { return term.buffer; }, registerLinkProvider(p: Provider) { provider = p; return { dispose() {} }; } };
  const opened: string[] = [];
  (globalThis as Record<string, unknown>).window = { open: vi.fn((url: string) => { opened.push(url); }) };
  const addon = new WebLinksAddon((e, uri) => { openLink(e, uri, { apple: false }); }, { urlRegex });
  addon.activate(host as never);
  const linksOn = (row: number) => {
    let found: Link[] = [];
    provider!.provideLinks(row, links => { found = links ?? []; });
    return found;
  };
  /** A press on the first link on `row`, as xterm's linkifier makes it. */
  const press = (row: number, mods: { ctrlKey?: boolean } = { ctrlKey: true }) => {
    const [link] = linksOn(row);
    const e = { button: 0, ctrlKey: false, metaKey: false, ...mods } as MouseEvent;
    link?.activate(e, link.text);
    return link;
  };
  return { linksOn, press, opened, term };
}

describe("a URL in the pane's output", () => {
  it("opens whole, with its query and fragment, on Ctrl+click and once", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const mr = "https://gitlab.example.com/group/sub/project/-/merge_requests/1234?tab=diffs&commit_id=a1b2#note_987";
    const p = await pane(`Merge request: ${mr}\r\n`);
    expect(p.linksOn(1).map(l => l.text)).toEqual([mr]);
    p.press(1);
    expect(p.opened).toEqual([mr]);
  });

  it("opens nothing on a plain click", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const p = await pane("See https://example.com/a for more\r\n");
    p.press(1, { ctrlKey: false });
    expect(p.opened).toEqual([]);
  });

  it("leaves out the punctuation around it", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const cases: [string, string][] = [
      ["Opened https://gitlab.example.com/g/p/-/merge_requests/7.", "https://gitlab.example.com/g/p/-/merge_requests/7"],
      ["(see https://example.com/docs?x=1#top)", "https://example.com/docs?x=1#top"],
      ["Links: https://example.com/a, https://example.com/b;", "https://example.com/a"],
      ["“https://example.com/quoted”!", "https://example.com/quoted"],
      ["<https://example.com/angle>", "https://example.com/angle"],
      ["Done: https://example.com/q?", "https://example.com/q"],
      ["请查看 https://gitlab.example.com/g/p/-/merge_requests/7。", "https://gitlab.example.com/g/p/-/merge_requests/7"],
      ["（https://example.com/zh?a=1）", "https://example.com/zh?a=1"],
      ["「https://example.com/ja#x」を開く", "https://example.com/ja#x"],
      ["« https://example.com/fr »", "https://example.com/fr"],
      ["„https://example.com/de“", "https://example.com/de"],
      ["‘https://example.com/single’", "https://example.com/single"],
    ];
    for (const [line, url] of cases) {
      const p = await pane(`${line}\r\n`);
      p.press(1);
      expect(p.opened, line).toEqual([url]);
    }
  });

  it("finds what the addon's own rule finds wherever the text is ASCII, and keeps letters past ASCII", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const lines = [
      "Opened https://gitlab.example.com/g/p/-/merge_requests/7.",
      "(see https://example.com/docs?x=1#top) and http://localhost:5173/a/b?c=d&e=f, too",
      "https://[::1]:8080/x https://user@example.com/~me/ https://example.com/a+b=c%20d;",
    ];
    for (const line of lines) {
      const ours = (await pane(`${line}\r\n`)).linksOn(1).map(l => l.text);
      const addons = (await pane(`${line}\r\n`, 80, undefined)).linksOn(1).map(l => l.text);
      expect(ours, line).toEqual(addons);
      expect(ours.length, line).toBeGreaterThan(0);
    }
    const p = await pane("https://de.wikipedia.org/wiki/Straße ok\r\n");
    expect(p.linksOn(1).map(l => l.text)).toEqual(["https://de.wikipedia.org/wiki/Straße"]);
    p.press(1);
    expect(p.opened).toEqual(["https://de.wikipedia.org/wiki/Stra%C3%9Fe"]);
  });

  it("opens the same whole address from either row of one that wrapped", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const url = "https://gitlab.example.com/a-long-group/a-long-project/-/merge_requests/98765?tab=pipelines#L12";
    expect(url.length).toBeGreaterThan(40);
    const p = await pane(`MR ${url} ok\r\n`, 40);
    // Three rows, wrapped by the terminal itself.
    expect(p.term.buffer.active.getLine(1)?.isWrapped).toBe(true);
    for (const row of [1, 2, 3]) {
      const [link] = p.linksOn(row);
      expect(link?.text, `row ${row}`).toBe(url);
      expect(link?.range.start.y).toBe(1);
      expect(link?.range.end.y).toBe(3);
    }
    p.press(2);
    p.press(3);
    expect(p.opened, "one tab per press, each the whole address").toEqual([url, url]);
  });

  it("finds nothing that is not http or https", async () => {
    if (!kit.needed("@xterm/headless", X)) return;
    const p = await pane("file:///etc/passwd ftp://example.com/x javascript:alert(1)\r\n");
    expect(p.linksOn(1)).toEqual([]);
  });
});
