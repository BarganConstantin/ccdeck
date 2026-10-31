// The JS terminal backend is a test's, never the product's: nothing the deck
// runs reaches it.
//
// The Command Panel is served only through the optional local engine
// (terminal-routes.mjs, terminal-socket.mjs). The JS backend that served it
// before — terminal-js-routes.mjs and the bridge, tmux client, target
// resolver, session launcher and tmux download behind it — stays as the
// parity oracle the engine is checked against, handed to startServer by a
// test as `terminal.jsBackend`. So the claim is about the graph: from
// bin/deck.js and src/server/index.mjs, by every way a module here reaches
// another, none of those files is reachable.
//
// "Every way" is over-approximated on purpose. A file is an edge of another
// if any string in its code — not its comments — names it: a static import
// or re-export, an `import()` of a literal, `join(PKG_ROOT, "src/server/…")`,
// a bare name in a list a loader joins to src/server (PINNED_MODULES). A
// string that names a file without loading it only makes more reachable,
// which can fail this test but never pass it wrongly. What it cannot follow
// is an import of a computed name, so every such import is listed below and
// any new one fails the test until it is.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const rel = (file: string) => relative(PKG_ROOT, file).split("\\").join("/");

/** The JS backend: off the product's path. */
const JS_BACKEND = [
  "src/server/terminal-js-routes.mjs",
  "src/server/terminal-bridge.mjs",
  "src/server/utf8-carry.mjs",
  "src/server/tmux-control.mjs",
  "src/server/terminal-target.mjs",
  "src/server/terminal-sessions.mjs",
  "src/server/tmux.mjs",
  "src/server/tmux-download.mjs",
];

/** The imports of a computed name the walk cannot follow, and what each loads:
 *  pinned-build's loop over PINNED_MODULES (followed as bare names), the
 *  CLI's `load(rel)`, whose callers pass literals (followed as strings), and
 *  quota-close-watch's `lazy(name)`, whose callers pass the bare names of
 *  quota modules (followed as bare names). */
const COMPUTED_IMPORTS = ["bin/cli/commands.js", "src/server/pinned-build.mjs", "src/server/quota-close-watch.mjs"];

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** The file a module-like string in `from` names, or null. */
function target(from: string, text: string): string | null {
  if (!/^[\w@./-]+\.(?:mjs|js|cjs)$/.test(text)) return null;
  const tries = text.startsWith(".") ? [resolve(dirname(from), text)] : [resolve(dirname(from), text), resolve(PKG_ROOT, text), resolve(PKG_ROOT, "src/server", text)];
  const hit = tries.find(p => p.startsWith(PKG_ROOT) && !p.includes("node_modules") && isFile(p));
  return hit ?? null;
}

/** Every file `file`'s code names, and whether it imports a computed name. */
function edges(file: string): { to: string[]; computed: boolean } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const to = new Set<string>();
  let computed = false;
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const hit = target(file, node.text);
      if (hit) to.add(hit);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // Followed only when a string in it names a file; `"node:fs"` loads none of ours.
      let named = false;
      const find = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) named ||= !!target(file, n.text) || n.text.startsWith("node:") || !/[./]/.test(n.text);
        else ts.forEachChild(n, find);
      };
      node.arguments.forEach(find);
      if (!named) computed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { to: [...to], computed };
}

/** Everything reachable from `roots`, and the files among them that import a computed name. */
function reach(roots: string[]): { files: Set<string>; computed: string[] } {
  const files = new Set<string>();
  const computed: string[] = [];
  const queue = roots.map(r => resolve(PKG_ROOT, r));
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    const e = edges(file);
    if (e.computed) computed.push(rel(file));
    queue.push(...e.to.filter(t => /\.(?:mjs|js|cjs)$/.test(t)));
  }
  return { files, computed: computed.sort() };
}

describe("the JS terminal backend, from what the deck runs", () => {
  const { files, computed } = reach(["bin/deck.js", "src/server/index.mjs"]);
  const reached = new Set([...files].map(rel));

  it("is unreachable: no file of it is named by anything bin/deck.js or index.mjs reaches", () => {
    expect(JS_BACKEND.filter(f => reached.has(f))).toEqual([]);
    for (const f of JS_BACKEND) expect(existsSync(join(PKG_ROOT, f)), `${f} is still there, for its tests`).toBe(true);
  });

  it("follows every way a module here reaches another (the control for the case above)", () => {
    // The panel's own routes and socket, and the relay to the engine: static.
    for (const f of ["src/server/terminal-routes.mjs", "src/server/terminal-socket.mjs", "src/server/pro-engine-terminal.mjs"]) expect(reached.has(f), f).toBe(true);
    // join(PKG_ROOT, "src/server/…") from bin/deck.js, and a dynamic import of one inside the server.
    expect(reached.has("src/server/deck-home.mjs")).toBe(true);
    expect(reached.has("src/server/claude-accounts.mjs")).toBe(true);
    // A bare name in PINNED_MODULES, reached by nothing else.
    expect(reached.has("src/server/radio-directory.mjs")).toBe(true);
    expect(reached.size).toBeGreaterThan(100);
  });

  it("knows every import of a computed name it cannot follow", () => {
    expect(computed).toEqual(COMPUTED_IMPORTS);
  });
});
