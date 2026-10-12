#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$project_dir/scripts/prepare-rhwp.sh"
cd "$project_dir/native"
command -v cargo-ndk >/dev/null || {
    echo "Install cargo-ndk: cargo install cargo-ndk --version 4.1.2 --locked" >&2
    exit 1
}
# Support Android devices with 16 KiB memory pages.
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"
cargo ndk -t arm64-v8a -t x86_64 -p 26 \
    -o "$project_dir/app/src/main/jniLibs" \
    build --release
