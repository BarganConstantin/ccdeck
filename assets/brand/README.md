# Brand files

Every logo and icon this repository ships is a file copied unchanged from the
ccdeck brand kit. `kit.json` beside this file is the record: the kit version
they were copied from (the one place it is written), every kit file, each place
in the repo it serves, and its SHA-256. The kit itself is not in this
repository; only the files the product uses are.

The name and these files are not part of the AGPL-licensed work: see
[LICENSING.md, "Name and logo"](../../LICENSING.md#name-and-logo).

## The rules

1. **Never recreate the logo.** No redrawing it in CSS, canvas, hand-written SVG,
   an emoji or text. Use the kit's files.
2. **No other gradients.** The mark's own gradients are the only ones, and they
   live inside the kit's artwork. No gradient on a background, a button or text
   in the brand's name.
3. **One file per context.** Each slot below has a dedicated kit file; use it.
4. **Never shrink the app icon for the tray**, and **never take the big mark down
   to 32px or below**: up to 32px use the `*-small-optical` masters.
5. **The macOS menu bar is monochrome** (template images, tinted by macOS).
6. **Status is an overlay on an unchanged mark, never a recolouring.** The kit
   ships each state as its own file; swap the whole icon.
7. **SVG first** wherever the platform renders it; the PNGs are raster copies of
   the same artwork.
8. The name is **ccdeck**, lowercase, in text and in alt text. The wordmark is
   outlined paths; product chrome sets the name as text beside the small mark
   instead (below). This repo keeps its own web manifest and copies none of the
   kit's text files.

## Which file serves which slot

| Slot | File in this repo | Kit file |
|---|---|---|
| Tab favicon at rest (idle) | `src/web/public/favicon.svg`, fallback `favicon.ico` | `05-web/favicon.svg`, `05-web/favicon.ico` |
| Tab favicon, waiting | `src/web/public/state/favicon-waiting.svg`, fallback `-32.png` | `05-web/state/favicon-waiting.svg`, `-32.png` |
| Tab favicon, running | `src/web/public/state/favicon-syncing.svg`, fallback `-32.png` | `05-web/state/favicon-syncing.svg`, `-32.png` |
| Tab favicon, offline | `src/web/public/state/favicon-error.svg`, fallback `-32.png` | `05-web/state/favicon-error.svg`, `-32.png` |
| iOS home-screen icon | `src/web/public/apple-touch-icon.png` | `05-web/apple-touch-icon.png` |
| Installed app (PWA) icons, and the page's OS notification | `src/web/public/icon-192.png`, `icon-512.png` | `05-web/icon-192.png`, `icon-512.png` |
| Installed app, maskable | `src/web/public/icon-maskable-512.png` | `05-web/icon-maskable-512.png` |
| Topbar mark, dark theme | `src/web/public/brand/ccdeck-mark-gradient-small-optical.svg` | `01-brand-mark/svg/ccdeck-mark-gradient-small-optical.svg` |
| Topbar mark, light theme | `src/web/public/brand/ccdeck-mark-mono-dark-small-optical.svg` | `01-brand-mark/svg/ccdeck-mark-mono-dark-small-optical.svg` |
| README hero on a dark GitHub theme; the social card | `assets/brand/ccdeck-horizontal-on-dark.svg` | `02-wordmark/svg/ccdeck-horizontal-on-dark.svg` |
| README hero on a light theme, and its fallback | `assets/brand/ccdeck-horizontal-on-light.svg` | `02-wordmark/svg/ccdeck-horizontal-on-light.svg` |
| Desktop app icon and tray | see `desktop/brand/README.md` | |

The tab's states follow the owner's mapping: idle → the kit's default, waiting →
waiting, running → syncing, offline → error. The kit's paused has no state in the
deck and is not copied. `src/web/ambient.ts` names the file for each state, and
`src/web/use-tab-ambient.ts` swaps both icon links, as the kit's snippet does;
the tab title's `(n) ccdeck` carries the waiting count beside it.

The topbar follows the kit's pattern for product chrome: the small mark 16px
high (heights in multiples of 4, so its strokes land on whole pixels), the name
`ccdeck` as the page's `<h1>` in the UI font at weight 600 and 16px, 8px between
them; the light theme takes the mono-dark mark, because the gradient's aqua is
under 3:1 on white.

The terminal banner (`src/server/wordmark.mjs`) is not a kit slot: the kit has no
terminal form, so it stays product text. The kit's own social cards
(`05-web/social/`) are not used: `assets/social-preview.png` is drawn from
`assets/social-preview.html`, whose claims the README tests hold to the page.

## Copying a new kit

```bash
node assets/brand/kit.mjs <kit-dir>   # <kit-dir> holds the kit's VERSION and SHA256SUMS.txt
```

It copies every file `kit.json` lists, checks each against the kit's own
`SHA256SUMS.txt`, and rewrites `kit.json` with the kit's version and each copy's
hash; a file the kit no longer has stops it before anything is recorded. Run it
with no argument to re-record the hashes of the copies already here.
`src/web/__tests__/brand-kit.test.ts` fails when a copy and the record disagree.

Then regenerate what is drawn from the kit's files rather than copied:

- `assets/social-preview.png`, from `assets/social-preview.html` — headless
  Chrome at a device scale of 2 in a 1280x640 window, downscaled with `sips`:

  ```bash
  profile=$(mktemp -d); shot="$profile/card-2x.png"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
    --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1280,640 --user-data-dir="$profile" \
    --screenshot="$shot" "file://$PWD/assets/social-preview.html"
  sips -z 640 1280 "$shot" --out assets/social-preview.png
  ```

  from the repo root. The fresh profile matters: Chrome's own profile renders the
  card differently. Chrome can stay running once the screenshot is written; stop
  it then. Upload the PNG by hand in the repository's Settings, Social preview.
- `assets/canvas.png`, the README screenshot, which shows the topbar mark:

  ```bash
  npm run build && node assets/capture-hero.mjs
  ```

  from the repo root. It starts this checkout's deck in an empty home on the
  generated log of `assets/canvas-demo.mjs`, fakes in the page every read that
  would otherwise come from the machine it runs on (quota, usage, accounts,
  Local network), refuses a picture that shows a real path, name, address or
  e-mail, and writes the 3840x2160 PNG. Anyone can take it; nothing of yours is
  in it. `--serve` hands the same deck and page script to a browser you drive
  yourself; the header of `assets/capture-hero.mjs` says how.

`npm run build` picks the rest up: the tab states, the topbar marks and the icons
are served from the copies.

## Skipped on purpose

The kit's Safari pinned-tab icon and `browserconfig.xml` are for platforms that
no longer use them; its `site.webmanifest` is replaced by this repo's own
`src/web/public/manifest.webmanifest`, which names the kit's three PNGs and keeps
the deck's own chrome colours; the 16px state rasters and the paused state are
not used by the tab.
