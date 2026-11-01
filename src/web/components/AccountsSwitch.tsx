// One Accounts panel, two sides: the switch in its header says which CLI's
// accounts the column is showing. It stands where the title stood, so a deck
// with both CLIs has one Accounts door on the rail and no second row anywhere.
// A deck with one CLI draws none of this and keeps its plain title.
//
// It changes the VIEW and nothing else. The account each CLI starts sessions on
// is chosen on its own rows; pressing Codex here does not touch it.
//
// One tab stop, on the side showing — the radio pattern, as ThemeSection's. The
// arrows, Home and End switch as they go, as a click does.
import { type KeyboardEvent } from "react";

import { useT } from "../i18n";

export type AccountSide = "claude" | "codex";

const SIDES: readonly { side: AccountSide; name: string }[] = [
  { side: "claude", name: "Claude" },
  { side: "codex", name: "Codex" },
];

const MOVES: Record<string, (at: number) => number> = {
  ArrowLeft: at => at - 1,
  ArrowUp: at => at - 1,
  ArrowRight: at => at + 1,
  ArrowDown: at => at + 1,
  Home: () => 0,
  End: () => SIDES.length - 1,
};

/** The side a key moves to from the one showing, or null for any other key. */
export function sideForKey(shown: AccountSide, key: string): AccountSide | null {
  const step = Object.hasOwn(MOVES, key) ? MOVES[key] : null;
  if (!step) return null;
  const at = SIDES.findIndex(({ side }) => side === shown);
  return SIDES[(step(at) + SIDES.length) % SIDES.length].side;
}

interface Props {
  shown: AccountSide;
  /** The sides whose current account needs attention. Only the one out of
   *  sight wears the dot: the side showing says it in its own notice. */
  notices: Record<AccountSide, boolean>;
  onPick: (side: AccountSide) => void;
}

export default function AccountsSwitch({ shown, notices, onPick }: Props) {
  const t = useT();
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = sideForKey(shown, event.key);
    if (!next) return;
    event.preventDefault();
    onPick(next);
  };
  return (
    <div className="ap-sides" role="radiogroup" aria-label={t("accounts.switch.label")} onKeyDown={move}>
      {SIDES.map(({ side, name }) => {
        const flagged = side !== shown && notices[side];
        return (
          <button key={side} type="button" className="ap-side" role="radio"
            aria-checked={side === shown} tabIndex={side === shown ? 0 : -1}
            aria-label={flagged ? t("accounts.switch.attention", { name }) : name}
            title={flagged ? t("accounts.switch.attentionTip", { name }) : undefined}
            onClick={() => onPick(side)}>
            {name}
            {flagged && <span className="ap-side-dot" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
