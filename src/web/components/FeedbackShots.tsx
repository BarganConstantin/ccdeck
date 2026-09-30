// The feedback dialog's images, drawn: the button that opens the picker, which
// sits in the message's label row so the form is no taller for a person who
// never uses it, and the strip under the message that holds what was added.
//
// Each image is a fixed box, so a thumbnail that is still loading moves
// nothing, with a remove of its own at its corner. Removing one hands focus to
// the next image's remove, or the one before, or back to the add button, so
// the keyboard is never dropped onto the page. The count says how many of the
// three are used and how many were drawn again to fit; the line under it says
// what a screenshot can show. A refusal — the wrong format, too many, too big —
// is said beside them, and every change is said to a screen reader through a
// live region drawn from the first render, since a paste makes no sound.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ADD_HINT, ADD_LABEL, MAX_IMAGES, SHOTS_NOTE, focusAfterRemove, shotsSummary } from "../feedback-images";
import type { FeedbackImages, Shot } from "../use-feedback-images";

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

/** "Add a screenshot", and the file picker behind it. Pressed with three
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
        className="fb-attach"
        title={ADD_HINT}
        aria-describedby="fb-attach-hint"
        onClick={() => (full ? images.sayFull() : pickRef.current?.click())}
      >
        <ImageGlyph />
        {ADD_LABEL}
      </button>
      <span id="fb-attach-hint" className="vis-hidden">{ADD_HINT}</span>
      <input ref={pickRef} type="file" accept="image/png,image/jpeg" multiple hidden
        onChange={e => {
          images.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

function shotName(shot: Shot, index: number): string {
  const resized = shot.resized ? `, resized to ${shot.resized.width} × ${shot.resized.height} to fit` : "";
  return `Image ${index + 1}: ${shot.name}${resized}`;
}

interface StripProps {
  images: FeedbackImages;
  addRef: RefObject<HTMLButtonElement>;
}

export default function FeedbackShots({ images, addRef }: StripProps) {
  const removeRefs = useRef(new Map<number, HTMLButtonElement>());
  const [focusNext, setFocusNext] = useState<number | "add" | null>(null);
  const { shots } = images;
  const summary = shotsSummary(shots.length, shots.filter(shot => shot.resized).length);

  useLayoutEffect(() => {
    if (focusNext === null) return;
    (focusNext === "add" ? addRef.current : removeRefs.current.get(focusNext))?.focus();
    setFocusNext(null);
  }, [focusNext, addRef]);

  function removeShot(id: number) {
    setFocusNext(focusAfterRemove(shots.map(shot => shot.id), id) ?? "add");
    images.remove(id);
  }

  return (
    <>
      <p className="vis-hidden" role="status">{images.announcement}</p>
      {shots.length > 0 && (
        <div className="fb-shots">
          <div className="fb-shots-row">
            <ul className="fb-shots-list">
              {shots.map((shot, index) => (
                <li key={shot.id} className="fb-shot" data-fitting={shot.blob ? undefined : true}>
                  <img className="fb-shot-img" src={shot.url} alt={shotName(shot, index)} title={shotName(shot, index)} />
                  {!shot.blob && <span className="fb-shot-busy" aria-hidden="true">Resizing…</span>}
                  <button
                    ref={button => {
                      if (button) removeRefs.current.set(shot.id, button);
                      else removeRefs.current.delete(shot.id);
                    }}
                    type="button"
                    className="glyph-btn fb-shot-remove"
                    aria-label={`Remove image ${index + 1}`}
                    title="Remove"
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
      {images.problem && <p className="fb-error" role="alert">{images.problem}</p>}
    </>
  );
}
