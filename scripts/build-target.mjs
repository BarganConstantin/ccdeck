// What the web bundle is compiled down to, shared by vite.config.ts and the
// test that holds it.
//
// Vite's own default is es2020, and at es2020 esbuild 0.25 has to lower `||=`.
// It miscompiles one shape of that lowering: `let r; f(r ||= {})`, with `r`
// read nowhere else, comes out as `f(void 0 || (n = {}))` — the declaration
// gone and the assignment left on a name nothing declares. xterm's DECRQM
// handler (requestMode) is written exactly that way, so the first time a TUI
// asked which modes the terminal supports — Claude Code does it on start — the
// write threw `ReferenceError` and the pane froze on its splash.
//
// ES2021 has `||=` natively, so nothing is lowered and nothing is lost. Every
// browser the deck supports had it before this target was set: Chrome and
// Edge 85, Firefox 79, Safari 14.
export const BUILD_TARGET = ["es2021", "chrome87", "edge88", "firefox79", "safari14"];
