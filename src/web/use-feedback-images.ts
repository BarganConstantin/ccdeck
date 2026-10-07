// The images on a piece of feedback, as the dialog holds them: added from a
// drop, a paste or the picker, each made ready by prepareImage, and handed to
// Send once every one of them is.
//
// ONE AT A TIME. Files are prepared in the order they came, each after the one
// before has finished, because an image's budget is what the others leave of
// the request's 12 MB and a fit still in progress has no size yet. A drop of
// three large screenshots therefore fits them in turn, and a fourth is left out
// by count rather than by a race. Send waits on the same chain, so what it
// posts is the images as they will go, never one half-drawn — and when one of
// them is refused while it waits, it posts nothing: the refusal would be said
// beside the images just as the thanks covered them and the dialog closed.
//
// An image inside every limit is shown once its header has been read, which
// is at once. One that has to be drawn again is shown the moment the fit
// starts, with the file itself as its thumbnail, and says "resizing" until the
// fit is done; removed meanwhile, it is gone, and the fit's result with it.
//
// REPLACING keeps the image's place and its id, so its thumbnail — the button
// that was pressed — is the same element afterwards and keeps focus. The old
// image stays until the new one is known to be good: a file refused, or one
// that cannot be fitted, puts it back as it was.
//
// Every object URL is revoked when its image is removed or replaced, or the
// dialog closes.
//
// KEPT ACROSS A CLOSE (feedback-draft.ts). `kept` says what a closed dialog
// should hand back: every image that is ready, as it will be sent, and the
// file behind every one still being fitted or waiting its turn. Handed to the
// hook when the dialog opens again, the ready ones are drawn at once and the
// others go back through the queue as an add. `clear` lets go of them all,
// fits under way and adds still waiting included.
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
  /** Which refusal `problem` is: a new number each time one is said, the same
   *  words or not, so the alert can be drawn — and read out — afresh. */
  problemId: number;
  /** What a screen reader is told about the last change. */
  announcement: string;
  add(files: readonly File[]): void;
  /** The first of `files` in the place of image `id`. */
  replace(id: number, files: readonly File[]): void;
  remove(id: number): void;
  /** Says the three are already there, for an add pressed with no room. */
  sayFull(): void;
  /** Every image as it will be sent, once the fits under way have finished;
   *  null when something was refused meanwhile, which `problem` says. */
  ready(): Promise<Blob[] | null>;
  /** What the dialog should get back if it closed now. */
  kept(): KeptImages;
  /** Lets go of every image, and of every file still on its way in. */
  clear(): void;
}

/** A ready image, as a closed dialog keeps it. */
export interface KeptShot { name: string; blob: Blob; resized: Size | null }

/** The images a closed dialog keeps: the ready ones, and the files of those
 *  still being fitted or waiting their turn, to be added again. */
export interface KeptImages {
  ready: readonly KeptShot[];
  waiting: readonly File[];
}

/** The ready images drawn again, under ids from `firstId` on. */
export function restoreShots(ready: readonly KeptShot[], firstId: number): Shot[] {
  return ready.map((kept, i) => ({
    id: firstId + i, name: kept.name, url: URL.createObjectURL(kept.blob), blob: kept.blob, resized: kept.resized,
  }));
}

/** The list with `fresh` drawn in it: in the place of the image it replaces,
 *  which shares its id, or at the end. */
export function placeShot(shots: readonly Shot[], fresh: Shot, replacing: boolean): readonly Shot[] {
  return replacing ? shots.map(shot => (shot.id === fresh.id ? fresh : shot)) : [...shots, fresh];
}

/** The list once the file drawn as image `id` turned out not to be usable: the
 *  image it was replacing put back where it was, or, for an add, nothing. */
export function withdrawShot(shots: readonly Shot[], id: number, replacing: Shot | undefined): readonly Shot[] {
  return replacing ? shots.map(shot => (shot.id === id ? replacing : shot)) : shots.filter(shot => shot.id !== id);
}

export function useFeedbackImages(restore?: KeptImages): FeedbackImages {
  // The images a closed dialog kept are drawn on the first render, so a
  // dialog opened again shows them at once rather than a frame later.
  const [shots, setShotsState] = useState<readonly Shot[]>(() => restoreShots(restore?.ready ?? [], 1));
  // Each refusal counted as it is said. The words alone cannot tell a second
  // refusal from the first: with no room left an add awaits nothing, so its
  // clear and its refusal land in one render with the words unchanged, and
  // sayFull clears nothing at all. The count is kept in a ref as well, so
  // `ready` can tell a refusal said while it waited.
  const [refusal, setRefusal] = useState({ problem: "", id: 0 });
  const refusals = useRef(0);
  const setProblem = useCallback((problem: string) => {
    if (problem) refusals.current++;
    setRefusal(prev => {
      if (problem) return { problem, id: prev.id + 1 };
      return prev.problem ? { problem: "", id: prev.id } : prev;
    });
  }, []);
  const [announcement, setAnnouncement] = useState("");
  const shotsRef = useRef<readonly Shot[]>(shots);
  const queue = useRef<Promise<void> | null>(null);
  /** The last id given out: the restored images hold 1 to n. */
  const nextId = useRef(shots.length);
  const open = useRef(true);
  /** The file behind each image still being fitted, by its id, and every file
   *  added that has not had its turn yet: what `kept` hands back for them. */
  const fitting = useRef(new Map<number, File>());
  const waiting = useRef<File[]>([]);
  /** Moved on by `clear`, so an add or a fit begun before it adds nothing. */
  const generation = useRef(0);

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

  /** One file made ready and drawn: appended, or in the place of `replacing`.
   *  Answers with what went wrong, in a sentence, or nothing. */
  const addOne = useCallback(async (file: File, replacing?: Shot): Promise<string> => {
    const others = shotsRef.current.reduce((sum, shot) => sum + (shot.id === replacing?.id ? 0 : shot.blob?.size ?? 0), 0);
    const id = replacing?.id ?? ++nextId.current;
    const url = URL.createObjectURL(file);
    const fresh: Shot = { id, name: file.name || "image", url, blob: null, resized: null };
    const begun = generation.current;
    fitting.current.set(id, file);
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      setShots(prev => placeShot(prev, fresh, replacing !== undefined));
    };
    const prepared = await prepareImage(file, imageBudget(others), async picked => {
      show();
      return browserDecoder(picked);
    }).catch(() => ({ ok: false as const, problem: "unreadable" as const }));
    const kept = shotsRef.current.some(shot => shot.id === id);
    if (!open.current || generation.current !== begun || (!kept && (shown || replacing))) {
      URL.revokeObjectURL(url);
      if (replacing) URL.revokeObjectURL(replacing.url);
      // Closed meanwhile, the file stays in `fitting`: the dialog kept it, and
      // fits it again when it opens.
      if (open.current) fitting.current.delete(id);
      return "";
    }
    fitting.current.delete(id);
    if (!prepared.ok) {
      URL.revokeObjectURL(url);
      if (shown) setShots(prev => withdrawShot(prev, id, replacing));
      return problemMessage(prepared.problem, file.name || "image");
    }
    show();
    if (replacing) URL.revokeObjectURL(replacing.url);
    setShots(prev => prev.map(shot => (shot.id === id ? { ...shot, blob: prepared.blob, resized: prepared.resized } : shot)));
    return "";
  }, [setShots]);

  const addAll = useCallback(async (files: readonly File[]) => {
    // Cleared first, so the last add's refusal is not left standing over this
    // one. A refusal said again is said again by its id, not by this: with no
    // room left nothing below is awaited and the two land in one render.
    setProblem("");
    const begun = generation.current;
    const problems: string[] = [];
    let leftOut = 0;
    let added = 0;
    for (const file of files) {
      if (!open.current || generation.current !== begun) return;
      const at = waiting.current.indexOf(file);
      if (at !== -1) waiting.current.splice(at, 1);
      if (shotsRef.current.length >= MAX_IMAGES) {
        leftOut++;
        continue;
      }
      const before = shotsRef.current.length;
      const said = await addOne(file);
      if (said) problems.push(said);
      if (shotsRef.current.length > before) added++;
    }
    if (!open.current || generation.current !== begun) return;
    if (leftOut > 0) problems.push(added === 0 && problems.length === 0 ? FULL_MESSAGE : leftOutMessage(leftOut));
    setProblem(problems.join(" "));
    const count = shotsRef.current.length;
    // A refusal is said by the alert beside the images; this says the rest.
    if (added > 0) setAnnouncement(`${added === 1 ? "Image" : `${added} images`} added, ${count} of ${MAX_IMAGES}.`);
  }, [addOne, setProblem]);

  const replaceOne = useCallback(async (id: number, file: File) => {
    setProblem("");
    const replacing = shotsRef.current.find(shot => shot.id === id);
    // Removed while it waited its turn: the file is an add like any other.
    if (!replacing) return addAll([file]);
    const said = await addOne(file, replacing);
    if (!open.current) return;
    setProblem(said);
    const at = shotsRef.current.findIndex(shot => shot.id === id);
    if (!said && at !== -1) setAnnouncement(`Image ${at + 1} replaced, ${shotsRef.current.length} of ${MAX_IMAGES}.`);
  }, [addAll, addOne, setProblem]);

  /** A job queued before a `clear` never starts. */
  const enqueue = useCallback((job: () => Promise<void>) => {
    const begun = generation.current;
    queue.current = (queue.current ?? Promise.resolve())
      .then(() => (generation.current === begun ? job() : undefined))
      .catch(() => {});
  }, []);

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    waiting.current.push(...files);
    enqueue(() => addAll(files));
  }, [addAll, enqueue]);

  // What a closed dialog was still fitting goes back through the queue.
  useEffect(() => {
    if (restore && restore.waiting.length > 0) add(restore.waiting);
    // What the dialog opened with, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = useCallback((id: number, files: readonly File[]) => {
    const file = files[0];
    if (file) enqueue(() => replaceOne(id, file));
  }, [enqueue, replaceOne]);

  const remove = useCallback((id: number) => {
    const gone = shotsRef.current.find(shot => shot.id === id);
    if (!gone) return;
    URL.revokeObjectURL(gone.url);
    fitting.current.delete(id);
    setShots(prev => prev.filter(shot => shot.id !== id));
    setProblem("");
    setAnnouncement(`Image removed, ${shotsRef.current.length} of ${MAX_IMAGES}.`);
  }, [setShots, setProblem]);

  const sayFull = useCallback(() => setProblem(FULL_MESSAGE), [setProblem]);

  const ready = useCallback(async () => {
    const said = refusals.current;
    await queue.current;
    if (refusals.current !== said) return null;
    return shotsRef.current.flatMap(shot => (shot.blob ? [shot.blob] : []));
  }, []);

  /** An image being replaced is kept as its replacement's file, not twice. */
  const kept = useCallback((): KeptImages => ({
    ready: shotsRef.current.flatMap(shot => (shot.blob && !fitting.current.has(shot.id)
      ? [{ name: shot.name, blob: shot.blob, resized: shot.resized }]
      : [])),
    waiting: [...fitting.current.values(), ...waiting.current],
  }), []);

  const clear = useCallback(() => {
    generation.current++;
    for (const shot of shotsRef.current) URL.revokeObjectURL(shot.url);
    fitting.current.clear();
    waiting.current = [];
    setShots(() => []);
    setProblem("");
  }, [setShots, setProblem]);

  return {
    shots, problem: refusal.problem, problemId: refusal.id, announcement, add, replace, remove, sayFull, ready, kept, clear,
  };
}
