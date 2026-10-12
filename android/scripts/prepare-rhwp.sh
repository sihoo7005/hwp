#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rhwp_dir="$project_dir/vendor/rhwp"
rhwp_revision=1a76570e833917d15817415a53c09ad61ab3203f

if [[ -d "$rhwp_dir/.git" ]] && [[ "$(git -C "$rhwp_dir" rev-parse HEAD)" == "$rhwp_revision" ]]; then
    exit 0
fi
mkdir -p "$rhwp_dir"
git -C "$rhwp_dir" init
if ! git -C "$rhwp_dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$rhwp_dir" remote add origin https://github.com/edwardkim/rhwp.git
fi
git -C "$rhwp_dir" fetch --filter=blob:none --depth=1 origin "$rhwp_revision"
git -C "$rhwp_dir" sparse-checkout init --cone
# Include workspace manifests and compile-time font resources, not the large corpus.
git -C "$rhwp_dir" sparse-checkout set src crates vendor bindings tools assets/fonts
git -C "$rhwp_dir" checkout --detach FETCH_HEAD
test "$(git -C "$rhwp_dir" rev-parse HEAD)" = "$rhwp_revision"
