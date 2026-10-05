// The feedback dialog's images, drawn: the button that opens the picker, quiet
// in the row under the message, and — only once there is one — a strip of
// thumbnails between the message and that row. A person who never adds a
// screenshot sees one small button and nothing else.
//
// Each thumbnail is a fixed box, so one still loading moves nothing, and it is
// the image's own control: pressed, it opens the picker again and the file
// chosen takes that image's place. A remove stands at its corner. Removing one
// hands focus to the next image's remove, or the one before, or back to the
// add button, so the keyboard is never dropped onto the page; replacing keeps
// the thumbnail and the focus on it. The count says how many of the three are
// used and how many were drawn again to fit; the line under it says what a
// screenshot can show. A refusal — the wrong format, too many, too big — is
// said beside them, and every change is said to a screen reader through a live
// region drawn from the first render, since a paste makes no sound.
//
// The add button and the strip are the only two places an image is shown or
// chosen from, so a future way to capture one — an area of the screen — joins
// the row as one more button calling `images.add`, and nothing else moves.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ADD_HINT, ADD_LABEL, MAX_IMAGES, SHOTS_NOTE, focusAfterRemove, replaceLabel, shotsSummary } from "../feedback-images";
import type { FeedbackImages } from "../use-feedback-images";

const ACCEPT = "image/png,image/jpeg";

/** A picture in a frame, on the topbar's icon spec (#837): a 14 viewBox, a 1.4
 *  stroke, round caps and joins. */
export function ImageGlyph({ className = "fb-glyph" }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="1.8" y="2.4" width="10.4" height="9.2" rx="1.6" />
      <circle cx="5" cy="5.6" r="1" />
      <path d="M2.4 10.4 5.5 7.6l2.1 1.8 1.5-1.3 2.5 2.2" />
    </svg>
  );
}

interface AddProps {
  images: FeedbackImages;
  buttonRef: RefObject<HTMLButtonElement>;
}

/** "Add screenshot", and the file picker behind it. Pressed with three
 *  already there it says so, rather than opening a picker whose choice would
 *  be refused. */
export function AddScreenshot({ images, buttonRef }: AddProps) {
  const pickRef = useRef<HTMLInputElement>(null);
  const full = images.shots.length >= MAX_IMAGES;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="fb-tool"
        title={ADD_HINT}
        aria-describedby="fb-attach-hint"
        onClick={() => (full ? images.sayFull() : pickRef.current?.click())}
      >
        <ImageGlyph />
        {ADD_LABEL}
      </button>
      {/* Hidden, and still the button's description: a description is read
          from a hidden element, and this way it is not read a second time as
          text after the button. */}
      <span id="fb-attach-hint" hidden>{ADD_HINT}</span>
      <input ref={pickRef} type="file" accept={ACCEPT} multiple hidden
        onChange={e => {
          images.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

interface StripProps {
  images: FeedbackImages;
  addRef: RefObject<HTMLButtonElement>;
}

export default function FeedbackShots({ images, addRef }: StripProps) {
  const removeRefs = useRef(new Map<number, HTMLButtonElement>());
  const problemRef = useRef<HTMLParagraphElement>(null);
  const replacePickRef = useRef<HTMLInputElement>(null);
  const replacing = useRef<number | null>(null);
  const [focusNext, setFocusNext] = useState<number | "add" | null>(null);
  const { shots } = images;
  const summary = shotsSummary(shots.length, shots.filter(shot => shot.resized).length);

  useLayoutEffect(() => {
    if (focusNext === null) return;
    (focusNext === "add" ? addRef.current : removeRefs.current.get(focusNext))?.focus();
    setFocusNext(null);
  }, [focusNext, addRef]);

  // Said below the images, which on a short window is below the fold of the
  // dialog's scroll: brought into view, so a refusal is seen as well as heard.
  // Every refusal, by its id: the same words twice are two refusals.
  useEffect(() => {
    if (images.problem) problemRef.current?.scrollIntoView({ block: "nearest" });
  }, [images.problem, images.problemId]);

  function removeShot(id: number) {
    setFocusNext(focusAfterRemove(shots.map(shot => shot.id), id) ?? "add");
    images.remove(id);
  }

  function pickReplacement(id: number) {
    replacing.current = id;
    replacePickRef.current?.click();
  }

  return (
    <>
      <p className="vis-hidden" role="status">{images.announcement}</p>
      <input ref={replacePickRef} type="file" accept={ACCEPT} hidden
        onChange={e => {
          const id = replacing.current;
          if (id !== null) images.replace(id, Array.from(e.target.files ?? []));
          replacing.current = null;
          e.target.value = "";
        }}
      />
      {shots.length > 0 && (
        <div className="fb-shots">
          <div className="fb-shots-row">
            <ul className="fb-shots-list">
              {shots.map((shot, index) => (
                <li key={shot.id} className="fb-shot" data-fitting={shot.blob ? undefined : true}>
                  <button
                    type="button"
                    className="fb-shot-pick"
                    aria-label={replaceLabel(index, shot.name, shot.resized)}
                    onClick={() => pickReplacement(shot.id)}
                  >
                    <img className="fb-shot-img" src={shot.url} alt="" />
                    {shot.blob
                      ? <span className="fb-shot-cue" aria-hidden="true">Replace</span>
                      : <span className="fb-shot-busy" aria-hidden="true">Resizing…</span>}
                  </button>
                  <button
                    ref={button => {
                      if (button) removeRefs.current.set(shot.id, button);
                      else removeRefs.current.delete(shot.id);
                    }}
                    type="button"
                    className="glyph-btn fb-shot-remove"
                    aria-label={`Remove image ${index + 1}`}
                    title={`Remove image ${index + 1}`}
                    onClick={() => removeShot(shot.id)}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4"
                      strokeLinecap="round" aria-hidden focusable="false">
                      <path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            <span className="fb-shots-count">{summary}</span>
          </div>
          <p className="fb-hint">{SHOTS_NOTE}</p>
        </div>
      )}
      {/* Keyed on the refusal, so each one is a new alert and read out, even
          in the words of the one before. */}
      {images.problem && <p key={images.problemId} ref={problemRef} className="fb-error" role="alert">{images.problem}</p>}
    </>
  );
}
