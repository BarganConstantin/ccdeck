// Which keystrokes the deck is allowed to claim.
//
// The canvas shortcuts are bare letters — c clears, r re-lays-out, f fits — and
// a keydown for Ctrl+C or Cmd+C arrives with e.key set to that same bare "c".
// Without a modifier check the deck answers the browser's own chords: copying a
// line of tool output ran Clear, which empties the server's ring buffer and
// truncates the events file it replays from, and every Ctrl+R refresh threw
// away the layout the persistence feature exists to keep.
//
// Ctrl and Cmd both count, because the copy/refresh chord is Ctrl on Linux and
// Windows and Cmd on macOS, and a build has no way to know which one is in
// front of it. Alt joins them for the menu chords (Alt+F opens the browser's
// File menu). Shift deliberately does not: the handler already treats "C" and
// "c" alike, so Shift+letter is ours to keep.
//
// Kept out of App.tsx so the rule can be tested without a DOM.

/** The modifier flags every KeyboardEvent carries. Structural so a test can
 *  pass a plain object instead of synthesising a real event. */
export interface ChordModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** True when the keystroke belongs to the browser or the OS rather than to the
 *  deck's single-key shortcuts. */
export function isBrowserChord(e: ChordModifiers): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

// The other half of the rule is where the keystroke landed. The guard used to
// be tagName === "INPUT" and nothing else, which left every other control in
// the app defenceless: with a toolbar button focused, Space ran preventDefault
// and toggled pause, and a canceled Space keydown also suppresses the button's
// own activation, so a keyboard user pressing the button they had just tabbed
// to paused the stream instead. The version banner's dismiss control was a
// role="button" span with its own Space handler before it became a real
// <button>, and the clickable tool bursts were another until they went back to
// being the decoration they are drawn as, so one keypress did two unrelated
// things. Worst of all, with one of the accounts panel's <select>s focused — a
// panel that opens by default — a bare "c" reached Clear, which empties the
// server's ring buffer and truncates events.jsonl with no confirmation and no
// undo.
//
// A focused control owns its own keys and the deck only gets what is left:
// <select> matches bare letters as type-ahead, a checkbox and a <button> and
// any role="button" answer Space, a contenteditable answers everything.
//
// The one exception is the canvas itself. React Flow dresses every agent card
// as a tabbable role="button", which made this rule kill all thirteen
// shortcuts for as long as a card held focus — see canvas-keys.ts, which
// settles what a card owns before App.tsx reaches this gate.

/** The handful of properties of the focused element the target rules read.
 *  Structural, and deliberately not an Element, so the rule can be tested in a
 *  plain node environment where there is no DOM to focus anything in. */
export interface FocusTarget {
  tagName?: string | null;
  isContentEditable?: boolean | null;
  role?: string | null;
  type?: string | null;
  /** Did a pointer press put focus here? (#851) The browser cannot be asked:
   *  `:focus-visible` is re-decided on the keystroke itself, before any
   *  handler runs (see canvas-pointer-focus.test.ts), so App.tsx tracks it. */
  pointerFocused?: boolean | null;
}

// <input> covers far more than typing, and the types below take Space or a
// click rather than characters — blurring them on Escape would only cost the
// keyboard user their place in the tab order.
const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit",
]);

// Native elements that answer a bare key by themselves.
const KEY_OWNING_TAGS = new Set([
  "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "SUMMARY", "A",
]);

// The same controls rebuilt out of <div>/<span> with a role. Nothing on this
// deck is written that way today: the tool bursts were, until they went back
// to being aria-hidden decoration with no tabIndex (#854) — the detail
// panel's tool rows are real <button>s, and since #814 a selection made from
// the keyboard opens that panel. The list stays so a control built that way
// tomorrow is still left its own keys.
const KEY_OWNING_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio",
  "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

/** DOM tag names arrive uppercase, JSX authors them lowercase, and the target
 *  may be window or the document, which has no tag at all. */
function tagOf(t: FocusTarget): string {
  return typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
}

/** A <button>, or anything wearing the button role. */
function isButtonLike(t: FocusTarget): boolean {
  if (tagOf(t) === "BUTTON") return true;
  const roles = typeof t.role === "string" ? t.role.trim().toLowerCase() : "";
  return roles.split(/\s+/).includes("button");
}

/** True when the keystroke is going into text the user is writing. Escape
 *  blurs one of these; every other key is simply not the deck's. */
export function isTypingTarget(t: FocusTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = tagOf(t);
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  // A bare <input> defaults to type="text".
  return !NON_TEXT_INPUT_TYPES.has(String(t.type ?? "text").toLowerCase());
}

/** True when the focused control answers bare keys itself, so the deck must
 *  leave this keystroke alone rather than preventDefault it away. */
export function ownsKeystroke(t: FocusTarget | null | undefined, key?: string): boolean {
  if (!t) return false;
  if (isTypingTarget(t)) return true;
  // A BUTTON THE MOUSE PRESSED does not own the letters (#851). Clicking `$`
  // left focus on it, and then every single-key shortcut was dead until Esc,
  // with nothing on screen to say so — mouse users rarely press Esc first, so
  // the keys read as broken exactly when somebody mixed the two. A button has
  // no use for a letter; what it owns is Space and Enter, which stay its own so
  // the press that activates it is never stolen. Reached by Tab, it keeps
  // every key, as before.
  if (key != null && key.length === 1 && key !== " " && t.pointerFocused && isButtonLike(t)) return false;
  if (KEY_OWNING_TAGS.has(tagOf(t))) return true;
  // role takes a whitespace-separated fallback list; an interactive role
  // anywhere in it is enough reason for us to stay out of the way.
  const roles = typeof t.role === "string" ? t.role.trim().toLowerCase() : "";
  return roles !== "" && roles.split(/\s+/).some(r => KEY_OWNING_ROLES.has(r));
}

/**
 * Whether a canvas-level shortcut must stay out of the way because a modal is
 * on screen.
 *
 * `ownsKeystroke` above asks the FOCUSED ELEMENT whether it owns the key, which
 * is the right question for a text field and the wrong one for a dialog.
 * use-modal-dismiss.ts states it outright: "clicking a paragraph of modal text
 * drops focus on `<body>`" — and BODY is in neither KEY_OWNING_TAGS nor
 * KEY_OWNING_ROLES. So reading a tool call's JSON payload and then pressing a
 * letter ran that letter against the canvas behind the scrim.
 *
 * R was the one that hurt. It clears every pin, every stored position and both
 * localStorage keys, so an arrangement built by hand was gone with no undo — and
 * the user did not see it happen until they closed the modal. H stacked a second
 * modal over the first; Space paused the stream; A, U and L opened panels
 * underneath.
 *
 * The rule is not new: it is the one `c` already had. What was missing is that
 * it had exactly one caller.
 *
 * `?` is the single exception and only for the sheet itself, because it is
 * advertised as a toggle and has to be able to close what it opened. Over any
 * other modal it would stack a second one, which is the thing being prevented.
 * Escape is not on this path at all — it is answered through modalStack.
 */
export function shortcutBlocked(
  { key, modalOpen, sheetOpen }: { key: string; modalOpen: boolean; sheetOpen: boolean },
): boolean {
  if (!modalOpen) return false;
  return !(key === "?" && sheetOpen);
}

/**
 * Whether a dialog covers the canvas, which is the `modalOpen` the gate above
 * is handed.
 *
 * App.tsx used to hand it a hand-kept OR of its own eight dialog flags, and the
 * deck had seventeen dialogs. The nine it did not list are opened from inside
 * a panel — Machine's process list and history charts, the accounts panel's
 * add and share, the four LAN dialogs, a pairing request, and the clear prompt
 * itself — and none of their flags live in App. So with one of them open and
 * focus on its prose, or on a control the mouse had just focused, R cleared
 * every pin behind the scrim, C raised the clear prompt over it and Space
 * paused the stream (#1175).
 *
 * Escape never had that hole, because it asks modalStack, which every dialog
 * joins through useModalDismiss. So the gate asks it too, and a dialog written
 * next year is covered by being a dialog at all. `appModal` stays in the OR for
 * the one commit in which it knows more than the stack: App's flags are read
 * during render and a dialog joins the stack in an effect after it.
 *
 * `dialogDepth` counts dialogs, not popovers — see dialogDepth in
 * modal-dismiss.ts for why a popover leaves the letters live.
 */
export function canvasModalOpen(
  { appModal, dialogDepth }: { appModal: boolean; dialogDepth: number },
): boolean {
  return appModal || dialogDepth > 0;
}
