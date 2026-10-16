#!/usr/bin/env bash
# Audit build only. Never writes assets/laz or substitutes the pinned npm codec.
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 SOURCE_CHECKOUT EMSDK_CHECKOUT NEW_BUILD_DIRECTORY" >&2
  exit 2
fi
source_root=$(realpath "$1")
sdk_root=$(realpath "$2")
build_root=$(realpath -m "$3")
source_commit=d0d3047e05221421fa0b02b3da4e93797edb2c52
sdk_commit=21611d2a507fad73385120d89e05a794666070ae
test "$(git -C "$source_root" rev-parse HEAD)" = "$source_commit"
test "$(git -C "$sdk_root" rev-parse HEAD)" = "$sdk_commit"
git -C "$source_root" diff --quiet HEAD --
git -C "$sdk_root" diff --quiet HEAD --
if [ -e "$build_root" ]; then
  echo "Use a new build directory so stale build products cannot pass." >&2
  exit 2
fi
# emsdk 3.1.20 resolves to SDK revision d92c8639f406582d70a5dde27855f74ecf602f45.
# Set up this audit SDK with ./emsdk install 3.1.20 && ./emsdk activate 3.1.20.
EMSDK_QUIET=1 source "$sdk_root/emsdk_env.sh"
emcc --version | head -1 | grep -F '3.1.20 (5d878c99921ec247d34fb26a20b5a13d60d69e93)'
# Bind the official Linux SDK components as well as its version/release map.
(
  cd "$sdk_root"
  sha256sum --check <<'DIGESTS'
d030baf6e1cb92bba926250611f82b559299b58f71764ac8076136d6a4d4aa87  upstream/bin/clang
d2d9b34cef790d3c87957f2d88c9bb68de7f91b8abdcacb9d0cc0395034ffc5e  upstream/bin/wasm-ld
6f51546e8f579bb3d179e787b59974f83bb210fc05c11cafd971880295e337a6  upstream/bin/wasm-opt
1a86c691c861bdc4606448c0de98936d3bb2dae173e13d8aba5586a1dbda9d0e  upstream/emscripten/emcc.py
DIGESTS
)
mkdir -p "$build_root"
{
  git -C "$source_root" log -1 --format=fuller
  git -C "$sdk_root" log -1 --format=fuller
  emcc --version
  cmake --version
  python3 --version
  uname -a
  find "$sdk_root/zips" -maxdepth 1 -type f -exec sha256sum {} +
  cmake -S "$source_root" -B "$build_root" -G 'Unix Makefiles' \
    -DCMAKE_TOOLCHAIN_FILE="$sdk_root/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DCMAKE_BUILD_TYPE=Release -DENVIRONMENT=web
  cmake --build "$build_root" --target laz-perf --verbose -j 1
  sha256sum "$build_root/cpp/emscripten/laz-perf.wasm" \
    "$build_root/cpp/emscripten/laz-perf.js"
} 2>&1 | tee "$build_root/rebuild.log"
