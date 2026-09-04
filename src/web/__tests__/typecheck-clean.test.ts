// The app type-checks, and something has to run the check.
//
// `tsconfig.json` has carried `"strict": true` since the beginning and nothing
// in the repo ever ran `tsc` — no script, no CI step — so the setting was
// decorative and `typescript` was a devDependency nothing invoked. The one time
// it was run by hand it reported 2,638 errors, of which five were outside the
// suite: four in vite.config.ts's own `node:` imports and one for `dagre`. Both
// were missing type packages rather than defects.
//
// This file pins the arrangement rather than re-running the compiler: `tsc` on
// this tree takes several seconds, and vitest already spends its budget on
// behaviour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const pkg = JSON.parse(read("../../../package.json")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("the typecheck exists and is runnable", () => {
  it("has a script, pointed at the build project", () => {
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit -p tsconfig.build.json");
  });

  it("has the type packages the app's own imports need", () => {
    // `dagre` ships no types (TS7016 at layout.ts:7), and the suite plus the
    // config files use `node:` builtins.
    expect(pkg.devDependencies["@types/dagre"]).toBeTruthy();
    expect(pkg.devDependencies["@types/node"]).toBeTruthy();
  });

  it("checks what ships and leaves out what cannot be checked", () => {
    const build = read("../../../tsconfig.build.json");
    expect(build).toContain('"extends": "./tsconfig.json"');
    expect(build).toContain('"include": ["src/web"]');
    expect(build).toContain('"exclude": ["src/web/__tests__"]');
    // And the reason is written down, because "the tests are excluded" invites
    // exactly one question.
    expect(build).toMatch(/carry no types by design/);
  });

  it("keeps strict on in the project it extends", () => {
    const base = JSON.parse(read("../../../tsconfig.json").replace(/^\s*\/\/.*$/gm, ""));
    expect(base.compilerOptions.strict).toBe(true);
  });
});

describe("what npm pack ships", () => {
  it("builds the bundle for a pack as well as for a publish", () => {
    // prepublishOnly runs on `npm publish` and NOT on `npm pack`, so a pack for
    // verification could tarball a stale dist/web — which is the one artifact a
    // pack is usually made to check.
    expect(pkg.scripts.prepack).toBe("vite build");
    expect(pkg.scripts.prepublishOnly).toBe("vite build");
  });

  it("has no second name for the build", () => {
    // `build:web` was byte-identical to `build` and nothing referenced it.
    expect(pkg.scripts["build:web"]).toBeUndefined();
    expect(pkg.scripts.build).toBe("vite build");
  });
});
