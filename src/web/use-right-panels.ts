// The three panels on the right that remember whether they were open: the
// detail panel, Usage and Machine. Each flag is read from the browser once, when
// the deck mounts, and written back whenever it changes.
//
// Moved out of App.tsx unchanged: the keys, the defaults, the loaders its
// useState initialisers ran and the effects that wrote each flag, which were
// spread between the top of the file and three places in `Inner`. Unlike the
// left column (use-left-column.ts) there is no rule between the three: each
// opens and closes on its own, so the setters are React's own and go out as
// they are. The one exception is a phone's load, where Usage keeps the machine
// panel shut for that load alone (phone-load.ts).
import { useEffect, useRef, useState } from "react";
import { readStored, writeStored } from "./storage";
import { useFeatureUse } from "./feature-use";
import { loadsOnPhone } from "./phone-load";

const DETAIL_OPEN_KEY = "agent-dag.detailOpen";
const USAGE_PANEL_OPEN_KEY = "agent-dag.usagePanelOpen";
/** Named for the panel it opens rather than for the button, which is how it
 *  survived the button changing: this key was written by a topbar meter that
 *  no longer exists, and a tab that had the panel open still finds it open. */
const MACHINE_PANEL_OPEN_KEY = "agent-dag.systemPanelOpen";
// First-run layout: Usage and Accounts open, everything else closed. Those two
// answer "how much have I got left, and on which account" — the questions you
// have before you have a graph worth looking at. The session list and detail
// panel are for navigating work that already exists, so they stay shut until
// asked for, and the canvas gets the width. A phone's load opens one sheet of
// these at most, and stores nothing for the rest: phone-load.ts.
//
// All three panels read and write through storage.ts rather than
// window.localStorage directly: the loaders run inside useState initialisers,
// and the property read throws outright on a browser that blocks site data,
// which takes App's first render with it.
function loadDetailOpen(): boolean {
  return readStored(DETAIL_OPEN_KEY) === "1";
}
function saveDetailOpen(open: boolean): void {
  writeStored(DETAIL_OPEN_KEY, open ? "1" : "0");
}
function loadUsagePanelOpen(): boolean {
  const stored = readStored(USAGE_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}
function saveUsagePanelOpen(open: boolean): void {
  writeStored(USAGE_PANEL_OPEN_KEY, open ? "1" : "0");
}
/**
 * Whether the machine panel was open when this tab was last looked at.
 *
 * OPEN ON A FIRST RUN, and never reopened after that — the same shape the
 * usage and accounts panels already use. This used to default to closed, on
 * the argument that "a machine readout that reopens itself on every refresh
 * would be occupying the rail on behalf of a decision nobody made". That
 * argument is about REOPENING, and the null check is exactly what prevents it:
 * a tab that has never expressed a preference gets the panel, and a tab that
 * has closed it once has expressed one and keeps it closed for good.
 *
 * The two cases were worth separating because they answer different people. A
 * first run is somebody who has not met the deck yet and cannot ask for a
 * panel they do not know is there; every run after that is somebody who has,
 * and whose answer is on record. Opening it starts the /api/system poll, which
 * stops with the panel and while the tab is hidden.
 */
function loadMachinePanelOpen(): boolean {
  const stored = readStored(MACHINE_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}
function saveMachinePanelOpen(open: boolean): void {
  writeStored(MACHINE_PANEL_OPEN_KEY, open ? "1" : "0");
}

export function useRightPanels() {
  /** Right detail panel visibility — persisted across refresh. */
  const [detailOpen, setDetailOpen] = useState<boolean>(loadDetailOpen);
  useEffect(() => { saveDetailOpen(detailOpen); }, [detailOpen]);
  /** Usage panel visibility — persisted across refresh. */
  const [usagePanelOpen, setUsagePanelOpen] = useState<boolean>(loadUsagePanelOpen);
  useEffect(() => { saveUsagePanelOpen(usagePanelOpen); }, [usagePanelOpen]);
  /** Shut for this load, not by the reader: a phone's load opens one sheet, and
   *  Usage is it (phone-load.ts). Never written as a close; the reader's own
   *  open ends it. */
  const machineHeldRef = useRef(false);
  const [machinePanelOpen, setMachinePanelOpen] = useState<boolean>(() => {
    const wanted = loadMachinePanelOpen();
    if (wanted && usagePanelOpen && loadsOnPhone()) { machineHeldRef.current = true; return false; }
    return wanted;
  });
  useEffect(() => {
    if (machinePanelOpen) machineHeldRef.current = false;
    else if (machineHeldRef.current) return;
    saveMachinePanelOpen(machinePanelOpen);
  }, [machinePanelOpen]);
  // A panel shown is one of the features the usage reports name (feature-use.ts).
  // Not the detail panel: its flag is kept and the selection is not, so after a
  // reload it is on with nothing drawn. DetailAside says it, when it mounts.
  useFeatureUse("usage-panel", usagePanelOpen);
  useFeatureUse("machine-panel", machinePanelOpen);
  return { detailOpen, setDetailOpen, usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen };
}
