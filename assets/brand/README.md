# Brand files

Every logo, icon and brand colour this repository ships is a file copied
unchanged from the ccdeck brand kit. `kit.json` beside this file is the record:
the kit version they were copied from (the one place it is written), every kit
file, each place in the repo it serves, and its SHA-256. The kit itself is not
in this repository; only the files the product uses are.

## The rules

1. **Never recreate the logo.** No redrawing it in CSS, canvas, hand-written SVG,
   an emoji or text. Use the kit's files.
2. **No other gradients.** The mark's purple to cyan is the only one, and it lives
   inside the kit's artwork. No gradient on a background, a button or text in the
   brand's name.
3. **One file per context.** Each slot below has a dedicated kit file; use it.
4. **Never shrink the app icon for the tray**, and **never take the big mark down
   to 16px**: from 16 to 24px use the `*-small-optical` master.
5. **The macOS menu bar is monochrome** (template images, tinted by macOS).
6. **Status is an overlay on an unchanged mark, never a recolouring.**
7. **SVG first** wherever the platform renders it; the PNGs are raster copies of
   the same artwork.
8. The name is **ccdeck**, lowercase, in text and in alt text. The kit's own text
   files spell it otherwise, which is why none of them is copied; this repo keeps
   its own manifest.

## Which file serves which slot

| Slot | File in this repo | Kit file |
|---|---|---|
| Tab favicon at rest; the mark every tab state is drawn on | `src/web/public/favicon.svg` (linked), `assets/brand/favicon.svg` (read by `src/web/brand-kit.ts`) | `05-web/favicon.svg` |
| Favicon fallback for browsers without SVG favicons | `src/web/public/favicon.ico` | `05-web/favicon.ico` |
| iOS home-screen icon | `src/web/public/apple-touch-icon.png` | `05-web/apple-touch-icon.png` |
| Installed app (PWA) icons, and the page's OS notification | `src/web/public/icon-192.png`, `icon-512.png` | `05-web/icon-192.png`, `icon-512.png` |
| Installed app, maskable (Android and any platform that masks the tile) | `src/web/public/icon-maskable-512.png` | `05-web/icon-maskable-512.png` |
| Topbar mark beside the typed `ccdeck`, at 16px | `src/web/public/brand/ccdeck-mark-gradient-small-optical.svg` | `01-brand-mark/svg/ccdeck-mark-gradient-small-optical.svg` |
| README hero on a dark GitHub theme; the social card | `assets/brand/ccdeck-horizontal-on-dark.svg` | `02-wordmark/svg/ccdeck-horizontal-on-dark.svg` |
| README hero on a light theme, and its fallback | `assets/brand/ccdeck-horizontal-on-light.svg` | `02-wordmark/svg/ccdeck-horizontal-on-light.svg` |
| Tab favicon overlays: waiting, running, offline | `assets/brand/ccdeck-tray-{waiting,syncing,error}.svg` | `04-tray-menu/generic/svg/ccdeck-tray-{waiting,syncing,error}.svg` |
| The overlays' status colours | `assets/brand/brand-tokens.json` | `06-tokens/brand-tokens.json` |
| Desktop app icon and tray | see `desktop/brand/README.md` | |

The terminal banner (`src/server/wordmark.mjs`) is not a kit slot: the kit has no
terminal form, so it stays product text.

### The tab favicon's states

The kit has no favicon with state, so the tab composes two kit files at run time
(`src/web/ambient.ts`): the favicon, unchanged, plus the overlay elements the
kit's tray master draws for the state, copied element for element into the
favicon's own frame for the mark, in the kit's status colour. Idle wears the
favicon alone (the kit's default), waiting the kit's waiting dot, running its
syncing arc, offline its error ring; the kit's paused is unused. The tab title's
`(n) ccdeck` carries the waiting count beside it.

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
  re-shoot it with the recipe in `assets/canvas-demo.mjs`.
- The two crops of the lockup (below): re-measure them, or drop them if the new
  lockup has no empty tail.

`npm run build` picks the rest up: the favicon states, the topbar mark and the
icons are read from the copies.

## Kit defects worked around

Each is a workaround for the kit as copied; drop it when a kit fixes the cause.

- **The horizontal lockup's artwork ends two thirds of the way across its
  viewBox** (near x 293 of 430). The files stay as delivered; the README crops
  them with an `#svgView(viewBox(0,0,304,100))` fragment on the image URL (GitHub
  strips CSS, and its sanitizer cuts a `srcset` at a raw comma, so the commas are
  written `%2C`), and the social card crops them with a clipping box. 304 keeps
  the artwork plus the clear space the lockup leaves on its left.
- **The kit's favicon snippet declares the ICO `sizes="any"`.** Chrome then shows
  the ICO and keeps it after the SVG link's href changes, so the tab would never
  show a state. `index.html` declares the ICO's real `32x32`.
- **The kit's web manifest names the product with capitals**, and paints the app
  chrome in the kit's neutral. The repo keeps its own manifest, which names the
  kit's three PNGs, as the kit's does.
- **The tray masters' knockout mask has no `maskUnits`**, which shaves the outer
  curves in WebKit. The web takes only the overlay elements, which sit outside
  the mask, so it is unaffected.
- **The kit's monochrome tray PNGs are cut off.** None of them is used here.

Skipped on purpose: the kit's Safari pinned-tab icon and `browserconfig.xml`,
both for platforms that no longer use them.
