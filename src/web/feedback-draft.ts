// A report written and not yet sent outlives the dialog it was written in.
//
// The dialog is drawn only while it is open, so everything in it — the kind,
// the message, the contact, the screenshots — went the moment it closed, and a
// person who closed it to take another screenshot, to check something, or by a
// stray Escape opened it again on an empty form. What it holds is now kept here
// as it changes and handed back when it opens again, until the report is sent,
// or the person discards it from the dialog's foot. A send that fails, or is
// cancelled by closing, keeps it.
//
// ONE DRAFT PER DOOR. The topbar, the rating banner's offer and every other
// blank open share one draft; a report opened seeded with words of its own —
// an account issue, a crash — keeps its own, so reporting one thing never
// shows, or overwrites, a message about another. A draft is kept only while it
// holds something its seed did not: words, a contact, an image. A kind picked
// and nothing written is not a draft. At most MAX_DRAFTS are kept, the oldest
// let go first.
//
// HOW LONG. All of it stays in memory for as long as the page is open. The
// words — kind, message, contact — are also written to sessionStorage, so a
// reload of the tab keeps them, and closing the tab forgets them. The images
// are not: a screenshot can be megabytes and the storage holds a few. A draft
// brought back by a reload knows how many images it had, and the dialog says,
// in one quiet line, that they have to be added again.
import { BODY_MAX, CONTACT_MAX, KINDS, type FeedbackPrefill, type Kind } from "./feedback";
import { MAX_IMAGES } from "./feedback-images";
import type { KeptImages } from "./use-feedback-images";

export const DRAFTS_STORAGE_KEY = "agent-dag.feedbackDrafts";
export const MAX_DRAFTS = 4;

/** What a dialog opens on when it has no draft: what its opener seeded it with. */
export interface FeedbackSeed { kind: Kind; body: string }

export function feedbackSeed({ initialKind, initialBody }: FeedbackPrefill): FeedbackSeed {
  return { kind: initialKind ?? "bug", body: initialBody ?? "" };
}

/** Which draft a dialog opened on `seed` reads and writes. */
export function draftKey(seed: FeedbackSeed): string {
  return JSON.stringify([seed.kind, seed.body]);
}

/** Everything a dialog holds that a draft keeps. */
export interface DraftContent { kind: Kind; body: string; contact: string; images: KeptImages }

/** A draft handed back to a dialog that opens. */
export interface KeptDraft extends DraftContent {
  /** The images it had before the page reloaded, which did not come back. */
  imagesLost: number;
}

export function imageCount(images: KeptImages): number {
  return images.ready.length + images.waiting.length;
}

/** Whether there is anything to keep, or to discard: words the seed did not
 *  have, a contact, or an image. */
export function holdsSomething(draft: { body: string; contact: string; images: number }, seed: FeedbackSeed): boolean {
  return draft.body.trim() !== seed.body.trim() || draft.contact.trim() !== "" || draft.images > 0;
}

/** The quiet line a draft brought back by a reload shows in place of its images. */
export function imagesLostLine(count: number): string {
  return count === 1
    ? "The screenshot was not kept through the page reload. Add it again to send it."
    : `The ${count} screenshots were not kept through the page reload. Add them again to send them.`;
}

export const DISCARD_LABEL = "Discard";
export const DISCARD_ARMED_LABEL = "Confirm discard";
export const DISCARD_TITLE = "Clear the message, the screenshots and the contact";
export const DISCARD_ARMED_TITLE = "Press again to clear this draft. It cannot be brought back.";

interface Entry {
  kind: Kind;
  body: string;
  contact: string;
  /** Null for a draft read back after a reload, whose images stayed behind. */
  images: KeptImages | null;
  imageCount: number;
}

/** What sessionStorage holds for one draft: the words and how many images. */
interface Stored { kind: Kind; body: string; contact: string; images: number }

const NO_IMAGES: KeptImages = { ready: [], waiting: [] };

/** One draft as sessionStorage gave it back, or null for anything that is not
 *  one — an older shape, a hand edit, a value over the dialog's own limits. */
export function parseStoredDraft(item: unknown): [string, Stored] | null {
  if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") return null;
  const value = item[1] as Partial<Stored> | null;
  if (!value || typeof value !== "object") return null;
  const { kind, body, contact, images } = value;
  if (!KINDS.some(k => k.value === kind)) return null;
  if (typeof body !== "string" || body.length > BODY_MAX) return null;
  if (typeof contact !== "string" || contact.length > CONTACT_MAX) return null;
  if (typeof images !== "number" || !Number.isInteger(images) || images < 0 || images > MAX_IMAGES) return null;
  return [item[0], { kind: kind as Kind, body, contact, images }];
}

export interface DraftStore {
  read(key: string): KeptDraft | null;
  /** Keeps `draft` under `key`, or lets it go when it holds nothing `seed` did not. */
  keep(key: string, draft: DraftContent, seed: FeedbackSeed): void;
  forget(key: string): void;
}

/** A store over `storage`, read the first time a draft is asked for. Every
 *  read and write of the storage may throw — a private window, storage turned
 *  off — and the drafts then live in memory alone. */
export function createDraftStore(storage: () => Storage | null): DraftStore {
  let entries: Map<string, Entry> | null = null;

  function all(): Map<string, Entry> {
    if (entries) return entries;
    entries = new Map();
    try {
      const raw = storage()?.getItem(DRAFTS_STORAGE_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) {
        for (const item of list.slice(-MAX_DRAFTS)) {
          const parsed = parseStoredDraft(item);
          if (parsed) entries.set(parsed[0], { ...parsed[1], images: null, imageCount: parsed[1].images });
        }
      }
    } catch {}
    return entries;
  }

  function write() {
    try {
      const target = storage();
      if (!target) return;
      const list = [...all()].map(([key, e]): [string, Stored] =>
        [key, { kind: e.kind, body: e.body, contact: e.contact, images: e.imageCount }]);
      if (list.length === 0) target.removeItem(DRAFTS_STORAGE_KEY);
      else target.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(list));
    } catch {}
  }

  function forget(key: string) {
    if (all().delete(key)) write();
  }

  return {
    read(key) {
      const e = all().get(key);
      if (!e) return null;
      return {
        kind: e.kind, body: e.body, contact: e.contact,
        images: e.images ?? NO_IMAGES,
        imagesLost: e.images ? 0 : e.imageCount,
      };
    },
    keep(key, draft, seed) {
      const count = imageCount(draft.images);
      if (!holdsSomething({ body: draft.body, contact: draft.contact, images: count }, seed)) {
        forget(key);
        return;
      }
      const map = all();
      map.delete(key);
      map.set(key, { kind: draft.kind, body: draft.body, contact: draft.contact, images: draft.images, imageCount: count });
      for (const oldest of map.keys()) {
        if (map.size <= MAX_DRAFTS) break;
        map.delete(oldest);
      }
      write();
    },
    forget,
  };
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The page's drafts. */
export const feedbackDrafts = createDraftStore(sessionStore);
