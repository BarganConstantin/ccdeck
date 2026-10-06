// The quiet way from a panel to its 30-second video on ccdeck.dev.
//
// A plain link, so it goes where every other link out of the deck goes: a new
// tab in a browser, and in the desktop app the person's own browser, never the
// app's window (desktop/nav.mjs). The visible words are the start of the name,
// and the hidden tail says where the press leads (2.5.3), the shape the
// provider chips already use.
import { FILMS, type Film } from "../film-links";

export default function FilmLink({ film }: { film: Film }) {
  const { href, subject } = FILMS[film];
  return (
    <a className="film-link" href={href} target="_blank" rel="noopener noreferrer"
      title={`The ${subject} video on ccdeck.dev, 30 seconds — opens in your browser`}>
      Watch · 30 s
      <span className="vis-hidden">: the {subject} video on ccdeck.dev, opens in your browser</span>
    </a>
  );
}
