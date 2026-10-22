// A person's or a project's picture from a connected tracker (#2178, #2179),
// with the initials standing in when there is no picture or it does not load.
// The address is the deck's own asset route, which reads the picture from the
// tracker's site or its public image hosts (and refuses anything else).
//
//   <IntegrationAvatar src name size? you? className? />        one face
//   <IntegrationPerson src name size? you? nameless? />          a face and a name
//   <IntegrationAvatarStack people={[{ key, name, src, you? }]} max?=3 size? label? />
//   <UnassignedAvatar size? />                                  nobody yet
//
// One person for Jira and the forges, which had two (two initials in --text
// that grow with the text size, and one initial in a fixed 10px of --muted
// that fell under AA). A picture that fails once is drawn as initials from
// then on, without being asked for again on every page. `you` rings the
// reader's own face in the accent, initials included, since a face alone does
// not say "mine". A stack shows `max` faces then "+N"; two pictures overlap by
// 4px, the later cut away round the earlier so the gap is whatever the row
// behind them is (resting, hovered or chosen), and initials never overlap, so
// they stay letters. The empty face for nobody has a 3:1 edge in every theme.
// Faces are hidden from a screen reader: the name beside them, or the stack's
// label, says who.
import { useEffect, useState, type CSSProperties } from "react";
import { initials } from "../integrations/client";

// Pictures the deck could not fetch: a self-managed tracker may serve them
// only to a signed-in browser.
const failedAvatars = new Set<string>();

function faceStyle(size: number): CSSProperties {
  return { width: size, height: size, ["--ig-avatar-size" as string]: `${size}px` };
}

export default function IntegrationAvatar({ src, name, size = 20, you = false, className = "" }: {
  src: string | null | undefined;
  name: string;
  size?: number;
  /** The reader's own face: ringed in the accent. */
  you?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => !!src && failedAvatars.has(src));
  useEffect(() => setFailed(!!src && failedAvatars.has(src)), [src]);
  const style = faceStyle(size);
  const mine = you || undefined;
  if (!src || failed) {
    return <span className={`ig-avatar ig-avatar-initials ${className}`.trim()} data-large={size >= 28 || undefined} data-you={mine}
      style={style} aria-hidden>{initials(name)}</span>;
  }
  return <img className={`ig-avatar ${className}`.trim()} style={style} src={src} alt="" aria-hidden referrerPolicy="no-referrer"
    loading="lazy" decoding="async" draggable={false} data-you={mine}
    onError={() => { failedAvatars.add(src); setFailed(true); }} />;
}

/** The face for nobody: an empty ring, edged at 3:1 so it is still a place. */
export function UnassignedAvatar({ size = 20 }: { size?: number }) {
  return <span className="ig-avatar ig-avatar-none" style={faceStyle(size)} aria-hidden />;
}

/** A face and a name. `nameless` keeps the name for a screen reader and a
 *  tooltip only, where the row has no room for it. */
export function IntegrationPerson({ src, name, size = 20, you = false, nameless = false }: {
  src: string | null | undefined;
  name: string;
  size?: number;
  you?: boolean;
  nameless?: boolean;
}) {
  return (
    <span className="ig-person" title={nameless ? name : undefined}>
      <IntegrationAvatar src={src} name={name} size={size} you={you} />
      {nameless ? <span className="vis-hidden">{name}</span> : <span className="ig-person-name">{name}</span>}
    </span>
  );
}

export interface StackPerson {
  key: string;
  name: string;
  src: string | null | undefined;
  you?: boolean;
}

/** "Ana, Ben and 2 others": who a stack holds, in words. */
export function stackLabel(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Up to `max` faces, then "+N". `label` says what the people are ("Assigned
 *  to"); the stack is one image to a screen reader, named with every name. */
export function IntegrationAvatarStack({ people, max = 3, size = 20, label }: {
  people: StackPerson[];
  max?: number;
  size?: number;
  label?: string;
}) {
  if (!people.length) return null;
  const names = people.map(p => p.name);
  const shown = people.length > max ? people.slice(0, max) : people;
  const more = people.length - shown.length;
  const all = stackLabel(names);
  return (
    <span className="ig-stack" role="img" aria-label={label ? `${label} ${all}` : all} title={names.join(", ")}>
      {shown.map(p => <IntegrationAvatar key={p.key} src={p.src} name={p.name} size={size} you={p.you} />)}
      {more > 0 && <span className="ig-stack-more" aria-hidden>+{more}</span>}
    </span>
  );
}
