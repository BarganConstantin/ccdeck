// The brand kit's files that code reads, rather than links. They are the
// copies vendored under assets/brand/ (kit.json lists each one and where it
// serves), inlined by Vite at build time, so a new kit copied in with
// assets/brand/kit.mjs reaches the page with no edit here. Nothing in this
// file is drawn: the strings are the kit's files, byte for byte.
import favicon from "../../assets/brand/favicon.svg?raw";
import trayWaiting from "../../assets/brand/ccdeck-tray-waiting.svg?raw";
import traySyncing from "../../assets/brand/ccdeck-tray-syncing.svg?raw";
import trayError from "../../assets/brand/ccdeck-tray-error.svg?raw";
import tokens from "../../assets/brand/brand-tokens.json";

/** The tray states the tab borrows an overlay from. */
export type KitStatus = "waiting" | "syncing" | "error";

/** 05-web/favicon.svg, the same file index.html links as the tab's icon. */
export const KIT_FAVICON_SVG: string = favicon;

/** 04-tray-menu/generic/svg/ccdeck-tray-<state>.svg: the mark, and the state's overlay beside it. */
export const KIT_TRAY_SVG: Readonly<Record<KitStatus, string>> = {
  waiting: trayWaiting,
  syncing: traySyncing,
  error: trayError,
};

/** 06-tokens/brand-tokens.json, the kit's status colours. */
export const KIT_STATUS_COLOUR: Readonly<Record<KitStatus, string>> = {
  waiting: tokens.status.waiting,
  syncing: tokens.status.syncing,
  error: tokens.status.error,
};
