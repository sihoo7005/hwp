#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$project_dir/scripts/prepare-rhwp.sh"
fixture_dir="$project_dir/native/target/fixtures"
mkdir -p "$fixture_dir"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/143E433F503322BD33.hwp > "$fixture_dir/sample.hwp"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/hwpx/143E433F503322BD33.hwpx > "$fixture_dir/sample.hwpx"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/hwp3-sample.hwp > "$fixture_dir/sample3.hwp"
git -C "$project_dir/vendor/rhwp" show 'HEAD:samples/수식-문자처럼취급-아님.hwpx' > "$fixture_dir/equation.hwpx"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/test-image.hwpx > "$fixture_dir/image.hwpx"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/issue6619_cellzone_border.hwpx > "$fixture_dir/table.hwpx"
git -C "$project_dir/vendor/rhwp" show HEAD:samples/shape-group-02.hwp > "$fixture_dir/shapes.hwp"
git -C "$project_dir/vendor/rhwp" show 'HEAD:samples/chart/세로막대형/묶은세로막대형.hwp' > "$fixture_dir/chart.hwp"
git -C "$project_dir/vendor/rhwp" show 'HEAD:samples/chart/세로막대형/묶은세로막대형.hwpx' > "$fixture_dir/chart.hwpx"
mkdir -p "$project_dir/app/src/androidTest/assets/fixtures" "$fixture_dir/fonts/bundled" "$fixture_dir/fonts/custom"
cp "$fixture_dir"/*.hwp "$fixture_dir"/*.hwpx "$project_dir/app/src/androidTest/assets/fixtures/"
cp "$project_dir/app/src/main/assets/fonts/"*.ttf "$project_dir/app/src/main/assets/fonts/"*.otf "$fixture_dir/fonts/bundled/"
cd "$project_dir"
HWP_FIXTURE_DIR="$fixture_dir" HWP_FONT_ROOT="$fixture_dir/fonts" cargo test --manifest-path native/Cargo.toml
python scripts/verify-rendered.py
