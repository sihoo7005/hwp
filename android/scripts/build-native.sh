#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Use the included pinned source; building never downloads or replaces it.
test -f "$project_dir/vendor/rhwp/Cargo.toml" || {
    echo "Missing bundled rhwp source." >&2
    exit 1
}
cd "$project_dir/native"
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"
if rustc -vV | rg -q '^host: aarch64-linux-android$'; then
    # Termux already targets Android and has a native ARM64 linker.
    cargo build --offline --locked --release --target aarch64-linux-android
    mkdir -p "$project_dir/app/src/main/jniLibs/arm64-v8a"
    cp "${CARGO_TARGET_DIR:-target}/aarch64-linux-android/release/libhwp_reader.so" \
        "$project_dir/app/src/main/jniLibs/arm64-v8a/libhwp_reader.so"
else
    command -v cargo-ndk >/dev/null || {
        echo "Install cargo-ndk 4.1.2 and Android NDK to build on this host." >&2
        exit 1
    }
    cargo ndk -t arm64-v8a --platform 26 \
        -o "$project_dir/app/src/main/jniLibs" build --offline --locked --release
fi
