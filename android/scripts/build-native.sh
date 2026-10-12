#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$project_dir/scripts/prepare-rhwp.sh"
cd "$project_dir"
command -v cargo-ndk >/dev/null || {
    echo "Install cargo-ndk: cargo install cargo-ndk --version 4.1.2 --locked" >&2
    exit 1
}
cargo ndk -t arm64-v8a -t x86_64 -p 26 \
    -o "$project_dir/app/src/main/jniLibs" \
    build --manifest-path "$project_dir/native/Cargo.toml" --release
