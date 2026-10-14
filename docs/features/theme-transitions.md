# Theme switching

All color themes share a 180 ms palette fade, whether chosen in Settings,
with the radio group's arrow keys, or with T. Layout and focus stay in place.
The first paint and a click on the already requested theme do not animate.

The browser captures the old deck and reveals the complete new deck above it.
This keeps the canvas, SVG, controls and CSS colors together rather than
interpolating their palettes independently. No animation library is added.

`theme-transition.ts` owns capture and cancellation. A new request skips the
previous transition; a revision guard prevents the skipped transition's delayed
update callback from restoring an older theme. `use-appearance.ts` resolves
functional requests against the latest intent, synchronously commits the theme,
and applies its DOM attributes and canvas palette in a layout effect before the
browser captures the new view.

Reduced motion, hidden documents and browsers without the API switch directly.
The CSS also removes the fade if reduced motion becomes active mid-transition.
Browser capture failures do not discard the user's choice.

## Verification

- Typecheck, production build and 182 relevant tests passed under Node 22.
- Browser checks observed the 0.18 s animation and intermediate opacity frames.
- Rapid clicks, repeated arrow presses and repeated T presses preserved the last
  theme, selected radio and focus; T also worked outside Settings.
- Verified immediate fallback for reduced motion and a missing API, no-op
  selection, persistence after reload, and no animation during initial mounting.
- Verified 320px and 390px viewports without horizontal overflow.
- Theme DOM attributes, canvas palette and window theme-color were synchronized
  before the new snapshot; no application warnings or unhandled rejections were
  observed during the desktop checks.

References: [Document.startViewTransition](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition),
[skipTransition](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/skipTransition),
[React flushSync](https://react.dev/reference/react-dom/flushSync).
