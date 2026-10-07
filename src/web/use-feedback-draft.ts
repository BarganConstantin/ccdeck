// The feedback dialog's side of a kept draft (feedback-draft.ts): writing what
// it holds into the page's drafts as it changes and as it closes, letting the
// draft go once the report has been sent, and the two presses that discard it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackDraft } from "./feedback";
import { feedbackDrafts, type FeedbackSeed } from "./feedback-draft";
import { CONFIRM_GAP_MS, armedPress } from "./panel-press";
import type { FeedbackImages } from "./use-feedback-images";

/** How long Discard stays armed for its second press, as the deck's other
 *  irreversible presses do. */
export const DISCARD_ARMED_MS = 4_000;

interface Latest { key: string; seed: FeedbackSeed; words: FeedbackDraft; images: FeedbackImages; sent: boolean }

/**
 * Keeps the dialog's draft under `key`: whenever the words or the images
 * change — so a reload finds the words — and when the dialog closes, which is
 * the moment an image still being fitted or waiting its turn has to be handed
 * over. Once `sent`, the draft is let go and nothing writes it back.
 */
export function useKeepDraft(
  key: string, seed: FeedbackSeed, words: FeedbackDraft, images: FeedbackImages, sent: boolean,
): void {
  const latest = useRef<Latest | null>(null);
  latest.current = { key, seed, words, images, sent };
  const keep = useCallback(() => {
    const now = latest.current;
    if (!now || now.sent) return;
    feedbackDrafts.keep(now.key, { ...now.words, images: now.images.kept() }, now.seed);
  }, []);
  useEffect(keep, [keep, words.kind, words.body, words.contact, images.shots]);
  useEffect(() => keep, [keep]);
  useEffect(() => {
    if (sent) feedbackDrafts.forget(key);
  }, [sent, key]);
}

const DRAFT = "draft";

/** Discard's two presses: the first arms it, a second inside DISCARD_ARMED_MS
 *  — and not so soon that it was the same double-click — calls `onDiscard`. */
export function useArmedDiscard(onDiscard: () => void): { armed: boolean; press: () => void } {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), DISCARD_ARMED_MS);
    return () => window.clearTimeout(t);
  }, [armed]);
  function press() {
    const now = Date.now();
    const verdict = armedPress({
      armedFor: armed ? DRAFT : null, target: DRAFT, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (verdict === "arm") {
      setArmed(true);
      armedAt.current = now;
      return;
    }
    if (verdict === "ignore") return;
    setArmed(false);
    onDiscard();
  }
  return { armed, press };
}
