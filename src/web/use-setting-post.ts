// The auto-switch settings' own failure line.
//
// The policy's settings live in a 320-wide popover that is drawn over the
// panel, and a refusal said at the foot of the column was drawn under it, where
// nobody was looking. A press made inside the popover says its refusal inside
// the popover instead: this wraps the panel's auto-switch POST so those presses
// — the threshold, the next account, the switch in the popover — hand their
// failure to a line the popover draws, and the row's own switch keeps the
// panel's.
import { useCallback, useRef, useState } from "react";

import { type Failure } from "./accounts-reload";

/** Where a failed request says so. */
export type Say = (f: Failure | null) => void;

export function useSettingPost<R>(post: (body: Record<string, unknown>, tag: string, say?: Say) => Promise<R>) {
  const [settingFailure, setSettingFailure] = useState<Failure | null>(null);
  // The latest post, read at the press, so the wrapper below can stay one
  // function for as long as the panel lives.
  const postRef = useRef(post);
  postRef.current = post;
  /** The same POST, whose refusal is the popover's. */
  const settingPost = useCallback(
    (body: Record<string, unknown>, tag: string) => postRef.current(body, tag, setSettingFailure),
    [],
  );
  const clearSettingFailure = useCallback(() => setSettingFailure(null), []);
  return { settingFailure, settingPost, clearSettingFailure };
}
