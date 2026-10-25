#!/bin/bash
# Pelican/Pterodactyl installation script for the KisakCOD LAN multiplayer
# egg. Runs in ghcr.io/pelican-eggs/installers:debian with the server's files
# mounted at /mnt/server. Builds the browser site from source (no game data is
# downloaded or packaged) and installs the relay that serves it.
#
# Inputs (egg variables): GIT_REPO, GIT_REF, BUILD_FULL_LTO, BUILD_JOBS.
set -euo pipefail

SERVER_DIR=/mnt/server
WORK=/tmp/kisakcod-build
REPO="${GIT_REPO:-https://github.com/gymnae/cod4browser.git}"
REF="${GIT_REF:-web-port}"
JOBS="${BUILD_JOBS:-2}"

echo "== Installing build dependencies"
apt-get update
apt-get install -y --no-install-recommends \
    bzip2 ca-certificates curl git make ninja-build python3 python3-venv xz-utils

echo "== Fetching ${REPO} (${REF})"
rm -rf "$WORK"
git clone --depth 1 --branch "$REF" "$REPO" "$WORK/src"
cd "$WORK/src"
COMMIT=$(git rev-parse HEAD)

# read_pin FILE KEY[.KEY...]: print one value from a pinned-version JSON file.
read_pin() {
    python3 -c 'import functools,json,sys; print(functools.reduce(lambda d, k: d[k], sys.argv[2].split("."), json.load(open(sys.argv[1]))))' "$1" "$2"
}

echo "== Pinned Emscripten toolchain"
EMSDK_COMMIT=$(read_pin tools/web_toolchain.json emsdkCommit)
EMSCRIPTEN_VERSION=$(read_pin tools/web_toolchain.json emscripten)
CMAKE_VERSION=$(read_pin tools/web_toolchain.json cmake)
mkdir -p .tools
git clone https://github.com/emscripten-core/emsdk.git .tools/emsdk
git -C .tools/emsdk checkout -q "$EMSDK_COMMIT"
.tools/emsdk/emsdk install "$EMSCRIPTEN_VERSION"
.tools/emsdk/emsdk activate "$EMSCRIPTEN_VERSION"

echo "== CMake ${CMAKE_VERSION%%-*} series"
python3 -m venv .tools/cmake-venv
# The pin may be a release candidate; any release of the same minor works.
.tools/cmake-venv/bin/pip install --quiet "cmake==$(echo "$CMAKE_VERSION" | cut -d. -f1-2).*"
export PATH="$PWD/.tools/cmake-venv/bin:$PATH"

echo "== FFmpeg (Bink decoder source)"
FFMPEG_VERSION=$(read_pin tools/cinematic_codec.json ffmpeg.version)
FFMPEG_URL=$(read_pin tools/cinematic_codec.json ffmpeg.url)
FFMPEG_SHA256=$(read_pin tools/cinematic_codec.json ffmpeg.sha256)
curl -fsSL "$FFMPEG_URL" -o "$WORK/ffmpeg.tar.xz"
echo "$FFMPEG_SHA256  $WORK/ffmpeg.tar.xz" | sha256sum -c -
tar -xJf "$WORK/ffmpeg.tar.xz" -C .tools
test -f ".tools/ffmpeg-${FFMPEG_VERSION}/configure"

echo "== Building the LAN multiplayer site (this takes a while)"
if [ "${BUILD_FULL_LTO:-1}" = "0" ]; then
    # Lower peak memory for small install containers, at some runtime cost.
    export KISAK_WEB_CMAKE_ARGS="-DKISAK_WEB_FULL_LTO=OFF"
fi
KISAK_BUILD_JOBS="$JOBS" tools/build_web.sh Release --mp

echo "== Installing into ${SERVER_DIR}"
mkdir -p "$SERVER_DIR"
rm -rf "$SERVER_DIR/site" "$SERVER_DIR/lan-relay"
cp -r build/web-mp/site "$SERVER_DIR/site"
mkdir -p "$SERVER_DIR/lan-relay"
cp server/lan-relay/relay.mjs "$SERVER_DIR/lan-relay/"
# GPL-3.0: ship the corresponding source next to the binaries it built.
git archive --format=tar.gz --prefix="kisakcod-web-${COMMIT:0:12}/" \
    -o "$SERVER_DIR/site/kisakcod-web-source.tar.gz" "$COMMIT"
cat > "$SERVER_DIR/BUILD_INFO.txt" <<EOF
repository: ${REPO}
ref: ${REF}
commit: ${COMMIT}
emscripten: ${EMSCRIPTEN_VERSION}
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

rm -rf "$WORK"
echo "== Done. Site in ${SERVER_DIR}/site, relay in ${SERVER_DIR}/lan-relay"
