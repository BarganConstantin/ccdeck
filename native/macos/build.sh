#!/bin/sh
# Build dist/native/macos/ccdeck.app — the menu-bar icon (#1160).
#
# Universal (arm64 + x86_64), so one tarball serves every Mac. Signed ad hoc:
# the linker already does that for arm64, and it is what gives the bundle a
# stable identity for notification permission. No Developer ID is involved;
# npm does not set the quarantine flag on what it extracts, so Gatekeeper is
# never asked.
#
# macOS only, and a no-op elsewhere, so `npm run build` stays one command on
# every platform.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "native/macos/build.sh: not macOS, skipping the menu-bar app"
  exit 0
fi

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/dist/native/macos"
app="$out/ccdeck.app"
work="$out/.build"
version="$(node -p "require('$root/package.json').version")"

rm -rf "$app" "$work"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$work"

for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" "$here/main.swift" -o "$work/ccdeck-$arch"
done
lipo -create "$work/ccdeck-arm64" "$work/ccdeck-x86_64" -output "$app/Contents/MacOS/ccdeck"

sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"

# The icon comes from the app's own drawing code, so the menu bar, the
# notifications and the Finder all show the same ring.
iconset="$work/ccdeck.iconset"
mkdir -p "$iconset"
"$app/Contents/MacOS/ccdeck" --render-icon "$work/icon-1024.png" 1024
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/ccdeck.icns"

codesign --force --sign - "$app"
rm -rf "$work"
echo "built $app ($version)"
