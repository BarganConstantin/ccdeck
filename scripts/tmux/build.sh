#!/bin/sh
# ccdeck's own tmux, for the terminal panel on machines that have none.
#
# The panel needs tmux 3.2 or newer, and most people who run ccdeck have never
# installed it. Installing it for them system-wide would need sudo, and
# fetching somebody else's binary would mean running something the deck cannot
# vouch for. So ccdeck builds tmux itself, from upstream's release tarball, and
# publishes the result as a prerelease of its own repository; the deck
# downloads it into its own data folder and checks it against a SHA-256 written
# in the deck's source (src/server/tmux-download.mjs). No sudo, and nothing
# outside that folder.
#
# Every input is pinned by hash, so the same script on the same image compiles
# the same sources:
#   - tmux, from github.com/tmux/tmux releases;
#   - libevent, from github.com/libevent/libevent releases, linked statically;
#   - on Linux, ncurses from invisible-island.net, linked statically, against
#     Alpine's musl, so the binary runs on any distribution. ncurses is built
#     here rather than taken from Alpine so its terminfo search covers every
#     distribution's layout, Debian's /lib/terminfo included;
#   - on macOS, the system's ncurses, which every Mac has, with libevent and
#     utf8proc (for character widths) linked statically.
#
# Usage: build.sh <output-dir>
#   Linux: run inside alpine (the workflow uses alpine:3.22). Outside Alpine the
#   apk step is skipped and the host compiler is used, for trying the recipe.
#   macOS: TMUX_ARCH=arm64|x86_64 picks the architecture (default: the host).
# Writes <output-dir>/tmux-<version>-<os>-<arch>.tar.gz, holding `tmux`, a
# README and the licences of everything compiled into it, and a .sha256 beside it.
set -eu

TMUX_VERSION=3.8
TMUX_SHA256=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
LIBEVENT_VERSION=2.1.12-stable
LIBEVENT_SHA256=92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb
NCURSES_VERSION=6.5
NCURSES_SHA256=136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6
# macOS only: the system's wcwidth is years behind Unicode, so emoji and other
# wide characters would take the wrong number of cells; tmux requires one or
# the other choice there, and utf8proc is the right one.
UTF8PROC_VERSION=2.12.0
UTF8PROC_SHA256=a393fbef160835fb315bc3e91ba8d86f7a73a7cec9e6198b6c60b848b498bfeb
# Fetched only for its COPYRIGHT: musl itself comes from the Alpine image.
MUSL_VERSION=1.2.5
MUSL_SHA256=a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4
# Every place a distribution keeps compiled terminfo entries.
TERMINFO_DIRS_BUILT=/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo

OUT=${1:?usage: build.sh <output-dir>}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported build host: $(uname -s)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Download one tarball, refuse it unless its hash is the pinned one, unpack it.
fetch() {
  url=$1 want=$2 file=$WORK/$(basename "$1")
  curl -fsSL --retry 3 -o "$file" "$url"
  got=$(sha256 "$file")
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $url: got $got, want $want" >&2
    exit 1
  fi
  tar -xzf "$file" -C "$WORK"
}

if [ "$OS" = linux ]; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache build-base curl linux-headers bison >/dev/null
  fi
  ARCH=$(uname -m)
  CC=${CC:-cc}
  CFLAGS="-O2"
  LINK_STATIC="-static"
  HOST_FLAG=""
else
  ARCH=${TMUX_ARCH:-$(uname -m)}
  CC="clang -arch $ARCH"
  # Big Sur is the oldest macOS Node 22 runs on, so the oldest the deck does.
  CFLAGS="-O2 -mmacosx-version-min=11.0"
  LINK_STATIC=""
  # Native builds need no --host. A cross build names the target the way
  # libevent 2.1.12's config.sub knows it, which predates `arm64`.
  HOST_FLAG=""
  if [ "$ARCH" != "$(uname -m)" ]; then
    case "$ARCH" in arm64) HOST_FLAG="--host=aarch64-apple-darwin" ;; *) HOST_FLAG="--host=$ARCH-apple-darwin" ;; esac
  fi
fi
case "$ARCH" in
  x86_64|amd64) ARCH_NAME=x64 ;;
  aarch64|arm64) ARCH_NAME=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
export CC CFLAGS

DEPS=$WORK/deps
export PKG_CONFIG_PATH="$DEPS/lib/pkgconfig"

fetch "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" "$LIBEVENT_SHA256"
fetch "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" "$TMUX_SHA256"
if [ "$OS" = linux ]; then
  fetch "https://invisible-island.net/archives/ncurses/ncurses-$NCURSES_VERSION.tar.gz" "$NCURSES_SHA256"
  fetch "https://musl.libc.org/releases/musl-$MUSL_VERSION.tar.gz" "$MUSL_SHA256"
else
  fetch "https://github.com/JuliaStrings/utf8proc/releases/download/v$UTF8PROC_VERSION/utf8proc-$UTF8PROC_VERSION.tar.gz" "$UTF8PROC_SHA256"
fi

echo "building libevent $LIBEVENT_VERSION"
(
  cd "$WORK/libevent-$LIBEVENT_VERSION"
  # shellcheck disable=SC2086
  ./configure --prefix="$DEPS" $HOST_FLAG --disable-shared --enable-static \
    --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode >/dev/null
  make -j"$JOBS" >/dev/null
  make install >/dev/null
)

if [ "$OS" = linux ]; then
  echo "building ncurses $NCURSES_VERSION"
  (
    cd "$WORK/ncurses-$NCURSES_VERSION"
    ./configure --prefix="$DEPS" --without-shared --with-normal --without-debug \
      --enable-widec --with-termlib --enable-pc-files --with-pkg-config-libdir="$DEPS/lib/pkgconfig" \
      --without-ada --without-cxx --without-cxx-binding --without-manpages --without-progs \
      --without-tests --disable-db-install \
      --with-terminfo-dirs="$TERMINFO_DIRS_BUILT" --with-default-terminfo-dir=/usr/share/terminfo >/dev/null
    make -j"$JOBS" libs >/dev/null
    make install.libs >/dev/null
  )
fi

if [ "$OS" = darwin ]; then
  echo "building utf8proc $UTF8PROC_VERSION"
  (
    cd "$WORK/utf8proc-$UTF8PROC_VERSION"
    make libutf8proc.a CC="$CC" CFLAGS="$CFLAGS" >/dev/null
    mkdir -p "$DEPS/include" "$DEPS/lib"
    cp utf8proc.h "$DEPS/include/"
    cp libutf8proc.a "$DEPS/lib/"
  )
fi

echo "building tmux $TMUX_VERSION"
(
  cd "$WORK/tmux-$TMUX_VERSION"
  if [ "$OS" = linux ]; then FEATURES="--enable-static"; else FEATURES="--enable-utf8proc"; fi
  # shellcheck disable=SC2086
  ./configure $HOST_FLAG $FEATURES \
    CPPFLAGS="-I$DEPS/include -I$DEPS/include/ncursesw" LDFLAGS="$LINK_STATIC -L$DEPS/lib" >/dev/null
  # What configure decided about the functions a libc may or may not have, in
  # the log, because that is where a static build goes wrong first.
  grep -E '^(ac_cv_search_|ac_cv_func_)(forkpty|fdforkpty|utf8proc)' config.log || true
  make -j"$JOBS" >/dev/null
  strip tmux
)

STAGE=$WORK/stage
mkdir -p "$STAGE/LICENSES"
cp "$WORK/tmux-$TMUX_VERSION/tmux" "$STAGE/tmux"
cp "$WORK/tmux-$TMUX_VERSION/COPYING" "$STAGE/LICENSES/tmux.txt"
cp "$WORK/libevent-$LIBEVENT_VERSION/LICENSE" "$STAGE/LICENSES/libevent.txt"
if [ "$OS" = linux ]; then
  cp "$WORK/ncurses-$NCURSES_VERSION/COPYING" "$STAGE/LICENSES/ncurses.txt"
  cp "$WORK/musl-$MUSL_VERSION/COPYRIGHT" "$STAGE/LICENSES/musl.txt"
  LINKED="libevent $LIBEVENT_VERSION, ncurses $NCURSES_VERSION and musl, all statically"
else
  cp "$WORK/utf8proc-$UTF8PROC_VERSION/LICENSE.md" "$STAGE/LICENSES/utf8proc.txt"
  LINKED="libevent $LIBEVENT_VERSION and utf8proc $UTF8PROC_VERSION statically, and the system's ncurses"
fi
cat > "$STAGE/README.txt" <<EOF
tmux $TMUX_VERSION for $OS-$ARCH_NAME, built by ccdeck for its terminal panel
from upstream's release tarball (sha256 $TMUX_SHA256),
with $LINKED.
Recipe: scripts/tmux/build.sh in https://github.com/BarganConstantin/ccdeck
The licences of everything compiled in are in LICENSES/.
EOF

# The build machine runs what it built: a binary that cannot print its own
# version is not published.
"$STAGE/tmux" -V | grep -q "^tmux $TMUX_VERSION" || { echo "the built tmux does not run" >&2; exit 1; }
if command -v file >/dev/null 2>&1; then file "$STAGE/tmux"; fi

NAME=tmux-$TMUX_VERSION-$OS-$ARCH_NAME
tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" tmux README.txt LICENSES
echo "$(sha256 "$OUT/$NAME.tar.gz")  $NAME.tar.gz" | tee "$OUT/$NAME.tar.gz.sha256"
