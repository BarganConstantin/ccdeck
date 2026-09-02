// The naming and the counting behind the two share dialogs.
//
// Both are places where being merely approximate is a lie somebody acts on. A
// picker that shows two identical rows is a picker where the user cannot tell
// which account they are about to put on their clipboard; a result that says
// "done" over five accounts is what makes people import twice and then wonder
// whether they doubled something. Plain data in, plain data out, no DOM.
import { describe, it, expect } from "vitest";
import { importSummary, outcomeWord, pickerRows, shareCountLine } from "../share-bundle";

const acct = (num: number, email: string | null, alias: string | null = null, org: string | null = null) =>
  ({ num, email, alias, org });

describe("pickerRows", () => {
  it("leads with the name the panel rows lead with", () => {
    // A picker that renamed the accounts would be asking about a different list
    // from the one on screen behind it.
    const [aliased, plain] = pickerRows([acct(2, "a@x.com", "work"), acct(3, "b@x.com")]);
    expect(aliased.label).toBe("work");
    expect(plain.label).toBe("b@x.com");
  });

  it("keeps the address in reach when an alias is standing in front of it", () => {
    expect(pickerRows([acct(2, "a@x.com", "work")])[0].sub).toBe("a@x.com");
  });

  it("names the slot for an account with no address at all", () => {
    expect(pickerRows([acct(4, null)])[0]).toMatchObject({ label: "account 4", sub: null });
  });

  it("says nothing extra when the label already stands alone", () => {
    // The second line is a disambiguator, not a caption. An account whose
    // address appears once needs no help being told apart.
    expect(pickerRows([acct(2, "a@x.com"), acct(3, "b@x.com")]).map(r => r.sub)).toEqual([null, null]);
  });

  it("separates one address under two organizations, which are two accounts", () => {
    const rows = pickerRows([acct(2, "me@x.com", null, "Acme"), acct(3, "me@x.com", null, "Globex")]);
    expect(rows.map(r => r.sub)).toEqual(["Acme", "Globex"]);
  });

  it("still separates them when the roster never learned the organization's name", () => {
    const rows = pickerRows([acct(2, "me@x.com"), acct(3, "me@x.com")]);
    expect(rows.map(r => r.sub)).toEqual(["no organization", "no organization"]);
  });

  it("treats two spellings of one address as the repeat they are", () => {
    const rows = pickerRows([acct(2, "Me@X.com", null, "Acme"), acct(3, "me@x.com", null, "Globex")]);
    expect(rows.every(r => r.sub !== null)).toBe(true);
  });
});

describe("shareCountLine", () => {
  it("counts sign-in tokens, because that is the thing being moved", () => {
    // The envelope carries each account's OAuth login in the clear, so five
    // ticked boxes is five live logins on a clipboard other apps can read.
    expect(shareCountLine(5)).toBe("5 accounts — 5 sign-in tokens will be on your clipboard.");
  });

  it("does not say 1 accounts", () => {
    expect(shareCountLine(1)).toBe("1 account — its sign-in token will be on your clipboard.");
  });

  it("warns about nothing when nothing is picked", () => {
    // A warning that fires over an empty selection is a warning people learn to
    // read past by the time it matters.
    expect(shareCountLine(0)).toBe("Nothing picked yet.");
  });
});

describe("importSummary", () => {
  const rows = (states: string[]) =>
    states.map((state, i) => ({ email: `a${i}@x.com`, num: String(i), state } as never));

  it("says how many of how many, which is the whole point of the sentence", () => {
    expect(importSummary(rows(["imported", "imported", "imported", "present", "present"])))
      .toBe("3 of 5 imported, 2 already here.");
  });

  it("leaves out the groups that did not happen rather than printing zeroes", () => {
    expect(importSummary(rows(["imported"]))).toBe("1 of 1 imported.");
  });

  it("names an account that did not arrive, instead of rounding it away", () => {
    expect(importSummary(rows(["imported", "failed"]))).toBe("1 of 2 imported, 1 did not arrive.");
  });

  it("keeps a healed token apart from an import", () => {
    expect(importSummary(rows(["healed", "present"])))
      .toBe("1 had a dead token replaced, 1 already here.");
  });

  it("says so plainly when everything was already here", () => {
    // The run somebody repeats because the first one said nothing useful.
    expect(importSummary(rows(["present", "present"]))).toBe("2 already here.");
  });

  it("has something to say about an empty bundle", () => {
    expect(importSummary([])).toBe("Nothing to import.");
  });
});

describe("outcomeWord", () => {
  it("keeps an automatic rewrite apart from one a person asked for", () => {
    // Collapsing these would make claude-swap healing a dead token look like
    // something the user did, and the reason is the only interesting part.
    expect(outcomeWord("healed")).toBe("dead token replaced");
    expect(outcomeWord("updated")).toBe("updated");
  });

  it("never calls an account that did not arrive anything but that", () => {
    expect(outcomeWord("failed")).toBe("not imported");
  });
});
