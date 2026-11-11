// A file or folder path in a narrow place (path-display.ts says how it is
// shortened). Two spans, so CSS cuts it in the middle and follows the width:
// the head gives way with an ellipsis, the last segment keeps its width, and
// only a name wider than the whole box is cut, at its end (utilities.css).
// Always left to right: a path is not a sentence.
import { displayPath, splitPath } from "../path-display";

export default function PathText({ path, cwd, className, hint = true, keep = 1 }: {
  /** The path as the tool or the session gave it: the hover shows it whole. */
  path: string;
  /** The session's folder, when the path is to read from there. */
  cwd?: string;
  className?: string;
  /** False where the element around it already says the whole path in its title. */
  hint?: boolean;
  /** How many last segments are never cut (splitPath). */
  keep?: number;
}) {
  const { head, tail } = splitPath(displayPath(path, cwd), keep);
  return (
    <span className={className ? `path-text ${className}` : "path-text"} dir="ltr" title={hint ? path : undefined}>
      {head && <span className="path-head">{head}</span>}
      <span className="path-tail">{tail}</span>
    </span>
  );
}
