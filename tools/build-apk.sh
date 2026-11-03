#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
termux_prefix=/data/data/com.termux/files/usr
source_home=/data/data/com.termux/files/home
build_root="${HWP_BUILD_ROOT:-$termux_prefix/tmp/mobile-hwp-build}"
gradle_distribution="$source_home/.gradle/wrapper/dists/gradle-8.11.1-bin/bpt9gzteqjrbo1mjrsomdt32c/gradle-8.11.1"
export JAVA_HOME="$termux_prefix/lib/jvm/java-17-openjdk"
export PATH="$JAVA_HOME/bin:$termux_prefix/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$source_home/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$build_root/gradle-home"
export CARGO_HOME="$build_root/cargo-home"
export CARGO_TARGET_DIR="$build_root/native-target"
mkdir -p "$build_root" "$GRADLE_USER_HOME" "$CARGO_HOME" "$project_root/dist"
# Copy caches once so this build never writes to the original Termux home.
if [[ ! -f "$build_root/caches-ready" ]]; then
    mkdir -p "$GRADLE_USER_HOME/caches" "$CARGO_HOME/registry" "$CARGO_TARGET_DIR"
    cp -a "$source_home/.gradle/caches/." "$GRADLE_USER_HOME/caches/"
    cp -a "$source_home/.cargo/registry/." "$CARGO_HOME/registry/"
    cp -a "$source_home/hwp-android-target/." "$CARGO_TARGET_DIR/"
    touch "$build_root/caches-ready"
fi
if [[ ! -f "$build_root/debug.keystore" ]]; then
    keytool -genkeypair -keystore "$build_root/debug.keystore" \
        -alias androiddebugkey -storepass android -keypass android \
        -dname 'CN=Android Debug,O=Android,C=KR' \
        -keyalg RSA -keysize 2048 -validity 10000
fi
mkdir -p "$build_root/fonts/custom" "$build_root/fonts/bundled" "$build_root/jni-classes"
cp -a "$project_root/android/app/src/main/assets/fonts/." "$build_root/fonts/bundled/"
export HWP_FONT_ROOT="$build_root/fonts"
export RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384'
cd "$project_root/android/native"
cargo test --offline --locked --release --target aarch64-linux-android --lib \
    2>&1 | tee "$project_root/dist/native-tests.log"
# The standalone native script applies the same page alignment flag.
unset RUSTFLAGS
bash "$project_root/android/scripts/build-native.sh" \
    2>&1 | tee "$project_root/dist/native-build.log"
javac -d "$build_root/jni-classes" "$project_root/tests/jni/com/sihoo/hwp/NativeReader.java"
mkdir -p "$build_root/jni-libs"
cp "$project_root/android/app/src/main/jniLibs/arm64-v8a/libhwp_reader.so" "$build_root/jni-libs/"
java -Djava.library.path="$build_root/jni-libs" \
    -cp "$build_root/jni-classes" com.sihoo.hwp.NativeReader \
    "$HWP_FONT_ROOT" "$build_root/jni-cache" "$project_root/tests/fixtures" \
    "$project_root/dist/jni-test-output" 2>&1 | tee "$project_root/dist/jni-smoke.log"
cd "$project_root/android"
gradle_network=()
if [[ "${HWP_OFFLINE:-0}" == 1 ]]; then gradle_network=(--offline); fi
bash "$gradle_distribution/bin/gradle" "${gradle_network[@]}" --no-daemon --console=plain \
    -Dorg.gradle.vfs.watch=false -Duser.home="$build_root" \
    "-Dorg.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8 -Duser.home=$build_root" \
    -Pkotlin.compiler.execution.strategy=in-process \
    -Pandroid.aapt2FromMavenOverride="$termux_prefix/bin/aapt2" \
    -PhwpDebugKeystore="$build_root/debug.keystore" :app:assembleDebug \
    2>&1 | tee "$project_root/dist/apk-build.log"
cp "$project_root/android/app/build/outputs/apk/debug/app-debug.apk" \
    "$project_root/dist/모바일한글.apk"
java -jar "$termux_prefix/share/java/apksigner.jar" verify --verbose \
    "$project_root/dist/모바일한글.apk" 2>&1 | tee "$project_root/dist/apk-signature.log"
aapt2 dump badging "$project_root/dist/모바일한글.apk" \
    > "$project_root/dist/apk-metadata.txt"
sha256sum "$project_root/dist/모바일한글.apk" \
    > "$project_root/dist/모바일한글.apk.sha256"
python3 "$project_root/tools/verify-apk.py"
echo "APK: $project_root/dist/모바일한글.apk"
