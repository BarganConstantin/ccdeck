// A person's or a project's picture from a connected tracker (#2178), with the
// initials standing in when there is no picture or it does not load. The
// address is the deck's own asset route, which reads the picture from the
// tracker's site or its public image hosts (and refuses anything else).
import { useEffect, useState } from "react";
import { initials } from "../integrations/client";

export default function IntegrationAvatar({ src, name, size = 20, className = "" }: {
  src: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const style = { width: size, height: size };
  if (!src || failed) {
    return <span className={`ig-avatar ig-avatar-initials ${className}`.trim()} data-large={size >= 28 || undefined} style={style} aria-hidden>{initials(name)}</span>;
  }
  return <img className={`ig-avatar ${className}`.trim()} style={style} src={src} alt="" aria-hidden referrerPolicy="no-referrer"
    loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}
