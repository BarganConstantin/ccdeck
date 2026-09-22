// The naming and the counting behind the two share dialogs.
//
// Both are places where being merely approximate is a lie somebody acts on. A
// picker that shows two identical rows is a picker where the user cannot tell
// which account they are about to put on their clipboard; a result that says
// "done" over five accounts is what makes people import twice and then wonder
// whether they doubled something. Plain data in, plain data out, no DOM.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  importRowKey, importSummary, outcomeWord, pickedAccounts, pickerRows, replaceImportRow, shareCountLine,
  shareRequest, toggleUnpicked, type ImportResult,
} from "../share-bundle";

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
    // A literal "no organization" on both rows would leave them identical,
    // which is the failure the second line exists to prevent. The slot number
    // is the tiebreak the roster always has.
    const rows = pickerRows([acct(2, "me@x.com"), acct(3, "me@x.com")]);
    expect(rows.map(r => r.sub)).toEqual(["slot 2", "slot 3"]);
    expect(new Set(rows.map(r => `${r.label} ${r.sub}`)).size).toBe(2);
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

// #1175. The picker decides which live logins go onto the clipboard, and until
// this was pulled out of the dialog nothing checked it: the server exports
// exactly the accounts it is sent (share-many.test.ts), so a client that sent
// the wrong list would overshare with every test green.
describe("pickedAccounts", () => {
  const roster = (...nums: number[]) => nums.map(num => ({ num }));

  it("sends every account the user did not take out", () => {
    expect(pickedAccounts(roster(2, 3, 5), [3])).toEqual([2, 5]);
    // The picker opens with nothing taken out, which is everything ticked.
    expect(pickedAccounts(roster(2, 3, 5), [])).toEqual([2, 3, 5]);
  });

  it("follows the roster through a repoll that loses an account and finds it again", () => {
    // claude-swap rewriting sequence.json reads, for one poll, as account 5
    // being gone. It drops out, and comes back ticked — the user never took it
    // out, so it is still theirs to send.
    const unpicked = [3];
    expect(pickedAccounts(roster(2, 3), unpicked)).toEqual([2]);
    expect(pickedAccounts(roster(2, 3, 5), unpicked)).toEqual([2, 5]);
  });

  it("keeps an account the user unticked out, even across leaving and coming back", () => {
    // The overshare this exists to prevent: an account deliberately left out
    // must not come back ticked because the roster blinked.
    const unpicked = [3];
    expect(pickedAccounts(roster(2, 5), unpicked)).toEqual([2, 5]);
    expect(pickedAccounts(roster(2, 3, 5), unpicked)).toEqual([2, 5]);
  });

  it("sends nothing when everything was taken out", () => {
    expect(pickedAccounts(roster(2, 3, 5), [2, 3, 5])).toEqual([]);
  });

  it("orders by the roster, not by the order of the clicks", () => {
    // Unticked 5 then 2, ticked them back 2 then 5: the bundle still reads the
    // way the picker did.
    let unpicked: number[] = [];
    for (const n of [5, 2, 2, 5]) unpicked = toggleUnpicked(unpicked, n);
    expect(unpicked).toEqual([]);
    unpicked = toggleUnpicked(toggleUnpicked([], 3), 7);
    expect(pickedAccounts(roster(7, 2, 5, 3), unpicked)).toEqual([2, 5]);
  });
});

describe("toggleUnpicked", () => {
  it("takes an account out on one press and puts it back on the next", () => {
    expect(toggleUnpicked([], 3)).toEqual([3]);
    expect(toggleUnpicked([3], 3)).toEqual([]);
    expect(toggleUnpicked([2, 3], 3)).toEqual([2]);
  });
});

describe("shareRequest", () => {
  it("asks for exactly the accounts it is handed", () => {
    expect(shareRequest([2, 5])).toEqual({ action: "share", accounts: [2, 5] });
  });

  it("asks for nothing when nothing is picked", () => {
    // A bundle of nothing is not a request: the press does nothing at all.
    expect(shareRequest([])).toBeNull();
  });

  it("composes with the picker into the list the user left ticked", () => {
    expect(shareRequest(pickedAccounts([{ num: 2 }, { num: 3 }, { num: 5 }], [3])))
      .toEqual({ action: "share", accounts: [2, 5] });
    expect(shareRequest(pickedAccounts([{ num: 2 }, { num: 3 }], [2, 3]))).toBeNull();
  });
});

describe("the share dialog sends what the picker says", () => {
  // The half a DOM-less suite cannot drive: that the press actually posts the
  // request built above, and not a list of its own.
  const dialog = readFileSync(
    fileURLToPath(new URL("../components/ShareAccountsDialog.tsx", import.meta.url)), "utf8");

  it("derives the ticked list through pickedAccounts and toggles through toggleUnpicked", () => {
    expect(dialog).toMatch(/const picked = pickedAccounts\(accounts, unpicked\);/);
    expect(dialog).toMatch(/setUnpicked\(u => toggleUnpicked\(u, num\)\)/);
  });

  it("posts shareRequest's answer and nothing else", () => {
    const make = dialog.slice(dialog.indexOf("const make = useCallback("), dialog.indexOf("}, [accounts, picked]);"));
    expect(make).toMatch(/const request = shareRequest\(picked\);/);
    expect(make).toMatch(/if \(!selfPressAccepted\(busyRef\.current\) \|\| !request\) return;/);
    expect(make).toMatch(/await admin\(request\)/);
    expect(make).not.toMatch(/action: "share"/);
  });
});

// #1175, the sign-in dialog's other half: "update anyway" rewrites one row of
// the import's result list, and the list it rewrites may already be gone.
describe("replaceImportRow", () => {
  const row = (email: string, org: string | undefined, state: ImportResult["state"]): ImportResult =>
    ({ email, org, num: "1", state });

  it("leaves a dismissed list dismissed", () => {
    // "Import another" set it to null while the update was out. Anything but
    // null here puts the success screen back over the paste form.
    expect(replaceImportRow(null, "a@x.com|", row("a@x.com", undefined, "updated"))).toBeNull();
  });

  it("replaces the row it names where it stands, and nothing else", () => {
    const a = row("a@x.com", undefined, "imported");
    const b = row("b@x.com", undefined, "present");
    const b2 = row("b@x.com", undefined, "updated");
    expect(replaceImportRow([a, b], importRowKey(b), b2)).toEqual([a, b2]);
  });

  it("tells one address under two organizations apart", () => {
    // Two accounts to claude-swap, two rows here, and the update was for one.
    const acme = row("me@x.com", "Acme", "present");
    const globex = row("me@x.com", "Globex", "present");
    const fresh = row("me@x.com", "Globex", "updated");
    expect(replaceImportRow([acme, globex], importRowKey(globex), fresh)).toEqual([acme, fresh]);
  });

  it("keys a row by its address and its organization", () => {
    expect(importRowKey({ email: "a@x.com" })).toBe("a@x.com|");
    expect(importRowKey({ email: "a@x.com", org: "Acme" })).toBe("a@x.com|Acme");
  });
});
