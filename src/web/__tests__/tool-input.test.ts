// The line a human reads, as opposed to the object a modal shows.
//
// This exists because the first version of the blocked-tool tooltip rendered
// `shortPreview`, which JSON-stringifies, and the result read:
//
//     Likely on: Bash · {"command":"rm -rf node_modules"}
//
// Every character that decides the answer is in there, and every one of them is
// behind a brace and a key name, in the one place somebody is deciding whether
// to approve that command. Caught by opening the deck in a browser and reading
// the tooltip rather than by any assertion, which is the argument for having
// looked.
import { describe, it, expect } from "vitest";
import { salientInput } from "../tool-input";

describe("what a person is shown", () => {
  it("takes the command out of a Bash input", () => {
    expect(salientInput({ command: "rm -rf node_modules" })).toBe("rm -rf node_modules");
  });

  it("takes the path out of an Edit input", () => {
    expect(salientInput({ file_path: "/etc/hosts", old_string: "a", new_string: "b" }))
      .toBe("/etc/hosts");
  });

  it("prefers the command when a shape carries both", () => {
    // Bash is what gets asked about most, and it is the one where the words
    // rather than the target change the answer.
    expect(salientInput({ file_path: "/tmp/x", command: "git push --force" }))
      .toBe("git push --force");
  });

  it("passes a bare string through", () => {
    expect(salientInput("npm test")).toBe("npm test");
  });

  it("joins an argv array rather than unwrapping the interpreter", () => {
    // Unwrapping is skin work — ToolBursts does it to pick an emoji. A human
    // reading the whole line has still been told what is about to run.
    expect(salientInput({ command: ["powershell.exe", "-NoProfile", "-Command", "git status"] }))
      .toBe("powershell.exe -NoProfile -Command git status");
  });
});

describe("what a person is NOT shown", () => {
  it("returns null rather than a stringified object", () => {
    // The whole point. A tool whose input has no readable key reads better as
    // its bare name than as a brace-heavy fragment that stops mid-key — and the
    // callers already render the name on its own, so null costs nothing.
    expect(salientInput({ mode: "auto", depth: 3, flags: { deep: true } })).toBeNull();
  });

  it("returns null for nothing, and for shapes with nothing in them", () => {
    expect(salientInput(null)).toBeNull();
    expect(salientInput(undefined)).toBeNull();
    expect(salientInput({})).toBeNull();
    expect(salientInput("   ")).toBeNull();
    expect(salientInput({ command: "" })).toBeNull();
  });

  it("does not read a top-level array as an input", () => {
    // A tool input is an object or a string. An array here is a shape nobody
    // sends, and guessing at it would be inventing a rule.
    expect(salientInput(["rm", "-rf", "/"])).toBeNull();
  });

  it("clips a command too long for the surfaces that show it", () => {
    const long = "x".repeat(500);
    const got = salientInput({ command: long })!;
    expect(got.length).toBeLessThanOrEqual(120);
    expect(got.endsWith("…")).toBe(true);
  });
});
