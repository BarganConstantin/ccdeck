// The diff's syntax tokenizer, off the page's main thread.
//
// A TextMate grammar's first use compiles its regular expressions as the rules
// are reached, and in the JavaScript engine one of those compiles can take a
// fifth of a second on a single line. On the page that would be a frame the
// reader feels; here it is a moment before the colours arrive, while the diff
// is already on screen in plain text.
//
// The page sends each grammar once (it imports them, so they split into
// chunks of their own) and then the text to colour; this answers spans per
// line, or null when anything fails, and the page keeps its plain text.
import { codeToTokensBase, createShikiPrimitiveAsync, type LanguageRegistration, type ShikiPrimitive } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { QUIET_THEME, tokensToSpans, type LineSpans } from "./git-syntax-theme";

type Message =
  | { t: "lang"; lang: string; grammars: LanguageRegistration[] }
  | { t: "tok"; id: number; lang: string; docs: string[] };

/** Lines longer than this are left plain past that point: a minified bundle
 *  in a diff is not worth a long tokenize. */
const MAX_LINE = 1000;

let shiki: Promise<ShikiPrimitive> | null = null;
const loaded = new Set<string>();
/** Messages run one at a time, in order, so a grammar is in before the text
 *  that needs it is tokenized. */
let queue: Promise<void> = Promise.resolve();

const primitive = () =>
  (shiki ??= createShikiPrimitiveAsync({ themes: [QUIET_THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));

async function handle(m: Message): Promise<void> {
  if (m.t === "lang") {
    if (loaded.has(m.lang)) return;
    await (await primitive()).loadLanguage(...m.grammars);
    loaded.add(m.lang);
    return;
  }
  let spans: LineSpans[][] | null = null;
  try {
    const p = await primitive();
    if (loaded.has(m.lang)) {
      spans = m.docs.map(doc => tokensToSpans(codeToTokensBase(p, doc, { lang: m.lang, theme: QUIET_THEME.name, tokenizeMaxLineLength: MAX_LINE })));
    }
  } catch {
    spans = null;
  }
  postMessage({ t: "tok", id: m.id, spans });
}

self.onmessage = (e: MessageEvent<Message>) => {
  const m = e.data;
  queue = queue.then(() => handle(m)).catch(() => {
    if (m.t === "tok") postMessage({ t: "tok", id: m.id, spans: null });
  });
};
