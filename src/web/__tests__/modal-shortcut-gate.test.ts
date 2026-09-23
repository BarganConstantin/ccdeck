// Every single-key shortcut except `c` fired while a modal was open.
//
// The handler's gate asks the focused element whether it owns the keystroke.
// That is right for a text field and wrong for a dialog: use-modal-dismiss.ts
// states outright that "clicking a paragraph of modal text drops focus on
// `<body>`", and BODY is in neither KEY_OWNING_TAGS nor KEY_OWNING_ROLES. So
// opening a tool call, clicking its JSON payload to read it, and pressing a
// letter ran that letter against the canvas behind the scrim.
//
// R is the one that hurt. handleRelayout clears every pin, every stored
// position and both localStorage keys — the hand-built arrangement is gone with
// no undo, and the user does not see it happen until they close the modal. On
// the same press H stacked a second modal over the first, Space paused the
// stream, and A/U/L opened panels underneath.
//
// The rule was not new. App.tsx's own comment above modalOpenRef describes this
// exact focus path and was written for `c`; what was missing is that the ref had
// exactly one caller.
//
// #1175 found the flag itself was the hole. `modalOpenRef` is an OR of App's
// own eight dialog flags, and nine more dialogs open from inside a panel with
// flags App never sees — Machine's process list and history charts, the
// accounts panel's add and share, the four LAN dialogs, a pairing request, and
// the clear prompt. Over every one of them R still wiped the layout. Escape
// had never had that hole, because it asks modalStack, which every dialog
// joins; the gate asks it now too.
import { describe, it, expect } from "vitest";
import { canvasModalOpen, shortcutBlocked } from "../shortcuts";
import { createDismissStack, escapeOutcome } from "../modal-dismiss";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";

const CANVAS_KEYS = [" ", "c", "r", "f", "l", "h", "u", "a", "j", "k", "t", "m"];

describe("a canvas shortcut while a modal is open", () => {
  it("is blocked for every key that acts on what the scrim is covering", () => {
    for (const key of CANVAS_KEYS) {
      expect(shortcutBlocked({ key, modalOpen: true, sheetOpen: false }), key).toBe(true);
      expect(shortcutBlocked({ key, modalOpen: true, sheetOpen: true }), key).toBe(true);
    }
  });

  it("is not blocked when no modal is up, which is the ordinary case", () => {
    for (const key of CANVAS_KEYS) {
      expect(shortcutBlocked({ key, modalOpen: false, sheetOpen: false }), key).toBe(false);
    }
  });

  it("lets `?` close the sheet it opened", () => {
    // The one exception, and it is narrow: `?` is advertised as a toggle, so it
    // has to be able to close what it opened.
    expect(shortcutBlocked({ key: "?", modalOpen: true, sheetOpen: true })).toBe(false);
  });

  it("does not let `?` stack a second modal over somebody else's", () => {
    // Over a tool modal or the usage history, `?` would open the sheet on top of
    // it — two dialogs competing for one Escape, which is the thing the gate
    // exists to prevent.
    expect(shortcutBlocked({ key: "?", modalOpen: true, sheetOpen: false })).toBe(true);
    expect(shortcutBlocked({ key: "?", modalOpen: false, sheetOpen: false })).toBe(false);
  });
});

describe("the handler actually consults it", () => {
  // The rule is pure and tested above; this is the half that cannot be — that
  // App.tsx asks the question at all, and asks it BEFORE the key table rather
  // than after it.
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const handler = app.slice(
    app.indexOf("const onKey = (e: KeyboardEvent) => {"),
    app.indexOf('window.addEventListener("keydown", onKey);'),
  );

  it("gates the key table on shortcutBlocked", () => {
    expect(handler).toContain("shortcutBlocked({");
    expect(handler.indexOf("shortcutBlocked({"))
      .toBeLessThan(handler.indexOf('e.key === " "'));
  });

  it("still has a key table to gate, so this is not vacuous", () => {
    expect(handler).toContain('e.key === "r" || e.key === "R"');
    expect(handler).toContain("handleRelayout()");
  });
});

describe("what counts as a modal being open (#1175)", () => {
  /** The gate as App.tsx now asks it, over a stack of its own. */
  const blocked = (key: string, appModal: boolean, stack: ReturnType<typeof createDismissStack>) =>
    shortcutBlocked({
      key,
      modalOpen: canvasModalOpen({ appModal, dialogDepth: stack.dialogDepth() }),
      sheetOpen: false,
    });

  it("blocks R while a dialog App keeps no flag for is on the stack", () => {
    // The Machine panel's process list, say: App's eight flags are all false,
    // and the dialog is on screen because it pushed itself when it mounted.
    const stack = createDismissStack();
    expect(blocked("r", false, stack)).toBe(false);
    const unregister = stack.push(() => {});
    for (const key of CANVAS_KEYS) expect(blocked(key, false, stack), key).toBe(true);
    // And the letters come back the moment it unmounts.
    unregister();
    expect(blocked("r", false, stack)).toBe(false);
  });

  it("still blocks on App's own flag before the dialog has joined the stack", () => {
    // A dialog pushes itself in an effect, a commit after the render that drew
    // it; App's flags are read during that render. For the one keystroke that
    // can land in between, the flag is the only one of the two that knows.
    expect(canvasModalOpen({ appModal: true, dialogDepth: 0 })).toBe(true);
    expect(canvasModalOpen({ appModal: false, dialogDepth: 0 })).toBe(false);
    expect(canvasModalOpen({ appModal: false, dialogDepth: 2 })).toBe(true);
  });

  it("leaves the letters live over a popover, which covers nothing", () => {
    // The sound menu, the appearance menu and an account row's ⋯ join the same
    // stack for Escape and Tab. They have no scrim, the board stays in view
    // around them, and V has to be able to close the sound menu it opened —
    // so a popover is on the stack for Escape and off it for the letters.
    const stack = createDismissStack();
    stack.push(() => {}, 0, "popover");
    expect(stack.depth()).toBe(1);
    expect(stack.dialogDepth()).toBe(0);
    expect(blocked("r", false, stack)).toBe(false);
    expect(blocked("v", false, stack)).toBe(false);
    // Escape still reaches it: that question is the whole stack's.
    expect(escapeOutcome({ overlayOpen: stack.depth() > 0, typing: false })).toBe("dismiss");
  });

  it("blocks again once a dialog opens over the popover", () => {
    const stack = createDismissStack();
    stack.push(() => {}, 0, "popover");
    const dialog = stack.push(() => {});
    expect(blocked("r", false, stack)).toBe(true);
    dialog();
    expect(blocked("r", false, stack)).toBe(false);
  });

  it("counts an overlay as a dialog unless it says otherwise", () => {
    // The default is the direction that fails safe: a dialog written tomorrow
    // blocks the letters without anybody remembering to ask for it, and a
    // popover that forgets to say so costs a dead key, not a wiped layout.
    const stack = createDismissStack();
    stack.push(() => {});
    stack.push(() => {}, 1);
    expect(stack.dialogDepth()).toBe(2);
  });
});

describe("every dialog reaches the gate (#1175)", () => {
  const dir = fileURLToPath(new URL("../components", import.meta.url));
  const callers = readdirSync(dir)
    .filter(f => f.endsWith(".tsx"))
    .map(f => ({ name: f, code: withoutComments(readFileSync(`${dir}/${f}`, "utf8")) }))
    .filter(({ code }) => /useModalDismiss(<[^>]*>)?\(/.test(code));
  const isDialog = (code: string) => /aria-modal="true"/.test(code);
  const isPopover = (code: string) => /useModalDismiss(<[^>]*>)?\([\s\S]*?\{[^}]*popover: true[^}]*\}\)/.test(code);
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const handler = app.slice(
    app.indexOf("const onKey = (e: KeyboardEvent) => {"),
    app.indexOf('window.addEventListener("keydown", onKey);'),
  );
  const hook = readFileSync(fileURLToPath(new URL("../components/use-modal-dismiss.ts", import.meta.url)), "utf8");

  it("registers every aria-modal dialog as a dialog and every popover as a popover", () => {
    // The stack is only as good as what joins it under which name. A dialog
    // that registered as a popover would be the #1175 hole again, file by
    // file; a component that is neither is one nobody has decided about.
    for (const { name, code } of callers) {
      expect(`${name}: ${isDialog(code) ? "dialog" : isPopover(code) ? "popover" : "undecided"}`)
        .not.toBe(`${name}: undecided`);
      expect(`${name}: ${isDialog(code) && isPopover(code)}`).toBe(`${name}: false`);
    }
    // Named, so the count cannot drift without somebody reading this.
    expect(callers.filter(c => isPopover(c.code)).map(c => c.name).sort())
      .toEqual(["AnchoredPopover.tsx", "SoundMenu.tsx"]);
    // The nine the issue found, among the dialogs the stack now carries.
    const dialogs = callers.filter(c => isDialog(c.code)).map(c => c.name);
    for (const name of [
      "ProcessListModal.tsx", "SectionHistoryModal.tsx", "AddAccountDialog.tsx",
      "ShareAccountsDialog.tsx", "LanAddDeckModal.tsx", "LanSetupModal.tsx",
      "LanPeerModal.tsx", "LanPairRequestModal.tsx", "ClearConfirm.tsx",
    ]) expect(dialogs, name).toContain(name);
  });

  it("has the hook register each overlay under the kind it asked for", () => {
    expect(hook).toMatch(/const kind = popover \? "popover" : "dialog";/);
    expect(hook).toMatch(/modalStack\.push\(dismiss, layer, kind\)/);
  });

  it("asks the stack's dialogs, not only App's own flags", () => {
    expect(handler).toMatch(
      /modalOpen: canvasModalOpen\(\{ appModal: modalOpenRef\.current, dialogDepth: modalStack\.dialogDepth\(\) \}\)/,
    );
    expect(handler).not.toMatch(/modalOpen: modalOpenRef\.current,/);
  });
});
