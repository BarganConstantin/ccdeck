// The tab's state icons, held in the page so a state change never waits on
// the deck.
//
// Since the brand kit each state is a file the deck serves (ambient.ts), and
// the writer used to point the tab's links at those paths when the state
// changed. That is a request to the deck at every change, and for one state it
// is a request that cannot succeed: offline is shown when the event stream has
// failed, which is most often the deck's process gone. The offline mark was
// first asked for at that moment, from the server that had just gone away, and
// the tab kept the icon it had — the waiting mark beside `(1) ccdeck`, the pair
// #719 removed. The files are not hashed, so static-cache.mjs serves them
// no-cache and the HTTP cache cannot answer for them either.
//
// So each state's file is fetched once while the deck is up and kept as a
// data: URL, the way the marks were inline before the kit. A data: URL is the
// one href every browser draws as a favicon with no request at all. Until a
// file is held, its path is handed out unchanged, which is what the tab did
// before.
import { FAVICON_FALLBACK_HREF, FAVICON_HREF } from "./ambient";

/** Every href the tab's writer can hand either link, once each. */
export const TAB_ICON_HREFS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(FAVICON_HREF), ...Object.values(FAVICON_FALLBACK_HREF)]),
]);

const held = new Map<string, string>();

/** What to put on the link for `href`: the held copy, or the path itself. */
export function tabIconHref(href: string): string {
  return held.get(href) ?? href;
}

/** Fetch each of `hrefs` not yet held and keep it as a data: URL. A failed
 *  request, or an answer that is not an image (the SPA fallback's page), holds
 *  nothing and is tried again on the next call. Never rejects. */
export async function holdTabIcons(
  hrefs: readonly string[],
  fetchImpl: (href: string) => Promise<Response> = href => fetch(href),
): Promise<void> {
  await Promise.all(hrefs.map(async href => {
    if (held.has(href)) return;
    try {
      const res = await fetchImpl(href);
      const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim();
      if (!res.ok || !type.startsWith("image/")) return;
      held.set(href, `data:${type};base64,${base64(new Uint8Array(await res.arrayBuffer()))}`);
    } catch { /* the deck did not answer; the path stays in use until it does */ }
  }));
}

/** The kit's icons are a couple of kilobytes each, so one pass over the bytes
 *  is all this needs. */
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Tests only: forget every held icon. */
export function _forgetHeldIcons(): void {
  held.clear();
}
