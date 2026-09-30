// The images on a piece of feedback, as the dialog holds them: added from a
// drop, a paste or the picker, each made ready by prepareImage, and handed to
// Send once every one of them is.
//
// ONE AT A TIME. Files are prepared in the order they came, each after the one
// before has finished, because an image's budget is what the others leave of
// the request's 12 MB and a fit still in progress has no size yet. A drop of
// three large screenshots therefore fits them in turn, and a fourth is left out
// by count rather than by a race. Send waits on the same chain, so what it
// posts is the images as they will go, never one half-drawn.
//
// An image inside every limit is shown once its header has been read, which
// is at once. One that has to be drawn again is shown the moment the fit
// starts, with the file itself as its thumbnail, and says "resizing" until the
// fit is done; removed meanwhile, it is gone, and the fit's result with it.
// Every object URL is revoked when its image is removed or the dialog closes.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_IMAGES, FULL_MESSAGE, browserDecoder, imageBudget, leftOutMessage, prepareImage, problemMessage,
  type Size,
} from "./feedback-images";

export interface Shot {
  id: number;
  name: string;
  url: string;
  /** Null while it is being fitted. */
  blob: Blob | null;
  /** The size it was drawn again at, when it had to be. */
  resized: Size | null;
}

export interface FeedbackImages {
  shots: readonly Shot[];
  /** What went wrong with the last files added, in sentences; empty when nothing did. */
  problem: string;
  /** What a screen reader is told about the last change. */
  announcement: string;
  add(files: readonly File[]): void;
  remove(id: number): void;
  /** Says the three are already there, for an add pressed with no room. */
  sayFull(): void;
  /** Every image as it will be sent, once the fits under way have finished. */
  ready(): Promise<Blob[]>;
}

export function useFeedbackImages(): FeedbackImages {
  const [shots, setShotsState] = useState<readonly Shot[]>([]);
  const [problem, setProblem] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const shotsRef = useRef<readonly Shot[]>([]);
  const queue = useRef<Promise<void> | null>(null);
  const nextId = useRef(1);
  const open = useRef(true);

  const setShots = useCallback((next: (prev: readonly Shot[]) => readonly Shot[]) => {
    shotsRef.current = next(shotsRef.current);
    setShotsState(shotsRef.current);
  }, []);

  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.url);
    };
  }, []);

  const addOne = useCallback(async (file: File): Promise<string> => {
    const others = shotsRef.current.reduce((sum, shot) => sum + (shot.blob?.size ?? 0), 0);
    const id = nextId.current++;
    const url = URL.createObjectURL(file);
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      setShots(prev => [...prev, { id, name: file.name || "image", url, blob: null, resized: null }]);
    };
    const prepared = await prepareImage(file, imageBudget(others), async picked => {
      show();
      return browserDecoder(picked);
    }).catch(() => ({ ok: false as const, problem: "unreadable" as const }));
    const kept = shotsRef.current.some(shot => shot.id === id);
    if (!open.current || (shown && !kept)) {
      URL.revokeObjectURL(url);
      return "";
    }
    if (!prepared.ok) {
      URL.revokeObjectURL(url);
      if (shown) setShots(prev => prev.filter(shot => shot.id !== id));
      return problemMessage(prepared.problem, file.name || "image");
    }
    show();
    setShots(prev => prev.map(shot => (shot.id === id ? { ...shot, blob: prepared.blob, resized: prepared.resized } : shot)));
    return "";
  }, [setShots]);

  const addAll = useCallback(async (files: readonly File[]) => {
    // Cleared first, so the same refusal twice is said twice: an alert whose
    // text did not change is not read again.
    setProblem("");
    const problems: string[] = [];
    let leftOut = 0;
    let added = 0;
    for (const file of files) {
      if (!open.current) return;
      if (shotsRef.current.length >= MAX_IMAGES) {
        leftOut++;
        continue;
      }
      const before = shotsRef.current.length;
      const said = await addOne(file);
      if (said) problems.push(said);
      if (shotsRef.current.length > before) added++;
    }
    if (!open.current) return;
    if (leftOut > 0) problems.push(added === 0 && problems.length === 0 ? FULL_MESSAGE : leftOutMessage(leftOut));
    setProblem(problems.join(" "));
    const count = shotsRef.current.length;
    // A refusal is said by the alert beside the images; this says the rest.
    if (added > 0) setAnnouncement(`${added === 1 ? "Image" : `${added} images`} added, ${count} of ${MAX_IMAGES}.`);
  }, [addOne]);

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    queue.current = (queue.current ?? Promise.resolve()).then(() => addAll(files)).catch(() => {});
  }, [addAll]);

  const remove = useCallback((id: number) => {
    const gone = shotsRef.current.find(shot => shot.id === id);
    if (!gone) return;
    URL.revokeObjectURL(gone.url);
    setShots(prev => prev.filter(shot => shot.id !== id));
    setProblem("");
    setAnnouncement(`Image removed, ${shotsRef.current.length} of ${MAX_IMAGES}.`);
  }, [setShots]);

  const sayFull = useCallback(() => setProblem(FULL_MESSAGE), []);

  const ready = useCallback(async () => {
    await queue.current;
    return shotsRef.current.flatMap(shot => (shot.blob ? [shot.blob] : []));
  }, []);

  return { shots, problem, announcement, add, remove, sayFull, ready };
}
