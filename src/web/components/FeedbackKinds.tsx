// What a piece of feedback is about — a bug, an idea, anything else — as one
// compact segmented control over the message. It was three cards, each with a
// glyph, a name and a line describing it, the tallest thing in the dialog and
// the first thing read; three short words are told apart without any of that,
// and the question under them changes with the choice, which is where the
// difference matters.
//
// Native radios under the paint, so the arrows walk them, Tab stops once and a
// screen reader hears a group of three; each <label> is the target. Being in
// the form, a radio would submit it on a bare Enter, which is how a kind
// picked with the arrows and settled with Enter sent the report on the spot;
// that Enter does nothing here, as in the contact field (isPlainEnter).
import { KINDS, isPlainEnter, type Kind } from "../feedback";

interface Props {
  kind: Kind;
  onChange: (kind: Kind) => void;
}

export default function FeedbackKinds({ kind, onChange }: Props) {
  return (
    <fieldset className="fb-kinds">
      <legend className="vis-hidden">Kind of feedback</legend>
      {KINDS.map(option => (
        <label key={option.value} className="fb-kind">
          <input
            type="radio"
            name="feedback-kind"
            value={option.value}
            checked={kind === option.value}
            onChange={() => onChange(option.value)}
            onKeyDown={e => { if (isPlainEnter(e.nativeEvent)) e.preventDefault(); }}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
