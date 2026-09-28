// A deck's own dialog as a list of files, for the assertions that count what
// it says or say what it never does.
//
// LanPeerModal.tsx is being taken apart one concern at a time: what it says
// about the machine moved to lan-peer.ts, and the picture to LanPeerMap.tsx.
// A positive assertion reads whichever file now owns the code. A negative or
// a count asked of the component alone passes vacuously, or counts short, the
// moment the code it is about moves out — so those read every file here. A
// file lifted out of the dialog is added in the same change.
//
// A list rather than one joined string, because the tests that read the
// dialog strip comments file by file, and a block-comment pattern must not be
// able to run from one file into the next.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The dialog and what was lifted out of it, relative to `src/web`. */
export const LAN_PEER_FILES = [
  "components/LanPeerModal.tsx",
  "lan-peer.ts",
  "components/LanPeerMap.tsx",
  "use-peer-unpair.ts",
  "components/LanPeerTwins.tsx",
] as const;

/** Every file in LAN_PEER_FILES, raw, each passed through `strip` and joined by
 *  a newline. */
export function lanPeerSurface(strip: (src: string) => string = s => s): string {
  return LAN_PEER_FILES.map(rel => strip(readFileSync(`${WEB_DIR}${rel}`, "utf8"))).join("\n");
}
