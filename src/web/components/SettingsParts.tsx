// The two shapes every Settings section is built from (#2176): a GROUP — a
// caption over one bordered list — and a ROW in that list.
//
// Settings had five row shapes for one job: `.appearance-row` for Board and
// Keyboard, `.sm-setting`/`.sm-switch` for Notifications and Play sounds,
// `.sm-row` for a tone's volume, the reading fieldsets, and Tool history's
// label over its select. A note sat under one switch and above the next, the
// Character switch sat in a heading, and every section read as the menu it was
// lifted out of. This is the row macOS System Settings, Windows 11 and
// libadwaita's preferences all settled on: the name, and under it one line
// saying what it does, on the left; the control on the right, on the name's
// line; rows grouped under a caption in one list with hairlines between them,
// so the eye reads down one edge for names and down the other for values.
//
// A row is a <label> when it holds a control, so a press on its name reaches
// the control once and the control is the one tab stop. A row that only reads
// out a value, or holds two buttons, is a <div>: a label wrapped round two
// controls would hand every press on its name to the first of them.
import type { ReactNode } from "react";

interface GroupProps {
  /** The caption's id, which names the group to assistive technology. A group
   *  with no `title` — a section's master switch, standing above the groups it
   *  governs — has no caption and needs none. */
  id?: string;
  title?: ReactNode;
  /** One line under the caption, for what every row in it shares. */
  note?: ReactNode;
  noteId?: string;
  /** The caption's right-hand slot: a key cap, a count, a button that acts on
   *  the whole group. */
  aside?: ReactNode;
  /** False for a group whose content draws its own frame — the theme previews,
   *  the text-size scale — which inside a bordered list would be a box in a
   *  box. */
  list?: boolean;
  className?: string;
  children: ReactNode;
}

export function SettingsGroup({ id, title, note, noteId, aside, list = true, className, children }: GroupProps) {
  const classes = className ? `settings-group ${className}` : "settings-group";
  const body = list ? <div className="settings-list">{children}</div> : children;
  if (title === undefined) return <div className={classes}>{body}</div>;
  return (
    <section className={classes} aria-labelledby={id}>
      <div className="settings-caption">
        <div className="settings-caption-text">
          <h3 id={id}>{title}</h3>
          {note && <p className="settings-caption-note" id={noteId}>{note}</p>}
        </div>
        {aside}
      </div>
      {body}
    </section>
  );
}

interface RowProps {
  name: ReactNode;
  /** The name's id, for a control to be labelled by — a switch is a <button>,
   *  whose name would otherwise be the empty knob inside it. */
  nameId?: string;
  note?: ReactNode;
  noteId?: string;
  /** What sits on the right: a switch, a select, a button, a read-out. */
  control?: ReactNode;
  /** "div" for a row that is not one control's label (see the header). */
  as?: "label" | "div";
  /** For a row a search result jumps to, and nothing else. */
  settingId?: string;
  className?: string;
  /** Anything that spans the row under the name and the note: a picker, a
   *  confirmation, a status line. */
  children?: ReactNode;
}

export function SettingRow({ name, nameId, note, noteId, control, as = "label", settingId, className, children }: RowProps) {
  const Tag = as;
  return (
    <Tag className={className ? `settings-row ${className}` : "settings-row"} data-setting={settingId}>
      <span className="settings-row-name" id={nameId}>{name}</span>
      {note && <span className="settings-row-note" id={noteId}>{note}</span>}
      {control !== undefined && <span className="settings-row-control">{control}</span>}
      {children}
    </Tag>
  );
}
