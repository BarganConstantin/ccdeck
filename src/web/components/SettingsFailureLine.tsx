// The red line a refused settings write leaves, with the one repair the deck
// can make from here (#1711): give the settings folder back, through macOS's
// own password dialog, when the server says that is what blocked the write.
//
// The line's owner keeps the SettingsLine; this draws it and makes the press.
// Once the press has an answer the owner is handed the next line — the good
// news, or why not — so a later refusal replaces it the way any other does.
import { useEffect, useRef, useState } from "react";
import { afterGiveBack, requestGiveBack, type SettingsLine } from "../settings-give-back";

export function SettingsFailureLine({ line, onDismiss, onAnswer }: {
  line: SettingsLine | null;
  onDismiss: () => void;
  /** The press has an answer; `next` is what the line says now. */
  onAnswer: (next: SettingsLine) => void;
}) {
  const [asking, setAsking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const pressRef = useRef<HTMLButtonElement>(null);
  const xRef = useRef<HTMLButtonElement>(null);
  /** Focus was on the press when its answer took the press away. */
  const rescue = useRef(false);

  useEffect(() => {
    if (!rescue.current) return;
    rescue.current = false;
    if (!line?.giveBack) xRef.current?.focus();
  }, [line]);

  if (!line) return null;

  // Never disabled while it works, so focus stays where the press was (#518):
  // busy, and a second press is ignored.
  const press = async () => {
    if (asking) return;
    setAsking(true);
    const answer = await requestGiveBack();
    if (!alive.current) return;
    setAsking(false);
    rescue.current = document.activeElement === pressRef.current;
    onAnswer(afterGiveBack(answer));
  };

  return (
    <div className={line.done ? "ap-failure ap-failure-done" : "ap-failure"} role="alert">
      <span className="ap-failure-text">{line.text}</span>
      {line.giveBack && (
        <button ref={pressRef} type="button" className="ap-fix ap-give-back" aria-busy={asking}
          onClick={press}
          title="Opens macOS's password dialog to make the settings folder yours again">
          {asking ? "waiting for macOS…" : "give it back"}
        </button>
      )}
      <button ref={xRef} type="button" className="ap-failure-x" onClick={onDismiss}
        aria-label="Dismiss this message" title="Dismiss">×</button>
    </div>
  );
}
