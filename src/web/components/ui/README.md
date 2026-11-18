# Shared form controls

Start with `Button` and `Input`, used in New session. These are local adaptations
of the MIT-licensed [shadcn/ui new-york controls](https://github.com/shadcn-ui/ui/tree/main/apps/www/registry/new-york/ui).
The source belongs in this repository, following shadcn/ui's copy-and-adapt model.
Upstream attribution and licence are in `THIRD_PARTY_NOTICES.md`.

The visual recipes use `styles/ui-controls.css` and ccdeck's existing semantic
tokens instead of Tailwind utilities. They require no runtime package, new theme,
global reset or font. Keep existing native input semantics, refs and focus rings.
This is a scoped manual integration, not a CLI/Tailwind installation: do not run
`shadcn init` over the app's stylesheet. Review future registry components before
adapting them; add their dependencies and licence notices only when used.

Use `Button`'s `outline`, `primary` and `ghost` variants, and its `icon` size for
named icon-only controls. New controls must work with all JSON theme palettes,
keyboard focus, reduced motion and forced colours. Migrate other windows only
as part of work on those windows; do not restyle unrelated screens here.
