// The Fork look's banner strip under the toolbar: a collision with another
// agent (sharp in the error colour, naming the file; quiet in the muted tier)
// and a detached HEAD, each only while it is true. The sentences are the deck
// look's own (GitViewParts.tsx); the strip is Fork's: 28px, its own surface,
// a 1px foot.
import type { ReactNode } from "react";

import { GvIcon } from "./GitViewParts";

export default function FkBanner({ collision, detached }: {
  /** The collision line, as the deck look words it, or null. */
  collision: ReactNode;
  /** HEAD is detached: its short SHA, and whether the folder is clean. */
  detached: { short: string; clean: boolean } | null;
}) {
  if (!collision && !detached) return null;
  return (
    <div className="fk-banner">
      {collision}
      {detached && (
        <p className="fk-banner-line">
          <GvIcon name="commit" size={14} />
          <span>HEAD is detached at <b>{detached.short}</b>, not on a branch.{detached.clean ? " The folder has no changes." : ""}</span>
        </p>
      )}
    </div>
  );
}
