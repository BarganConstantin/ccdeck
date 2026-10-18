// Landing on a search result (settings-search.ts): once the section it lives
// in is on show, its row is scrolled to the middle of the pane, marked for a
// moment, and handed focus, so the keyboard that picked the result can change
// the setting with its next key.
//
// The row is found by its `data-setting`, which is the id the index holds, and
// looked for after the section has rendered rather than at the press: the
// press switches the section, and the row it names does not exist until the
// new pane does. Some rows come later still — Data's are drawn once the
// server has said how much history there is — so a row not there yet is
// watched for, for a few seconds, and then given up on with the section open,
// which is the most a result can promise about a row that never arrives.
import { useEffect, useRef, useState, type RefObject } from "react";
import { isTabbable, TABBABLE_SELECTOR } from "../modal-dismiss";

/** How long the mark stays on the row. The wash fades out over 1.2s in the
 *  sheet; under reduced motion the mark is a still outline, gone after this. */
export const JUMP_MARK_MS = 1500;
/** How long a row that has not rendered yet is waited for. */
const JUMP_WAIT_MS = 3000;

const rendered = (el: HTMLElement) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);

/** Where focus goes in a row a result landed on: the row itself when it is the
 *  control (a theme's preview); else the choice that is made, in a group of
 *  radios (the text sizes, the themes), because that is the one stop Tab would
 *  reach and the arrows move from; else the first control in the row's list,
 *  past a group caption's own button (a tone's Hear it, above its volume);
 *  else the first control at all. Null for a row that only reads a value out,
 *  such as the version, where focus stays in the field. */
export function focusTargetIn(row: HTMLElement): HTMLElement | null {
  if (row.matches(TABBABLE_SELECTOR) && !(row as HTMLButtonElement).disabled) return row;
  const checked = row.querySelector<HTMLElement>('input[type="radio"]:checked, [role="radio"][aria-checked="true"]');
  if (checked) return checked;
  const usable = Array.from(row.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(el => isTabbable({
    disabled: (el as HTMLElement & { disabled?: boolean }).disabled,
    tabIndex: el.tabIndex,
    rendered: rendered(el),
  }));
  return usable.find(el => el.closest(".settings-list") != null) ?? usable[0] ?? null;
}

/** Hands back `jumpTo(id)`. `pane` is the section's pane, and `ready` is false
 *  while the results stand in its place, so a jump waits for the section. */
export function useSettingsJump(pane: RefObject<HTMLElement | null>, ready: boolean, section: string): (id: string) => void {
  const [target, setTarget] = useState<string | null>(null);
  const markTimer = useRef<number | undefined>(undefined);
  const marked = useRef<HTMLElement | null>(null);

  useEffect(() => () => {
    window.clearTimeout(markTimer.current);
    marked.current?.removeAttribute("data-jumped");
  }, []);

  useEffect(() => {
    const root = pane.current;
    if (!target || !ready || !root) return;
    const find = () => root.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target)}"]`);

    const land = (row: HTMLElement) => {
      setTarget(null);
      // The middle of the pane, clear of both soft edges, unless the row is
      // taller than the pane — the theme grid on a short window — when its top
      // is what says where the reader is. At once rather than smoothly: the
      // pane was behind the results until this press, so a scroll would
      // travel from a place the reader never saw.
      const tall = row.offsetHeight > root.clientHeight - 48;
      row.scrollIntoView({ block: tall ? "start" : "center" });
      focusTargetIn(row)?.focus({ preventScroll: true });
      // The mark, restarted if the same row is landed on twice in a row: the
      // attribute comes off, a layout read lets the animation end, and it goes
      // back on.
      window.clearTimeout(markTimer.current);
      marked.current?.removeAttribute("data-jumped");
      void row.offsetWidth;
      row.setAttribute("data-jumped", "");
      marked.current = row;
      markTimer.current = window.setTimeout(() => {
        row.removeAttribute("data-jumped");
        if (marked.current === row) marked.current = null;
      }, JUMP_MARK_MS);
    };

    const now = find();
    if (now) { land(now); return; }
    const watch = new MutationObserver(() => {
      const row = find();
      if (!row) return;
      watch.disconnect();
      window.clearTimeout(giveUp);
      land(row);
    });
    watch.observe(root, { childList: true, subtree: true });
    const giveUp = window.setTimeout(() => { watch.disconnect(); setTarget(null); }, JUMP_WAIT_MS);
    return () => { watch.disconnect(); window.clearTimeout(giveUp); };
  }, [pane, target, ready, section]);

  return setTarget;
}
