// Where the deck starts its terminal engine (pro-engine-client.mjs engineStart).
//
// The engine starts the deck's tmux server, which keeps the engine's folder as
// its own for as long as any deck session lives. tmux 3.7 and later start a
// new pane in the folder asked for only while the server can read its own:
// once that folder is deleted (a project or worktree the deck was started in,
// the app's bundle an update replaced), every new pane starts inside the
// deleted folder and its agent ends at once. So on macOS and Linux the engine
// is started in the home folder, never the deck's own, with every place
// variable it reads given as an absolute path, as the deck resolves it.
// Windows is left as it was. Pure: platform, home and the deck's folder are
// given, nothing is started.
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain server module
import { engineStart } from "../../server/pro-engine-client.mjs";

const HOME = "/Users/u";
const DECK = "/Users/u/code/removed-worktree";
const opts = (over: Record<string, unknown> = {}) => ({ platform: "darwin", home: HOME, deckFolder: () => DECK, isFolder: (p: string) => p === HOME, ...over });

describe("the folder the terminal engine is started in", () => {
  it("is the home folder on macOS and Linux, never the folder the deck runs in", () => {
    for (const platform of ["darwin", "linux"]) {
      const env = { PATH: "/usr/bin", HOME };
      const start = engineStart(env, opts({ platform }));
      expect(start.cwd, platform).toBe(HOME);
      expect(start.env, "the same environment").toEqual(env);
      expect(start.env, "a copy, never the deck's own").not.toBe(env);
    }
  });

  it("is / where the home folder is not a folder", () => {
    expect(engineStart({}, opts({ isFolder: () => false })).cwd).toBe("/");
    expect(engineStart({}, opts({ home: "", isFolder: () => false })).cwd).toBe("/");
  });

  it("hands on every place the engine or its tmux reads as the deck resolves it, from the deck's folder", () => {
    const env = { CCDECK_HOME: " .deck ", CLAUDE_CONFIG_DIR: "../claude", CODEX_HOME: "/abs/codex", XDG_DATA_HOME: "data", TMUX_TMPDIR: "", PATH: "bin:/usr/bin" };
    expect(engineStart(env, opts()).env).toEqual({
      CCDECK_HOME: `${DECK}/.deck`,
      CLAUDE_CONFIG_DIR: "/Users/u/code/claude",
      CODEX_HOME: "/abs/codex",
      XDG_DATA_HOME: `${DECK}/data`,
      TMUX_TMPDIR: "",
      PATH: "bin:/usr/bin",
    });
  });

  it("leaves a relative place as given when the deck's own folder cannot be read", () => {
    const gone = () => { throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" }); };
    const start = engineStart({ CCDECK_HOME: ".deck" }, opts({ deckFolder: gone }));
    expect(start).toEqual({ cwd: HOME, env: { CCDECK_HOME: ".deck" } });
  });

  it("is left to Windows as it was: no folder given, the environment as it is", () => {
    const env = { CCDECK_HOME: ".deck", Path: "C:\\Windows" };
    const start = engineStart(env, opts({ platform: "win32" }));
    expect(start).toEqual({ env });
    expect("cwd" in start).toBe(false);
  });

  it("reads the real home folder and the deck's real folder by default", () => {
    // The host running the test may be Windows: its real home is C:\Users\…,
    // so the check is "the real home, or / where it is not a folder".
    const start = engineStart({}, { platform: "linux" });
    expect([homedir(), "/"]).toContain(start.cwd);
  });
});
