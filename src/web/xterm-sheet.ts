// xterm's own stylesheet, as a module of its own so that it can be imported
// the way xterm itself is: dynamically, by use-terminal-session.ts's
// mountXterm, in the same breath as the library.
//
// WHY NOT A STATIC IMPORT IN THE STAGE. The stage is the lazy chunk's entry,
// and a stylesheet imported there makes the lazy chunk one with a CSS
// dependency. The page's entry chunk then has to carry Vite's dependency map
// for it (`__vite__mapDeps`) ahead of everything else, which is a change to
// the chunk every visit loads, made for a feature most visits never open —
// and notices-bundle.test.ts reads the entry chunk's opening as Vite's own
// preload polyfill. Imported from here instead, the sheet is a dependency of
// the import that fetches xterm, inside the lazy chunk, and the entry chunk is
// exactly what it was. It also lands when it is needed: Vite resolves a
// dynamic import only once its stylesheet has loaded, so xterm measures its
// glyphs with its own rules already applied.
import "@xterm/xterm/css/xterm.css";
