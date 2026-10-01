// Globals injected by Vite's `define` config — see vite.config.ts.
declare const __APP_VERSION__: string;

// Vite's `?raw` import: the file's text, inlined at build time (brand-kit.ts).
declare module "*?raw" {
  const text: string;
  export default text;
}
