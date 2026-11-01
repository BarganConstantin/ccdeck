// Every catalog file, found by folder.
//
// Each UI AREA owns a folder, areas/<area>/, with one file per language
// (en.ts, zh-TW.ts, ...). The files are collected here with import.meta.glob,
// so adding an area or a language file needs no edit to a shared list, and two
// people translating two areas never touch the same file. A language's whole
// catalog is its area files merged; a key starts with its area's name
// ("usage.title"), which is what keeps the areas from ever colliding (the test
// in i18n.test.ts fails on a key outside its area, or in two).
//
// import.meta.glob is vite's, and vitest runs through vite, so the app, the
// tests and the build all read the same files.

/** One language's strings: key -> text. */
export type Catalog = Readonly<Record<string, string>>;

const modules = import.meta.glob<{ default: Catalog }>("./areas/*/*.ts", { eager: true });

export interface AreaFile {
  area: string;
  /** The file's language code: en, zh-TW, ... */
  code: string;
  path: string;
  catalog: Catalog;
}

/** Every area file, in path order. */
export const AREA_FILES: readonly AreaFile[] = Object.keys(modules).sort().flatMap(path => {
  const m = /^\.\/areas\/([^/]+)\/([^/]+)\.ts$/.exec(path);
  return m ? [{ area: m[1], code: m[2], path, catalog: modules[path].default ?? {} }] : [];
});

/** The areas, from the folders that exist. */
export const AREAS: readonly string[] = [...new Set(AREA_FILES.map(f => f.area))];

const merged = new Map<string, Catalog>();

/** A language's whole catalog: its area files merged. A language with no files
 *  is an empty catalog, so everything falls back to English. */
export function catalogFor(code: string): Catalog {
  let hit = merged.get(code);
  if (!hit) {
    hit = Object.assign({}, ...AREA_FILES.filter(f => f.code === code).map(f => f.catalog)) as Catalog;
    merged.set(code, hit);
  }
  return hit;
}
