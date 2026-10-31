// The deck's language: one value for the whole page, like the single-key
// shortcuts switch (single-key-shortcuts.ts). It is read once from storage (or
// detected from the browser), held here, and told to every component that
// reads it, so changing it in Settings re-renders the page live, another tab of
// the deck follows through the storage event, and no Provider needs to wrap
// the tree.
//
//   const t = useT();            // in a component; re-renders on a change
//   t("usage.quota.window.days", { n: 7 })
//
// <html lang> and <html dir> follow the language (applyDocumentLanguage).
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "../storage";
import type { MessageKey } from "./en";
import { detectLanguage, knownLanguage } from "./detect";
import { DEFAULT_LANGUAGE, LANGUAGES } from "./registry";
import { translate, type Vars } from "./translate";

export type { MessageKey } from "./en";
export { LANGUAGES, languageLabel } from "./registry";

/** Where the choice is kept. Absent until the reader chooses: until then the
 *  language follows the browser. */
export const LANGUAGE_KEY = "agent-dag.language";

let current: string | null = null;
const listeners = new Set<() => void>();

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

function resolve(stored: string | null): string {
  return knownLanguage(stored) ?? detectLanguage(browserLanguages());
}

export function currentLanguage(): string {
  if (current === null) current = resolve(readStored(LANGUAGE_KEY));
  return current;
}

/** Writes <html lang> and <html dir> for the language on show. */
export function applyDocumentLanguage(code = currentLanguage()): void {
  if (typeof document === "undefined") return;
  const language = LANGUAGES.find(l => l.code === code);
  document.documentElement.lang = code;
  document.documentElement.dir = language?.dir ?? "ltr";
}

function announce(): void {
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}

export function setLanguage(code: string): void {
  const next = knownLanguage(code) ?? DEFAULT_LANGUAGE;
  if (next === current) return;
  current = next;
  writeStored(LANGUAGE_KEY, next);
  announce();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== LANGUAGE_KEY) return;
  const next = resolve(event.newValue);
  if (next === current) return;
  current = next;
  announce();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener?.("storage", onStorage);
  };
}

/** Test seam: forget the held value so the next read starts from storage. */
export function resetLanguageForTest(): void {
  current = null;
}

export type TFunction = (key: MessageKey, vars?: Vars) => string;

/** t() for the language on show right now (outside React: no live update). */
export function t(key: MessageKey, vars?: Vars): string {
  const code = currentLanguage();
  return translate(code, LANGUAGES.find(l => l.code === code)?.catalog, key, vars);
}

/** The language code, re-read when it changes. */
export function useLanguage(): string {
  // Some tests call a component as a plain function, with no React rendering
  // it, where a hook throws. There the language is simply read once, which is
  // all such a call can use. Inside React this never throws.
  try {
    return useSyncExternalStore(subscribeLanguage, currentLanguage, () => DEFAULT_LANGUAGE);
  } catch {
    return currentLanguage();
  }
}

/** t() bound to the language on show; a new function when the language
 *  changes, so a component using it re-renders. */
export function useT(): TFunction {
  const code = useLanguage();
  const catalog = LANGUAGES.find(l => l.code === code)?.catalog;
  return (key, vars) => translate(code, catalog, key, vars);
}
