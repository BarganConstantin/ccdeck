// The ⓘ in a panel's header, and the small menu it opens.
//
// ONE MEANING PER GLYPH. The panel's 30-second video used to be a ▷ in the same
// row as + and ↻, where a triangle reads "run" and the reader had to press it to
// learn it was a film. Behind ⓘ it is what an ⓘ promises: something to know
// about the panel. The menu says what the press leads to in words, with the
// length the link already knows, and the item is the same plain link FilmLink
// is: a new tab, and in the desktop app the person's own browser.
//
// The menu is AnchoredPopover's, as the stage's ⋯ is: arrows, Escape, Tab out
// and the focus hand-back come with it.
import { useId, useState } from "react";
import { FILMS, FILM_SUBJECT, type Film } from "../film-links";
import { useT } from "../i18n";
import AnchoredPopover from "./AnchoredPopover";
import { KitIcon } from "./kit-icons";

export default function PanelInfo({ film, panel }: {
  film: Film;
  /** The panel's own name, as its heading says it. */
  panel: string;
}) {
  const t = useT();
  const base = useId();
  const id = `${base}-info`;
  const menuId = `${base}-info-menu`;
  // Open at the first item, or (ArrowUp on the button) at the last.
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const label = t("shell.info.label", { panel });
  const subject = t(FILM_SUBJECT[film]);
  return (
    <>
      <button type="button" id={id} className="glyph-btn panel-info" aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}>
        <KitIcon name="info" />
      </button>
      {open && (
        <AnchoredPopover anchorId={id} id={menuId} className="ap-pop" role="menu"
          labelledBy={id} start={menu} onClose={() => setMenu(null)}>
          <a role="menuitem" className="ap-menu-item panel-info-film" href={FILMS[film].href} target="_blank" rel="noopener noreferrer"
            title={t("shell.film.title", { subject })}
            onClick={() => {
              document.getElementById(id)?.focus();
              // After the link has been followed: a link taken out of the page
              // during its own click is not followed at all.
              window.requestAnimationFrame(() => setMenu(null));
            }}>
            {t("shell.film.watchMenu", { duration: t("shell.film.duration") })}
            <span className="vis-hidden">{t("shell.film.hidden", { subject })}</span>
          </a>
        </AnchoredPopover>
      )}
    </>
  );
}
