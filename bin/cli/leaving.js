// The one question `ccdeck --uninstall` asks, and only of a person at a
// terminal: why are they leaving. Skippable with Enter, given up after half a
// minute, and never asked at all when reports are off — the answer would have
// nowhere to go. The answer is one of a short fixed list (UNINSTALL_REASONS in
// reports.mjs), so nothing typed ever leaves.
import { createInterface } from "node:readline/promises";
import { PRODUCT } from "../../src/server/brand.mjs";

/** The answers, in the order they are offered, with the words they are shown in. */
export const REASONS = Object.freeze([
  ["not-useful", "It wasn't useful to me"],
  ["too-noisy", "Too noisy or distracting"],
  ["broken", "Something didn't work"],
  ["other-tool", "I use something else"],
  ["privacy", "Privacy"],
  ["other", "Another reason"],
]);

/** Ask, and answer with a reason's token or null — for a skip, a timeout, an
 *  answer that is not on the list, or no terminal to ask on. Never throws. */
export async function askWhy({ input = process.stdin, output = process.stdout, timeoutMs = 30_000 } = {}) {
  if (!input?.isTTY || !output?.isTTY) return null;
  let rl;
  try {
    output.write(`\n${PRODUCT}: one question before you go, and you can skip it: why are you uninstalling?\n`);
    REASONS.forEach(([, label], i) => output.write(`  ${i + 1}  ${label}\n`));
    rl = createInterface({ input, output });
    const answer = await rl.question("Number, or Enter to skip: ", { signal: AbortSignal.timeout(timeoutMs) });
    const n = Number.parseInt(String(answer).trim(), 10);
    return REASONS[n - 1]?.[0] ?? null;
  } catch {
    return null;
  } finally {
    rl?.close();
  }
}

/**
 * Say the install is leaving, with the reason if one is given. Only when a
 * report would go out anyway: reports off, or the machine vetoing them, means
 * no question and nothing sent. `reporter` and `ask` are parameters so the
 * suite runs this without a network or a terminal.
 */
export async function sayGoodbye({ reporter, ask = askWhy, out = line => console.log(line) } = {}) {
  try {
    if (!reporter || !(await reporter.willReport())) return false;
    const reason = await ask();
    const sent = await reporter.reportUninstall(reason);
    if (sent && reason) out(`${PRODUCT}: thank you, that helps.`);
    return sent;
  } catch {
    return false;
  }
}
