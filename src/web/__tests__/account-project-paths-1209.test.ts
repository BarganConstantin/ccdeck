import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homeRelativePath, projectParentLabel } from "../account-project-paths";

const here = dirname(fileURLToPath(import.meta.url));

describe("project path disclosure", () => {
  it("renders macOS, Linux and Windows home paths relative to home", () => {
    expect(homeRelativePath("/Users/ada/Desktop/ccdeck/src")).toBe("~/Desktop/ccdeck/src");
    expect(homeRelativePath("/home/ada/work/ccdeck")).toBe("~/work/ccdeck");
    expect(homeRelativePath("C:\\Users\\Ada\\work\\ccdeck")).toBe("~/work/ccdeck");
    expect(homeRelativePath("/home/ada/")).toBe("~");
    // Outside a home it is the path itself, with Windows separators turned.
    expect(homeRelativePath("/srv/ccdeck")).toBe("/srv/ccdeck");
    expect(homeRelativePath("D:\\work\\ccdeck")).toBe("D:/work/ccdeck");
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
    expect(src).toContain('`${expanded ? "Hide" : "Show"} location for ${r.label}`');
    expect(src).toContain("aria-label={infoLabel}");
    expect(src).toContain("r.members.map(member =>");
    expect(src).toContain("homeRelativePath(member.path)");
  });

  it("names Other's toggle for the list it opens, not for a location", () => {
    // Other has no location of its own: it opens the folded projects, and its
    // label already reads "Other · N projects".
    const src = readFileSync(resolve(here, "../components/AccountProjectsModal.tsx"), "utf8");
    expect(src).toMatch(/const infoLabel = r\.members\s*\? `\$\{expanded \? "Hide" : "Show"\} the \$\{r\.members\.length\} project/);
    expect(src).toContain("folded into Other`");
  });

  it("points the toggle at the details only while they are on the page (#800)", () => {
    const src = readFileSync(resolve(here, "../components/AccountProjectsModal.tsx"), "utf8");
    expect(src).toContain("const hasDetails = expanded && (!!r.path || !!r.members);");
    expect(src).toContain("aria-controls={hasDetails ? detailsId : undefined}");
    // Both regions the toggle can open carry the id it points at.
    expect(src).toContain('<div className="ap-proj-details" id={detailsId}>');
    expect(src).toContain('<div className="ap-proj-details ap-proj-other-members" id={detailsId}>');
  });

  it("shows the ~ form but copies the absolute path, and says that it did", () => {
    const src = readFileSync(resolve(here, "../components/AccountProjectsModal.tsx"), "utf8");
    // The fold is by shape, so the shortened form is never what reaches the
    // clipboard: a pasted `~` would resolve to whoever pastes it.
    expect(src).not.toMatch(/copyText\(homeRelativePath\(/);
    expect(src).toMatch(/void copyText\(path\)\.then\(ok =>/);
    expect(src).toContain("onClick={() => copyLocation(r.path!, r.label)}");
    expect(src).toContain("onClick={() => copyLocation(member.path, member.label)}");
    // Every Copy is named for its project — a column of bare "Copy" is a column
    // a screen reader cannot tell apart — and the name follows the word shown.
    expect(src).toContain("aria-label={`${copyWord(r.path)} location for ${r.label}`}");
    expect(src).toContain("aria-label={`${copyWord(member.path)} location for ${member.label}`}");
    expect(src).not.toMatch(/className="ap-proj-copy"[^>]*>Copy</);
    // The result is spoken from a polite region that is always on the page, so
    // the text arriving is what gets announced (WCAG 4.1.3).
    expect(src).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">\s*\{copied && \(copied\.ok/);
    expect(src).toContain("Copied the location of ${copied.label}");
  });

  it("keeps an Other member to two rows on a narrow screen", () => {
    // Name, cost, tokens and Copy on the first row need four columns; with
    // three, Copy took the tokens' cell and the tokens fell to a third row.
    const css = readFileSync(resolve(here, "../styles.css"), "utf8");
    const phone = /@media \(max-width: 520px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf(".ap-proj-foot")))?.[1] ?? "";
    expect(phone).toContain(".ap-proj-other-member { grid-template-columns: minmax(0, 1fr) max-content max-content max-content; }");
    expect(phone).toContain(".ap-proj-other-member .ap-proj-path { grid-column: 1 / -1; grid-row: 2; }");
    expect(phone).toContain(".ap-proj-other-member .ap-proj-copy { grid-column: 4; grid-row: 1; }");
  });
});
