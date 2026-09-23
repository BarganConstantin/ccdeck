import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homeRelativePath, projectParentLabel } from "../account-project-paths";

const here = dirname(fileURLToPath(import.meta.url));

describe("project path disclosure", () => {
  it("renders macOS, Linux and Windows home paths relative to home", () => {
    expect(homeRelativePath("/Users/ada/Desktop/ccdeck/src", "/Users/ada")).toBe("~/Desktop/ccdeck/src");
    expect(homeRelativePath("/home/ada/work/ccdeck", "/home/ada")).toBe("~/work/ccdeck");
    expect(homeRelativePath("C:\\Users\\Ada\\work\\ccdeck", "C:\\Users\\Ada")).toBe("~/work/ccdeck");
  });

  it("finds the closest listed parent and leaves top-level projects alone", () => {
    const projects = [
      { path: "/home/ada/vcrm-core", label: "vcrm-core" },
      { path: "/home/ada/vcrm-core/src", label: "src" },
      { path: "/home/ada/other", label: "other" },
    ];
    expect(projectParentLabel("/home/ada/vcrm-core/src/ClientApp", projects)).toBe("src");
    expect(projectParentLabel("/home/ada/other", projects)).toBeUndefined();
  });

  it("keeps Other expandable and exposes accessible expansion state", () => {
    const src = readFileSync(resolve(here, "../components/AccountProjectsModal.tsx"), "utf8");
    expect(src).toContain("members: tail.map(rowFor)");
    expect(src).toContain("aria-expanded={expanded}");
    expect(src).toContain('aria-label={`${expanded ? "Hide" : "Show"} location for ${r.label}`}');
    expect(src).toContain("r.members.map(member =>");
    expect(src).toContain("homeRelativePath(member.path)");
    expect(src).toContain("copyText(homeRelativePath(member.path))");
  });
});
