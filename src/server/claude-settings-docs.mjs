// The keys Claude Code documents, read out of its settings reference page
// (https://code.claude.com/docs/en/settings-reference.md) — the source for
// claude-settings-index.json (scripts/claude-settings-index.mjs).
//
// THE PAGE IS READ, NOT TRUSTED. It is Markdown written for people, so every
// field is taken from one fixed shape — a `### \`key\`` heading, then its
// "Type" and "Default" bullets — and a key whose shape does not match keeps
// what could be read and nothing guessed. The settings index table at the top
// of the page names each key's topic, scope and anchor.
//
// FACTS, NOT THE PAGE'S WORDS. The reference is Anthropic's, all rights
// reserved, so what is kept is what a key is — its name, topic, scope, the
// kind of value it takes, its choices, a literal default, the version that
// added it — and never a sentence of its description. The deck links to the
// page for those (Settings › Claude Code).

const ENTRY_HEADING = /^### `([A-Za-z][\w.]*)`\s*$/gm;
const INDEX_ROW = /^\| \[`([^`]+)`\]\(#([^)]*)\) \| .*? \| ([^|]+?) \| ([^|]+?) \|$/gm;

/** The bullet `* **Name**: text` of an entry, as the page wrote it, or null. */
function bullet(body, name) {
  const m = new RegExp(`^\\* \\*\\*${name}\\*\\*: (.*)$`, "m").exec(body);
  return m ? m[1].trim() : null;
}

/** A Default bullet that is a value rather than a sentence: one code span,
 *  or the word "unset". Anything worded is left to the page. */
function literalDefault(text) {
  if (text === "unset") return "unset";
  const m = /^`([^`]{1,40})`$/.exec(text ?? "");
  return m ? m[1] : null;
}

/** What kind of value a Type bullet describes, in the deck's four words. */
function kindOf(type) {
  const t = (type ?? "").toLowerCase();
  if (t.startsWith("boolean")) return "boolean";
  if (t.startsWith("string, one of")) return "choice";
  if (t.startsWith("number") || t.startsWith("integer")) return "number";
  if (t.startsWith("string")) return "text";
  return "structured";
}

/** The quoted values listed under a "string, one of" Type bullet. */
function choices(body) {
  const at = body.search(/^\* \*\*Type\*\*: string, one of/m);
  if (at < 0) return [];
  const out = [];
  for (const line of body.slice(at).split("\n").slice(1)) {
    const m = /^ {2}\* `"([^"`]+)"`/.exec(line);
    if (m) out.push(m[1]);
    else if (!/^ {2,}/.test(line)) break;
  }
  return out;
}

/** The lowest "Requires Claude Code vX" an entry names, or null. */
function since(body) {
  const versions = [...body.matchAll(/[Rr]equires Claude Code v(\d+\.\d+\.\d+)/g)].map(m => m[1]);
  if (!versions.length) return null;
  return versions.sort((a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  })[0];
}

/** The page's anchor for a heading, as its own links spell it, for a key the
 *  index table does not link. */
export function anchorFor(key) {
  return key.toLowerCase().replace(/\./g, "-").replace(/[^a-z0-9-]+/g, "");
}

/**
 * Every documented key, in the page's order: its topic, scope and anchor from
 * the index table, and from its own entry the kind of value it holds, the
 * choices for a choice, a literal default, and the lowest Claude Code version
 * the entry names. Keys whose scope is "Global config" live in ~/.claude.json
 * and not in settings.json.
 */
export function parseSettingsReference(markdown) {
  const topics = new Map();
  for (const m of markdown.matchAll(INDEX_ROW)) topics.set(m[1], { anchor: m[2], topic: m[3].trim(), scope: m[4].trim() });
  const headings = [...markdown.matchAll(ENTRY_HEADING)];
  const keys = [];
  headings.forEach((m, i) => {
    const key = m[1];
    const end = i + 1 < headings.length ? headings[i + 1].index : markdown.length;
    let body = markdown.slice(m.index + m[0].length, end);
    const section = body.search(/^## /m);
    if (section >= 0) body = body.slice(0, section);
    const type = bullet(body, "Type");
    const row = topics.get(key);
    const options = choices(body);
    // "One of" a list of words rather than of fixed strings — a model name, a
    // duration — is a string to type, not a choice.
    const kind = kindOf(type) === "choice" && !options.length ? "text" : kindOf(type);
    keys.push({
      key,
      topic: row?.topic ?? null,
      scope: row?.scope ?? null,
      kind,
      ...(kind === "choice" ? { options } : {}),
      default: literalDefault(bullet(body, "Default")),
      since: since(body),
      anchor: row?.anchor ?? anchorFor(key),
    });
  });
  return { keys };
}
