// The failure line's one repair it can make itself (#1711): a settings folder
// another user owns, on a Mac, given back through macOS's password dialog.
//
// The server decides whether it is on offer — `detail.fix` is "give_back" only
// on macOS, and only for that case — and does all of the work; this is the
// press, and the sentence the line says after it.

/** What a failure line holds: the sentence, whether the press is on offer, and
 *  whether the sentence is the good news rather than a refusal. */
export type SettingsLine = { text: string; giveBack: boolean; done: boolean };

type Refused = { detail?: { fix?: string } | null } | null | undefined;

/** Whether this refusal is the one the press repairs. */
export function offersGiveBack(out: Refused): boolean {
  return out?.detail?.fix === "give_back";
}

/** A refusal as a line: `text` is writeFailure's sentence for `out`. */
export function refusalLine(text: string, out?: Refused): SettingsLine {
  return { text, giveBack: offersGiveBack(out), done: false };
}

export type GiveBackAnswer = { ok?: boolean; reason?: string; changed?: boolean } | null;

/** Ask the deck to open the password dialog. Resolves once it is answered,
 *  which is as long as the person takes; null when the deck did not answer. */
export async function requestGiveBack(): Promise<GiveBackAnswer> {
  try {
    const res = await fetch("/api/prefs/give-back", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/** The answers after which pressing again can still work. */
const TRY_AGAIN: Record<string, string> = {
  cancelled: "Nothing changed — the password dialog was closed. The folder still belongs to another user.",
  timed_out: "Nothing changed — the password dialog was not answered in time.",
  busy: "The password dialog is already open. It may be behind this window.",
};

/** What the line says once the press has an answer. */
export function afterGiveBack(answer: GiveBackAnswer): SettingsLine {
  if (answer?.ok) {
    const text = answer.changed === false
      ? "The settings folder is already yours, and the deck has read it again. Try that once more."
      : "Done — the settings folder is yours again, and the deck has read it again. Try that once more.";
    return { text, giveBack: false, done: true };
  }
  if (answer == null) return { text: "Could not give it back — the deck did not answer.", giveBack: true, done: false };
  const again = answer.reason ? TRY_AGAIN[answer.reason] : undefined;
  if (again) return { text: again, giveBack: true, done: false };
  return {
    text: "macOS did not give the folder back. The deck's log has the command that does it by hand.",
    giveBack: false,
    done: false,
  };
}
