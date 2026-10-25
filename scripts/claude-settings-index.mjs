// Regenerate src/server/claude-settings-index.json, the read-only list of every
// key Claude Code documents (Settings › Claude Code › All settings), from its
// settings reference page.
//
//   node scripts/claude-settings-index.mjs            fetch the live page
//   node scripts/claude-settings-index.mjs page.md    read a saved copy
//   node scripts/claude-settings-index.mjs --check    fail when the committed
//                                                     file is older than the page
//
// Run before a release: Claude Code adds keys most weeks, and the list in the
// deck is only as current as the last run. What is kept is facts about each
// key and never the page's prose (claude-settings-docs.mjs says why).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSettingsReference } from "../src/server/claude-settings-docs.mjs";

const PAGE = "https://code.claude.com/docs/en/settings-reference.md";
const OUT = fileURLToPath(new URL("../src/server/claude-settings-index.json", import.meta.url));

const args = process.argv.slice(2);
const check = args.includes("--check");
const from = args.find(a => !a.startsWith("--"));

const markdown = from ? await readFile(from, "utf8") : await (async () => {
  const res = await fetch(PAGE);
  if (!res.ok) throw new Error(`${PAGE} answered ${res.status}`);
  return res.text();
})();
const { keys } = parseSettingsReference(markdown);
if (keys.length < 100) throw new Error(`Only ${keys.length} keys read from the page; its shape has probably changed. Nothing was written.`);

// One key a line, so a regeneration's diff reads as the keys that changed.
const json = `{\n  "source": ${JSON.stringify(PAGE)},\n  "keys": [\n${keys.map(k => `    ${JSON.stringify(k)}`).join(",\n")}\n  ]\n}\n`;
if (check) {
  const committed = await readFile(OUT, "utf8").catch(() => "");
  if (committed !== json) {
    const known = new Set(JSON.parse(committed || '{"keys":[]}').keys.map(k => k.key));
    const added = keys.filter(k => !known.has(k.key)).map(k => k.key);
    console.error(`claude-settings-index.json is out of date${added.length ? `; new keys: ${added.join(", ")}` : ""}. Run node scripts/claude-settings-index.mjs.`);
    process.exit(1);
  }
  console.log(`Checked ${keys.length} Claude Code settings.`);
} else {
  await writeFile(OUT, json);
  console.log(`Wrote ${keys.length} Claude Code settings to ${OUT}.`);
}
