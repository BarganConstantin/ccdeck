# The desktop app's brand files

Everything the desktop app shows as ccdeck — the app icon on macOS, Windows and Linux, and the tray on all
three — comes from this folder. `scripts/icons.mjs` copies these files into `dist/icons`, or packs them unchanged
into the container a platform asks for (an `.icns`, an `.ico`). Nothing in the build or the app draws the mark.

- `kit/` holds files **copied unchanged from the ccdeck brand kit v1.0.0**, each at the same relative path it has
  in the kit. `KIT_VERSION` in `scripts/icons.mjs` names that version.
- `rendered/` holds the macOS menu-bar templates, rendered from the kit's own masters because the kit's templates
  are cut off (see *Known kit defects*). They are the only files here that are not the kit's.

## The rules

1. **Never recreate the logo.** No mark drawn in code, CSS, canvas, hand-written SVG, an emoji or text. Use these
   files.
2. **No other gradients.** The mark's purple → cyan lives inside the kit's artwork and nowhere else.
3. **One asset per context.** Each slot below has a dedicated kit file; use that one.
4. **Never shrink the app icon for the tray.** The app icon has a launcher tile; the tray has its own glyphs.
5. **Never take the big mark down to 16 px.** From 16 to 24 px the kit's small-optical versions are used — which
   is what every tray file and the 16–48 px app icons already are.
6. **The macOS menu bar is monochrome.** It takes `*Template` images, black on transparent, and macOS tints them
   for a light or a dark bar. Never the gradient there, never a colour in a template.
7. **Status is an overlay, never a recolouring.** A state sits on top of an unchanged mark.
8. The name is **ccdeck**, lowercase, in text and alt text. The kit's own documents write it otherwise; never
   copy their text.

## Which file serves which slot

The tray states, on the same map the tab's favicon uses:

| Product state | Kit state | What it adds to the mark |
|---|---|---|
| idle | default | nothing |
| waiting | waiting | a dot, top right |
| running | syncing | a turning arrow, top right |
| offline | error | a ringed "!", top right |

The kit's fifth state, **paused**, has no product state behind it and is unused. On macOS the waiting count
stays beside the icon, as the tray's title.

| Slot | Written to `dist/icons` as | From |
|---|---|---|
| macOS app icon (Dock, Finder, ⌘-Tab, About panel, notifications) | `icon.icns` | `kit/03-app-icons/macos.iconset/`, every 1x and @2x entry, through `iconutil -c icns` (on a Mac only) |
| Windows app icon (exe, installer, taskbar, Start menu, toasts) | `icon.ico` | `kit/03-app-icons/windows/ccdeck.ico` |
| Linux app icon, hicolor 16–512 | `linux/<n>x<n>.png` | `kit/03-app-icons/linux/ccdeck-<n>.png`; 24 from `kit/03-app-icons/png/ccdeck-app-24.png` |
| The 1024 master in electron-builder's build resources | `icon.png` | `kit/03-app-icons/png/ccdeck-app-1024.png` |
| macOS menu bar | `tray-<state>Template.png` + `@2x` | `rendered/macos/ccdeck{,Waiting,Syncing,Error}Template{,@2x}.png`, 18 and 36 px |
| Windows tray, idle | `tray-idle.ico` | `kit/04-tray-menu/windows/ccdeck-tray.ico` |
| Windows tray, other states | `tray-<state>.ico` | `kit/04-tray-menu/windows/ccdeck-tray-<kit state>-{16,20,24,32,48,64}.png`, packed unchanged into an `.ico` with the entries the kit's own `ccdeck-tray.ico` has |
| Linux tray | `tray-<state>.png` + `@2x` | `kit/04-tray-menu/linux/ccdeck-tray-<kit state>-{32,64}.png` |

Why each platform takes the form it does:

- **macOS, 18 pt.** The kit draws its templates at 18 and 36. Electron takes the 1x file's pixel size as the
  image's size in points and loads the `@2x` beside it, and the menu-bar button draws an image that fits its bar
  without scaling it — so 18 px is 18 pt on screen, at the size the kit's masters were drawn for. The word
  `Template` in the file name is what makes Electron mark the image as a template.
- **Windows, an `.ico` for every state.** Electron's Windows tray asks the image for an icon at the small-icon size
  (`GetSystemMetrics(SM_CXSMICON)`: 16 at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %). From an `.ico`, Windows
  loads the entry made for that size; from a PNG, Electron hands over only the 1x bitmap and Windows scales it.
  The kit gives an `.ico` for the default state only, so each other state's own kit PNGs are packed into one —
  the same six sizes, in the same order, as the kit's (the kit's `.ico` is those PNGs packed, pixel for pixel).
- **Linux, 32 and 64.** Electron hands the StatusNotifierItem host a single image, the highest-resolution one it
  holds — the 64 — and the panel scales it to its slot. That is the pair the app has always handed the panel.
- **The Linux 24.** The kit's Linux launcher set has no 24, which hicolor declares and panels ask for. The kit's
  own 24 px app export is drawn for that size, like the 16, 32 and 48 in the set (which are byte-identical to the
  kit's 16, 32 and 48 exports), so it fills the gap rather than a scaled neighbour.

## Known kit defects, and what is done about them

The kit files under `kit/` stay exactly as delivered; the defects are worked around here, not edited away.

- **The macOS templates are cut off.** Every `04-tray-menu/macos/*Template*.png` in kit v1.0 draws the mark only
  in the top-left of its canvas — the 18 px default in a 2×2 pixel corner. They are not used. The templates in
  `rendered/` are rasterised from the kit's monochrome masters, `kit/04-tray-menu/generic/svg/`, at exactly 18
  and 36 px, never scaled from a larger render.
- **The masters' knockout mask cuts the outer curves.** The `<mask id="cut">` that leaves the centre node as a hole
  declares no `maskUnits`, so its region defaults to the masked group's bounding box plus 10 % — 8 to 92 units —
  while the strokes reach 5.9 to 94.1. A conformant renderer shaves the four outermost curves flat. The render
  reads a working copy whose mask region is the whole viewBox
  (`maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"`); nothing else in the master changes.
- **Paused barely shows in monochrome**: its bars sit on the lower C with no gap. Unused here, so not rendered.

When a kit ships whole templates, set `MACOS_TEMPLATES_FROM` in `scripts/icons.mjs` to `"kit"` and vendor it
(below): the kit's own templates are then copied like everything else, `rendered/` is removed, and the template
checks in `src/web/__tests__/desktop-brand-icons.test.ts` say whether they really are whole.

## Regenerating

Taking a new kit: change `KIT_VERSION` in `scripts/icons.mjs`, then, with the kit unpacked somewhere,

```sh
node desktop/scripts/vendor-brand-kit.mjs <the unpacked kit: the directory holding VERSION and SHA256SUMS.txt>
```

It copies every kit file the plan in `scripts/icons.mjs` reads (and the masters the render reads), refuses one
that does not match the kit's own `SHA256SUMS.txt`, removes what is no longer read, and rewrites the table below.

Rendering the macOS templates (kit v1.0 only):

```sh
brew install resvg        # 0.48.1, MPL-2.0 — or: cargo install resvg --version 0.48.1
node desktop/scripts/render-tray-templates.mjs
```

For each of the four masters it writes the working copy above to a temporary file and runs

```sh
resvg --skip-system-fonts -w 18 -h 18 ccdeck-tray-<kit state>.svg ccdeck<State>Template.png
resvg --skip-system-fonts -w 36 -h 36 ccdeck-tray-<kit state>.svg ccdeck<State>Template@2x.png
```

then rewrites the table. resvg is one program with no system libraries in the way: one version gives the same bytes
on any machine, and two renders were byte-identical. The script refuses another resvg version, because it may
rasterise an edge pixel differently; moving to one means changing `RESVG_VERSION` and looking at every image.

`node desktop/scripts/vendor-brand-kit.mjs --table` rewrites only the table.

## Files

Every file in this folder and its SHA-256. `desktop-brand-icons.test.ts` checks each hash and that the table lists
exactly the files here, and `tracked-binaries.test.ts` takes its list of the desktop app's images from it.

<!-- files:start -->
| File | SHA-256 |
|---|---|
| `kit/03-app-icons/linux/ccdeck-128.png` | `78b6ff2fa7808c7bcdbbba9a8e05b186f6d409540d72a70fd6b3a927728ed770` |
| `kit/03-app-icons/linux/ccdeck-16.png` | `281d786ef6c015d1e78a385ccd0078e57c0bd6cba1eca1a2902e47c7c1051a11` |
| `kit/03-app-icons/linux/ccdeck-256.png` | `917d811ccdda9175c4649e327652eac8863398e0f00616af9ea3d2ed0949fddf` |
| `kit/03-app-icons/linux/ccdeck-32.png` | `c19672d5cafa48486ce2945ccf678d5149900ff39abfaf409d1cc88798709eb1` |
| `kit/03-app-icons/linux/ccdeck-48.png` | `62916fe3930df82f97f3a64edf9b0383cc176f06b8ec849996e9f465a1bd9ad8` |
| `kit/03-app-icons/linux/ccdeck-512.png` | `d267c2f01297b8293dc8184e892a6741f1a21655e7382e63dd5d1ad7ea51c335` |
| `kit/03-app-icons/linux/ccdeck-64.png` | `123ff3aed8fcca1660bcf5d543d1c7451daa12d564b385b572a0d150855662db` |
| `kit/03-app-icons/macos.iconset/icon_128x128.png` | `78b6ff2fa7808c7bcdbbba9a8e05b186f6d409540d72a70fd6b3a927728ed770` |
| `kit/03-app-icons/macos.iconset/icon_128x128@2x.png` | `917d811ccdda9175c4649e327652eac8863398e0f00616af9ea3d2ed0949fddf` |
| `kit/03-app-icons/macos.iconset/icon_16x16.png` | `281d786ef6c015d1e78a385ccd0078e57c0bd6cba1eca1a2902e47c7c1051a11` |
| `kit/03-app-icons/macos.iconset/icon_16x16@2x.png` | `c19672d5cafa48486ce2945ccf678d5149900ff39abfaf409d1cc88798709eb1` |
| `kit/03-app-icons/macos.iconset/icon_256x256.png` | `917d811ccdda9175c4649e327652eac8863398e0f00616af9ea3d2ed0949fddf` |
| `kit/03-app-icons/macos.iconset/icon_256x256@2x.png` | `d267c2f01297b8293dc8184e892a6741f1a21655e7382e63dd5d1ad7ea51c335` |
| `kit/03-app-icons/macos.iconset/icon_32x32.png` | `c19672d5cafa48486ce2945ccf678d5149900ff39abfaf409d1cc88798709eb1` |
| `kit/03-app-icons/macos.iconset/icon_32x32@2x.png` | `123ff3aed8fcca1660bcf5d543d1c7451daa12d564b385b572a0d150855662db` |
| `kit/03-app-icons/macos.iconset/icon_512x512.png` | `d267c2f01297b8293dc8184e892a6741f1a21655e7382e63dd5d1ad7ea51c335` |
| `kit/03-app-icons/macos.iconset/icon_512x512@2x.png` | `e9b9e2f2f8fb996a7bb6b66bb11837cc0750fc5f22ca25ed77797ff7dce79ae6` |
| `kit/03-app-icons/png/ccdeck-app-1024.png` | `e9b9e2f2f8fb996a7bb6b66bb11837cc0750fc5f22ca25ed77797ff7dce79ae6` |
| `kit/03-app-icons/png/ccdeck-app-24.png` | `a43f17bbbc7dfb9e02489b8f595f7f3d645abcad3a7381c7679fabc3dfe3a3ea` |
| `kit/03-app-icons/windows/ccdeck.ico` | `5630781ccd91395ee3801baa582caf06077a34c6a3b684ad75b565d13de77952` |
| `kit/04-tray-menu/generic/svg/ccdeck-tray-default.svg` | `351824151b237975ffb79338da53db6c6bd901b2f3bd2b889616becbccfb8c1d` |
| `kit/04-tray-menu/generic/svg/ccdeck-tray-error.svg` | `ab10eef9a5d27ffa8b9bbf2b330dca3bf9532905619cb67610304f2f33ae872f` |
| `kit/04-tray-menu/generic/svg/ccdeck-tray-syncing.svg` | `e785e25bccb4d80bb5a4296e84646a3ab7cdeac70664cec026e576fb60a88a10` |
| `kit/04-tray-menu/generic/svg/ccdeck-tray-waiting.svg` | `3ed72a6152ea02a8b54019cd90cc59aaa88fe1f6e139d852b0757a06026de561` |
| `kit/04-tray-menu/linux/ccdeck-tray-default-32.png` | `52468c4eea6ae655c81ef11af60008e31550c57864944af6d428c6b392490b98` |
| `kit/04-tray-menu/linux/ccdeck-tray-default-64.png` | `8c1f24219e24799238e0ba249a10667cdd9b1168ff58636dbb18f9ec27d814a9` |
| `kit/04-tray-menu/linux/ccdeck-tray-error-32.png` | `642293987e31ff958d3b7139418e646173fc655e56912ce3d9bc9072e1175d69` |
| `kit/04-tray-menu/linux/ccdeck-tray-error-64.png` | `a7e49e08b463f9522ab4fd69c0c84599c424403be07147bafd45789c6b8ce9f8` |
| `kit/04-tray-menu/linux/ccdeck-tray-syncing-32.png` | `8edc7015563e762575d0232194ae177b5bb252df24b0869f4792cb87292d4ac4` |
| `kit/04-tray-menu/linux/ccdeck-tray-syncing-64.png` | `21ecde3eceff2181021cd9de3556f9aca27915d317d9970f735bc0007dbe0660` |
| `kit/04-tray-menu/linux/ccdeck-tray-waiting-32.png` | `34a980b115903367e87b88a0ef7c7b550266daabfa745feaab34d62f83ac8459` |
| `kit/04-tray-menu/linux/ccdeck-tray-waiting-64.png` | `8d0f0445ea80a20df6781608a1f62ec2f75301da16f637dbfca7a1c59e654a48` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-16.png` | `03c87aaaf0f161807b8654db80cebd7d2c4b1d67e30bd5b712c6550440eb2f7f` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-20.png` | `4d5b0b646386dcbb3b8b3a1abd1e21b1775bb8ad7dec4914b9d698d6f32d245f` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-24.png` | `f29d38354093c9fa605d49f6d61430308034d6f58ed53f861fca2615011784be` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-32.png` | `642293987e31ff958d3b7139418e646173fc655e56912ce3d9bc9072e1175d69` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-48.png` | `27593368451feae262c6df1c1cb069af578f44a955ae8eca04913f48c99f8270` |
| `kit/04-tray-menu/windows/ccdeck-tray-error-64.png` | `a7e49e08b463f9522ab4fd69c0c84599c424403be07147bafd45789c6b8ce9f8` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-16.png` | `c1830bc78813479d9f39a68b533ed8273333385556472d38dfbe25f04e8ef49d` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-20.png` | `3fad9f2720bc68972e2cd04a4caa2d784be96e60f21fae610803cb8e55efd406` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-24.png` | `e87f65b8061cc15ff7b393c2a7b4984ed88a3380b857befac8d8d2b9a610610a` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-32.png` | `8edc7015563e762575d0232194ae177b5bb252df24b0869f4792cb87292d4ac4` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-48.png` | `af60784a6dd7769ca9a9a5404165b725d55cabb95c33800af06bb00aac59ffe1` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing-64.png` | `21ecde3eceff2181021cd9de3556f9aca27915d317d9970f735bc0007dbe0660` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-16.png` | `2c08a8df3cd83ab578e56b87e04cd6f7ee7cbb8b256e5d1cd9ff0435f258d3e8` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-20.png` | `61429aebe1c40cd9726ba12fe752dde5332d9099d13a6021f1d8b2e74eaf06e3` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-24.png` | `d5c2bc86902219be19565f7ae220cf085af70ab77523ba3b6de49caa69707eba` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-32.png` | `34a980b115903367e87b88a0ef7c7b550266daabfa745feaab34d62f83ac8459` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-48.png` | `f26c94aceed13eb996f3541d96f3b0729c63e7beed571a67c7cd8bc9958185a3` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting-64.png` | `8d0f0445ea80a20df6781608a1f62ec2f75301da16f637dbfca7a1c59e654a48` |
| `kit/04-tray-menu/windows/ccdeck-tray.ico` | `7ffca68dab5c44bfefef630bd0df4ef912d201d70d73a9dc64b8cfe2ea91feb0` |
| `rendered/macos/ccdeckErrorTemplate.png` | `6fd19d452be4816fd7fdfca510353f80ea5e025aa2c28a0d4947ada5ca33b495` |
| `rendered/macos/ccdeckErrorTemplate@2x.png` | `2444fd2d95fc30fe2ccbc1bc26e734fe60e6e3042e19bb7792345d4e0a9aae50` |
| `rendered/macos/ccdeckSyncingTemplate.png` | `6485bb28c6c591bba994b8f644c01e48ff6df8ad761f19d9354a17f5e203b1c5` |
| `rendered/macos/ccdeckSyncingTemplate@2x.png` | `be7ece865605a608d7da8973b2703e36b6266d042c7338bdf871dc10731eabd4` |
| `rendered/macos/ccdeckTemplate.png` | `1fe909ce7f43458b1ffcd697ffb8b89c9248952ed1bad13f6c89afaa7a6529a0` |
| `rendered/macos/ccdeckTemplate@2x.png` | `6cf406a7d8365cc38874184232a5ebebbfc7cef08b7b5ce29146ad58da89ab83` |
| `rendered/macos/ccdeckWaitingTemplate.png` | `450428d861eb0a2be22cdb6e932fa9c63ed7fe2e181c68c773d3f99564c35a68` |
| `rendered/macos/ccdeckWaitingTemplate@2x.png` | `99c1aa5dbe850d161c2d12bc5afe96a675b22e6dd89c92df1a218b38cb7199b5` |
<!-- files:end -->
