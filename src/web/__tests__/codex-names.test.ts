import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexNameReader, CODEX_NAMES_BYTES } from "../../server/codex-names.mjs";

const roots: string[] = [];
const id = "01234567-1234-4234-8234-123456789abc";
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ccdeck-codex-names-")); roots.push(home);
  return { home, file: join(home, "session_index.jsonl"), read: createCodexNameReader() };
}
const row = (name: string) => JSON.stringify({ id, thread_name: name }) + "\n";

it("follows a Codex rename even when no rollout is appended", async () => {
  const { home, file, read } = await fixture();
  await writeFile(file, row("Initial title"));
  expect((await read(home, 0)).get(id)).toBe("Initial title");
  await appendFile(file, row("Verifică proiectele de pe desktop"));
  expect((await read(home, 1500)).get(id)).toBe("Verifică proiectele de pe desktop");
});

it("ignores incomplete and malformed records instead of guessing a title", async () => {
  const { home, file, read } = await fixture();
  await writeFile(file, row("Valid") + "broken\n" + row("bad\u0000title") + JSON.stringify({ id, thread_name: "Not complete" }));
  expect((await read(home, 0)).get(id)).toBe("Valid");
  await appendFile(file, "\n");
  expect((await read(home, 1500)).get(id)).toBe("Not complete");
});

it("bounds history reads and refreshes after index replacement", async () => {
  const { home, file, read } = await fixture();
  await writeFile(file, "x".repeat(CODEX_NAMES_BYTES + 50) + "\n" + row("Latest"));
  expect((await read(home, 0)).get(id)).toBe("Latest");
  await writeFile(file, row("Replacement"));
  expect((await read(home, 1500)).get(id)).toBe("Replacement");
});
