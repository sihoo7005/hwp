#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$project_dir/scripts/prepare-rhwp.sh"
fixture_dir="$project_dir/native/target/fixtures"
mkdir -p "$fixture_dir"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/143E433F503322BD33.hwp > "$fixture_dir/sample.hwp"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/hwpx/143E433F503322BD33.hwpx > "$fixture_dir/sample.hwpx"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/hwp3-sample.hwp > "$fixture_dir/sample3.hwp"
cd "$project_dir"
HWP_FIXTURE_DIR="$fixture_dir" cargo test --manifest-path native/Cargo.toml
