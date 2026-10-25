#!/usr/bin/env bash
# Linux/macOS counterpart of tools/build_web.ps1. Expects the pinned emsdk at
# .tools/emsdk (activated) and FFmpeg sources at .tools/ffmpeg-<version>.
#
# Usage: tools/build_web.sh [Release|Debug] [--mp] [--diagnostics] [--target NAME]
#   --mp  builds the LAN multiplayer site into build/web-mp (see docs/lan-multiplayer.md)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
configuration=Release
diagnostics=OFF
game=sp
target=
while [ $# -gt 0 ]; do
    case "$1" in
        Release|Debug) configuration=$1 ;;
        --diagnostics) diagnostics=ON ;;
        --mp) game=mp ;;
        --target) shift; target=$1 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
jobs=${KISAK_BUILD_JOBS:-2}
emsdk="$root/.tools/emsdk"
export EM_CONFIG="$emsdk/.emscripten"
export EMSDK="$emsdk"
export PATH="$emsdk/upstream/emscripten:$PATH"
toolchain="$emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
for required in "$EM_CONFIG" "$toolchain"; do
    test -f "$required" || { echo "missing pinned toolchain file: $required" >&2; exit 1; }
done

suffix=$([ "$game" = mp ] && echo -mp || true)
if [ "$diagnostics" = ON ]; then
    build="$root/build/web-diagnostics$suffix"; : "${target:=KisakCOD-web-diagnostics}"
else
    build="$root/build/web$suffix"; : "${target:=KisakCOD-web}"
fi

# FFmpeg Bink decoder (same configure line as tools/build_cinematic_codec.sh).
ffmpeg_version=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ffmpeg']['version'])" \
    "$root/tools/cinematic_codec.json")
ffmpeg_build="$root/build/ffmpeg-bink"
if ! test -f "$ffmpeg_build/libavcodec/libavcodec.a"; then
    mkdir -p "$ffmpeg_build"
    (cd "$ffmpeg_build" && bash "$root/.tools/ffmpeg-$ffmpeg_version/configure" \
        --enable-cross-compile --target-os=none --arch=wasm32 \
        --cc=emcc --host-cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
        --disable-everything --disable-autodetect --disable-programs --disable-doc \
        --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample \
        --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
        --disable-asm --disable-inline-asm --disable-x86asm --disable-debug --enable-small \
        --enable-demuxer=bink --enable-decoder=bink,binkaudio_rdft,binkaudio_dct \
        --extra-cflags='-Oz -flto' --extra-ldflags='-Oz -flto' &&
        make -j"$jobs" &&
        make install-headers prefix="$ffmpeg_build/install")
fi

# OpenAL Soft reverb component.
cmake -S "$root/scripts/web/reverb" -B "$root/build/reverb-wasm" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/build/reverb-wasm" --target reverb_dsp --parallel "$jobs"

python3 "$root/tools/qualify_web_release.py" inputs "$root" "$build/build-inputs.json"
cmake -S "$root" -B "$build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" \
    -DKISAK_PLATFORM=web \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DKISAK_WEB_DIAGNOSTICS="$diagnostics" \
    -DKISAK_WEB_GAME="$game" \
    -DCMAKE_BUILD_TYPE="$configuration" \
    ${KISAK_WEB_CMAKE_ARGS:-}
cmake --build "$build" --target "$target" --parallel "$jobs"
echo "Browser build ready in $build"
