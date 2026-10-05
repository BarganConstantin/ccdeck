// The shell a Windows deck reports (reports.mjs shellToken).
//
// Windows has no SHELL, so the token is read off what each shell leaves in the
// environment of what it starts. PSModulePath is not one of those: Windows
// sets it machine-wide, so cmd.exe, Windows PowerShell and the desktop app
// started from the Start menu all inherit it, and every Windows deck reported
// "pwsh". ComSpec is machine-wide too. What PowerShell does add is its user
// module folder, under the user's profile — Documents\PowerShell\Modules for
// PowerShell 7, Documents\WindowsPowerShell\Modules for Windows PowerShell —
// and cmd.exe defines PROMPT. With none of them the shell cannot be told, and
// the field is left out rather than guessed.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { shellToken } from "../../server/reports.mjs";

const PROFILE = "C:\\Users\\Bob";
/** What every process on a stock Windows inherits, whatever started it. */
const MACHINE = {
  USERPROFILE: PROFILE,
  ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
  PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
};
const PS51_USER = `${PROFILE}\\Documents\\WindowsPowerShell\\Modules`;
const PS7 = [
  `${PROFILE}\\Documents\\PowerShell\\Modules`,
  "C:\\Program Files\\PowerShell\\Modules",
  "c:\\program files\\powershell\\7\\Modules",
].join(";");

describe("the shell on Windows", () => {
  it("is left out when nothing but the machine-wide variables is there", () => {
    // The desktop app from the Start menu, a login item, a scheduled task.
    expect(shellToken(MACHINE, "win32")).toBeUndefined();
  });

  it("is cmd when cmd.exe started the deck", () => {
    expect(shellToken({ ...MACHINE, PROMPT: "$P$G" }, "win32")).toBe("cmd");
  });

  it("is powershell for Windows PowerShell, and pwsh for PowerShell 7", () => {
    expect(shellToken({ ...MACHINE, PSModulePath: `${PS51_USER};${MACHINE.PSModulePath}` }, "win32")).toBe("powershell");
    expect(shellToken({ ...MACHINE, PSModulePath: `${PS7};${MACHINE.PSModulePath}` }, "win32")).toBe("pwsh");
    // The user's Documents moved into OneDrive is still the user's.
    expect(shellToken({
      ...MACHINE, PSModulePath: `${PROFILE}\\OneDrive\\Documents\\PowerShell\\Modules\\;${MACHINE.PSModulePath}`,
    }, "win32")).toBe("pwsh");
  });

  it("names the PowerShell even when a cmd.exe sits between it and the deck", () => {
    // npm's ccdeck.cmd shim, run from a PowerShell prompt, goes through cmd.exe.
    expect(shellToken({ ...MACHINE, PROMPT: "$P$G", PSModulePath: `${PS7};${MACHINE.PSModulePath}` }, "win32")).toBe("pwsh");
  });

  it("does not take another program's module folder for PowerShell's", () => {
    // SQL Server's tools add theirs machine-wide, under Program Files.
    const sql = "C:\\Program Files (x86)\\Microsoft SQL Server\\150\\Tools\\PowerShell\\Modules\\";
    expect(shellToken({ ...MACHINE, PSModulePath: `${MACHINE.PSModulePath};${sql}` }, "win32")).toBeUndefined();
  });

  it("still says SHELL first, when a Git-Bash-style shell set one", () => {
    expect(shellToken({ ...MACHINE, SHELL: "/usr/bin/bash" }, "win32")).toBe("bash");
  });
});
