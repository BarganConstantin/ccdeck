import { describe, expect, it } from "vitest";
import { el, selects } from "./sheet-cascade";

describe("unsupported selector questions stay inside their actual scope", () => {
  it("does not let a radio-only pseudo stop measuring an unrelated control", () => {
    expect(selects(".radio-panel span:nth-child(2)", [el("header", ["topbar"]), el("span")])).toBeNull();
    expect(selects(".radio-panel > span:nth-child(2)", [el("header", ["topbar"]), el("span")])).toBeNull();
  });
  it("still refuses to guess when the unsupported pseudo affects the measured element", () => {
    expect(() => selects(".radio-panel span:nth-child(2)", [el("div", ["radio-panel"]), el("span")])).toThrow("unread selector part");
  });
  it("continues to reject a relevant sibling combinator", () => {
    expect(() => selects(".a + .b", [el("div"), el("span", ["b"])])).toThrow("unread combinator");
  });
});
