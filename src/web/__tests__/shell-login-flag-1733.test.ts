// #1733. Codex's argv `shell` tool sends a command as
// `["bash", "-lc", "git status"]` — `zsh -lc` on macOS — and the sub-bubble read
// ⚙️ bash (or zsh) instead of 🐙 git, because only a bare `-c` or `-Command` was
// taken as the flag that hands the next word to the shell as its script. A login
// shell's `-lc` is the same flag with `-l` folded into it, so the whole argv was
// joined and `bash` was its first word. The string spelling, `bash -lc '…'`, fell
// through the unwrap in parseShellCommand for the same reason.
//
// Behavioural: the label the canvas draws and the word the compact card face
// names, from the inputs Codex and Claude actually send.
import { describe, it, expect } from "vitest";
import { skinFor, toolSubject } from "../tool-skin";

describe("a login shell's -lc", () => {
  it("is unwrapped in Codex's argv shell tool", () => {
    expect(skinFor("shell", { command: ["bash", "-lc", "git status"] })?.label).toBe("git");
    expect(toolSubject("shell", { command: ["zsh", "-lc", "npm test"] })).toBe("npm");
  });

  it("is unwrapped in a command string", () => {
    expect(skinFor("Bash", { command: "bash -lc 'git status'" })?.label).toBe("git");
    expect(skinFor("exec_command", { cmd: "zsh -lc \"npm test\"" })?.label).toBe("npm");
  });

  it("leaves the spellings that already worked as they were", () => {
    expect(skinFor("shell", { command: ["bash", "-c", "git status"] })?.label).toBe("git");
    expect(skinFor("Bash", { command: "bash -c 'git status'" })?.label).toBe("git");
    expect(skinFor("shell", { command: ["powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"] })?.label).toBe("Get-ChildItem");
    expect(skinFor("Bash", { command: "pwsh -NoProfile -Command \"Get-Process\"" })?.label).toBe("Get-Process");
    // Not a script flag at all: `-l` alone runs a login shell with no command,
    // so there is nothing inside it to name.
    expect(skinFor("shell", { command: ["bash", "-l"] })?.label).toBe("bash");
  });
});
