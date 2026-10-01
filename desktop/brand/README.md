# The desktop app's brand files

Everything the desktop app shows as ccdeck — the app icon on macOS, Windows and Linux, and the tray on all
three — comes from this folder. `scripts/icons.mjs` copies these files into `dist/icons` unchanged, under the
names the app and electron-builder read. Nothing in the build or the app draws the mark.

`kit/` holds files **copied unchanged from the ccdeck brand kit v1.1.0**, each at the same relative path it has in
the kit. `KIT_VERSION` in `scripts/icons.mjs` names that version.

## The rules

1. **Never recreate the logo.** No mark drawn in code, CSS, canvas, hand-written SVG, an emoji or text. Use these
   files.
2. **No other gradients.** The mark's own gradients live inside the kit's artwork and nowhere else.
3. **One asset per context.** Each slot below has a dedicated kit file; use that one.
4. **Never shrink the app icon for the tray.** The app icon has a launcher tile; the tray has its own glyphs.
5. **Never take the big mark down to 16 px.** Up to 32 px the kit's small-optical artwork is used, which is what
   its tray files and small app icons already are.
6. **The macOS menu bar is monochrome.** It takes `*Template` images, black on transparent, and macOS tints them
   for a light or a dark bar. Never the gradient there, never a colour in a template.
7. **Status is a badge, never a recolouring.** A state is a corner badge, with a knockout, on an unchanged mark.
8. The name is **ccdeck**, lowercase, in text and alt text. The kit's own documents may write it otherwise;
   never copy their text.

## Which file serves which slot

The tray states, on the same map the tab's favicon uses:

| Product state | Kit state |
|---|---|
| idle | default |
| waiting | waiting |
| running | syncing |
| offline | error |

The kit's fifth state, **paused**, has no product state behind it and is unused. On macOS the waiting count
stays beside the icon, as the tray's title.

| Slot | Written to `dist/icons` as | From |
|---|---|---|
| macOS app icon (Dock, Finder, ⌘-Tab, About panel, notifications) | `icon.icns` | `kit/03-app-icons/macos/ccdeck.icns` |
| Windows app icon (exe, installer, taskbar, Start menu, toasts) | `icon.ico` | `kit/03-app-icons/windows/ccdeck.ico` |
| Linux app icon, hicolor 16–512 | `linux/<n>x<n>.png` | `kit/03-app-icons/linux/ccdeck-<n>.png`, n = 16, 22, 24, 32, 48, 64, 128, 256, 512 |
| The 1024 master in electron-builder's build resources | `icon.png` | `kit/03-app-icons/png/ccdeck-app-1024.png` |
| macOS menu bar | `tray-<state>Template.png` + `@2x` | `kit/04-tray-menu/macos/ccdeck{,Waiting,Syncing,Error}Template{,@2x}.png`, 18 and 36 px |
| Windows tray | `tray-<state>.ico` | `kit/04-tray-menu/windows/ccdeck-tray-<kit state>.ico` |
| Linux tray | `tray-<state>.png` + `@2x` | `kit/04-tray-menu/linux/ccdeck-tray-<kit state>-{24,48}.png` |

Why each platform takes the form it does:

- **macOS, the kit's `.icns`.** The kit builds it with `iconutil` from its own iconset, every 1x and @2x entry;
  `iconutil` here rebuilds it byte for byte, so it is copied rather than built, and any machine can make the
  app's icons.
- **macOS menu bar, 18 pt.** Electron takes the 1x file's pixel size as the image's size in points and loads the
  `@2x` beside it, and the menu-bar button draws an image that fits its bar without scaling it — so 18 px is
  18 pt on screen, the size the kit draws its templates for. The word `Template` in the file name is what makes
  Electron mark the image as a template.
- **Windows, the state's `.ico`.** Electron's Windows tray asks the image for an icon at the small-icon size
  (`GetSystemMetrics(SM_CXSMICON)`). From an `.ico`, Windows loads the entry made for that size — each of the
  kit's carries 16, 20, 24, 32, 40, 48 and 64, one per display scale from 100 to 400 %. From a PNG, Electron
  hands over only the 1x bitmap and Windows scales it.
- **Linux, 24 and 48.** A panel asks for 22–24 px. Electron hands the StatusNotifierItem host one image, the
  highest-resolution one it holds, so the panel receives the 48 and halves it on a normal panel or shows it as
  it is on a HiDPI one — never the 64 scaled down.

## Taking a new kit

Change `KIT_VERSION` in `scripts/icons.mjs`, then, with the kit unpacked somewhere,

```sh
node desktop/scripts/vendor-brand-kit.mjs <the unpacked kit: the directory holding VERSION and SHA256SUMS.txt>
```

It copies every kit file the plan in `scripts/icons.mjs` reads, refuses one that does not match the kit's own
`SHA256SUMS.txt`, removes what is no longer read, and rewrites the table below.
`src/web/__tests__/desktop-brand-icons.test.ts` then checks every slot by name, size and template rules — not by
what the artwork looks like — and `node desktop/scripts/vendor-brand-kit.mjs --table` rewrites only the table.

## Files

Every file in this folder and its SHA-256. `desktop-brand-icons.test.ts` checks each hash and that the table lists
exactly the files here, and `tracked-binaries.test.ts` takes its list of the desktop app's images from it.

<!-- files:start -->
| File | SHA-256 |
|---|---|
| `kit/03-app-icons/linux/ccdeck-128.png` | `f5d1e93dd6c199e80d83d728873d2f9917b3f3c855b58442e8c528c27a39a81d` |
| `kit/03-app-icons/linux/ccdeck-16.png` | `962ee164502a38d103b6b255c7e403ddbf2501c2585427a10f7d1ebbc4240849` |
| `kit/03-app-icons/linux/ccdeck-22.png` | `43ca807fd8507972d08e1ad36c131223ff2ce8335213f22a3867b0aa12af1f1b` |
| `kit/03-app-icons/linux/ccdeck-24.png` | `338178d7940cf3e665dc8b8de318fda789cfc6804a3996bb8bf173440d4d8f38` |
| `kit/03-app-icons/linux/ccdeck-256.png` | `a5784e8d6df99b6daf4b72827fef00d9b9e18d61d32464cfd0c6fca7d8e8422d` |
| `kit/03-app-icons/linux/ccdeck-32.png` | `1a30ee864f1d1ac43abd18e3e32af9c77c3777b6bacdcb744b027b1b0461613b` |
| `kit/03-app-icons/linux/ccdeck-48.png` | `5af653e32dd3301b5b1d33c3a7a5550d80032502a7b31a55b249d2da4f4f4423` |
| `kit/03-app-icons/linux/ccdeck-512.png` | `ea2242e755cf9c9189d43766a0fed044305cdca37e3d3080e39c9c996e59091c` |
| `kit/03-app-icons/linux/ccdeck-64.png` | `55af5e283bd1fc8cadc94107a545b904d813c4c9701cb0997bc17c9c2948b410` |
| `kit/03-app-icons/macos/ccdeck.icns` | `db18b600c0b6f4540eb53a85a5439d9ca7d5408791b6310875e164005fd3dd9a` |
| `kit/03-app-icons/png/ccdeck-app-1024.png` | `4272906723f8bcdf82810142434bbb7ce9a16b1ac0f4a03ee5fc104dd41f336b` |
| `kit/03-app-icons/windows/ccdeck.ico` | `850e7c39bc6cb80a7ba10b454196df4ff384e18bf3c36d8de10298a881a641cc` |
| `kit/04-tray-menu/linux/ccdeck-tray-default-24.png` | `8f1f8b0a3c540435d4b6d1b33bad270e2b7e6a8d72c5f54365210b7fd3183f1f` |
| `kit/04-tray-menu/linux/ccdeck-tray-default-48.png` | `afc550252b4406f883d712f68787a80a60c226094fbc39e8ec3c753164026d0e` |
| `kit/04-tray-menu/linux/ccdeck-tray-error-24.png` | `00d68e92a51fa7325098574b672651f82dc811d0ee6059518df6d14d0ea382ae` |
| `kit/04-tray-menu/linux/ccdeck-tray-error-48.png` | `8c1f09917b94fc456050567bcbb61626edd51b6c107e3c4e83e73525659754a9` |
| `kit/04-tray-menu/linux/ccdeck-tray-syncing-24.png` | `b63e759ec8ce01101ace28a60161696462ba67b22ccef43d59e35e8dfbe194f2` |
| `kit/04-tray-menu/linux/ccdeck-tray-syncing-48.png` | `98b221f7507a5a7d61b48d59c7744cd8048a13c999f7163b97f454bab293b0f7` |
| `kit/04-tray-menu/linux/ccdeck-tray-waiting-24.png` | `83f6b7900aa03db6063843aaad393c9e0209b20406ed05a7adda29753b4a4438` |
| `kit/04-tray-menu/linux/ccdeck-tray-waiting-48.png` | `2efa631d02bf994c59e2a152b0c9f18cab38027479fafaae47ff3a332f2a91b0` |
| `kit/04-tray-menu/macos/ccdeckErrorTemplate.png` | `6fb27d12171c2fe44a5a319acf94fd2ac2ca78529c84c06cd22d0afe08b1a0f5` |
| `kit/04-tray-menu/macos/ccdeckErrorTemplate@2x.png` | `624c9c3d8e12c9a485d0781899d135efce79edb4e515264040f3b20228204cdb` |
| `kit/04-tray-menu/macos/ccdeckSyncingTemplate.png` | `ce3cb4b448c99b87bbedb991ef3aef7558be04510ffd6b2408b02e4df1a56ced` |
| `kit/04-tray-menu/macos/ccdeckSyncingTemplate@2x.png` | `6673b81dc31fcb74e192cf6e1e9b2e428b8988d005bfd0f9a66e9ab368bf1c7d` |
| `kit/04-tray-menu/macos/ccdeckTemplate.png` | `3e56c5499e0345315aef64e7c28b5eb7ecc822b3a6d0aafc241885b221a82c2b` |
| `kit/04-tray-menu/macos/ccdeckTemplate@2x.png` | `f18c05f8f5ede3247a4bd400c0b7ada937b7f3054ec1e5d7be8863246d1ed466` |
| `kit/04-tray-menu/macos/ccdeckWaitingTemplate.png` | `65f838b079c5daa75f8bdd09bc7325e6a9c046766818f9fe1af0c214ecdf56cf` |
| `kit/04-tray-menu/macos/ccdeckWaitingTemplate@2x.png` | `39be413c813c7ee82e1e44de5ae249f5c16cb208c600e57fbb9bfd341e11ad2d` |
| `kit/04-tray-menu/windows/ccdeck-tray-default.ico` | `5cfc43d195da9c4087a29bc1461a4bf1c6fd76b2516e0832e043aa02bacf5221` |
| `kit/04-tray-menu/windows/ccdeck-tray-error.ico` | `c76bfeb890c38990d472f68566e9fdffa3c2fe5189fb9f710b53213395479bb2` |
| `kit/04-tray-menu/windows/ccdeck-tray-syncing.ico` | `bcafd4b91894312cff6ec55efe2052ae093109b2db04cdae5705aa2e79f1d8de` |
| `kit/04-tray-menu/windows/ccdeck-tray-waiting.ico` | `dcbe0882258f102c6cc6662b400458d5339df685db672725c7c3db17f08049f0` |
<!-- files:end -->
