// The check mark a finished, rare action ends on: an account added (the sign-in
// dialog) and a piece of feedback sent (#1853). Drawn rather than shown — the
// ring sweeps, then the tick follows it, 340ms, ease-out, once — because drawing
// is what makes it read as "this just happened". The drawing and its
// reduced-motion answer are `.aa-mark`'s in add-account.css, where the mark was
// born; a second dialog borrowing it is why it lives in a file of its own.
import { forwardRef } from "react";

const SuccessMark = forwardRef<SVGSVGElement>((_props, ref) => (
  <svg className="aa-mark" viewBox="0 0 44 44" aria-hidden ref={ref}>
    <circle className="aa-mark-ring" cx="22" cy="22" r="20" />
    <path className="aa-mark-tick" d="M13.5 22.5 L19.5 28.5 L31 17" />
  </svg>
));
SuccessMark.displayName = "SuccessMark";

export default SuccessMark;
