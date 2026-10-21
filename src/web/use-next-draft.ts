// The "Next account" picker's draft: what it shows while nobody has saved,
// and the press that stores it. The threshold's shape (use-threshold-draft.ts)
// for a picker with two options and no custom field — held by the panel for
// the same reason: the policy row unmounts whenever the fold is shut, and a
// pick nobody saved must outlive that.
import { useRef, useState } from "react";

import { isNextChoice, type NextChoice } from "./auto-choice";
import { type AutoStatus } from "./claude-accounts";
import { nextCommit } from "./picker-commit";

/** How long `saved` stands before the control goes. The threshold's. */
const SAVED_MS = 1_800;

export interface NextDraftDeps {
  auto: AutoStatus | null;
  post: (body: Record<string, unknown>, tag: string) => Promise<{ ok?: boolean } | null>;
  load: (force?: boolean) => Promise<void>;
}

export function useNextDraft({ auto, post, load }: NextDraftDeps) {
  const [pick, setPick] = useState<NextChoice | null>(null);
  const [nextSaved, setNextSaved] = useState(false);
  const nextRef = useRef<HTMLSelectElement>(null);
  const nextSaveRef = useRef<HTMLButtonElement>(null);

  const next: NextChoice = auto?.choice?.next ?? "room";
  const nextPick: NextChoice = pick ?? next;
  const nextCtl = nextCommit(nextPick, next);

  /** A proposal: nothing is stored until `save` is pressed (#516). */
  const proposeNext = (value: string) => setPick(isNextChoice(value) ? value : null);

  const doNext = async () => {
    if (!nextCtl.sends) return;
    const out = await post({ action: "next", value: nextPick }, "next");
    await load(true);
    if (!out?.ok) return;
    setPick(null);
    setNextSaved(true);
    window.setTimeout(() => {
      // The control is about to go: the keyboard goes back to the picker
      // rather than to the page.
      if (document.activeElement === nextSaveRef.current) nextRef.current?.focus();
      setNextSaved(false);
    }, SAVED_MS);
  };

  return { nextPick, nextCtl, nextSaved, nextRef, nextSaveRef, proposeNext, doNext };
}
