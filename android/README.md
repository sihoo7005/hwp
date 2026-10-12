# 한글 읽기 — Android 첫 버전

Kotlin / Jetpack Compose UI + Rust / rhwp 네이티브 읽기 엔진입니다.
기존 웹 앱과 별개로 이 디렉터리에서 새로 구현했습니다. HTML·WebView·서버를 사용하지 않습니다.

## 기능

- Android 파일 선택기에서 기기·클라우드의 문서 열기
- 파일 내용으로 HWP 3.x / HWP 5.x / HWPX 자동 판별
- rhwp 조판 엔진에서 추출한 텍스트를 쪽별 카드로 표시·선택·복사
- 로딩·빈 쪽·쪽별 추출 실패·미지원·암호 문서 오류 표시
- 화면 회전 중 ViewModel의 읽기 상태 유지
- 앱에 인터넷·전체 저장소 접근 권한 없음

현재는 **텍스트 읽기**입니다. 원본 표·그림·수식·페이지 모양 재현, 편집·저장,
비밀번호 입력은 아직 구현하지 않았습니다. HWP 3.x는 rhwp의 지원 범위에 따릅니다.
입력은 32 MiB, 표시는 최대 200쪽·100만 글자입니다. 잘린 결과는 화면에 안내합니다.
표시 제한은 파싱·조판 시간의 상한을 보장하지 않습니다.

## 빌드

필요: JDK 17, Android SDK 35, NDK 27.2.12479018,
Rust 1.93.1, cargo-ndk 4.1.2.
Gradle 8.11.1은 공식 Gradle Wrapper로 자동 다운로드합니다.

```bash
cd android
rustup show
cargo install cargo-ndk --version 4.1.2 --locked
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
bash scripts/test-native.sh
bash scripts/build-native.sh
./gradlew :app:assembleDebug :app:lintDebug
```

Android Studio에서는 이 `android` 폴더를 열고, 먼저 네이티브 빌드 스크립트를 실행합니다.
Windows에서는 `gradlew.bat`를 사용합니다. 네이티브 빌드 스크립트는 Bash 환경이 필요합니다.
SDK 위치는 `ANDROID_HOME` 또는 로컬 `local.properties`의 `sdk.dir`로 설정합니다.
APK: `app/build/outputs/apk/debug/app-debug.apk`.

ABI: arm64-v8a(64비트 ARM 기기), x86_64(에뮬레이터). Android 8.0(API 26) 이상.
두 ABI의 라이브러리가 없으면 Gradle은 실패합니다. 엔진 없이 동작하지 않는 APK를 만들지 않습니다.

## CI

`.github/workflows/android.yml`은 실제 HWP3/HWP5/HWPX 샘플 읽기, 잘못된 입력 검사,
ARM64/x86_64 네이티브 빌드, APK 빌드, Android lint를 실행합니다.
성공한 실행의 **hwp-reader-debug** artifact에서 APK를 받을 수 있습니다.
초기 CI가 성공하기 전에는 빌드 검증 완료로 간주하지 않습니다.
에뮬레이터·실기기 UI 검증은 별도로 수행해야 합니다.

## 엔진 고정과 구조

rhwp v0.8.7 커밋: `1a76570e833917d15817415a53c09ad61ab3203f`.
`scripts/prepare-rhwp.sh`가 sparse checkout으로 엔진 소스와 workspace 의존성을 준비합니다.
기존 rhwp의 `vendor/svg2pdf` 패치도 적용합니다. 가져온 소스·산출물은 Git에 넣지 않습니다.
첫 빌드가 만든 `native/Cargo.lock`은 CI artifact에도 남깁니다.

- `app/.../MainActivity.kt`: 기본 Compose 화면·파일 선택·쪽별 본문
- `ReaderViewModel.kt`: 백그라운드 파일 읽기·크기 제한·UI 상태
- `NativeReader.kt`: JNI와 JSON 결과
- `native/src/lib.rs`: rhwp DocumentService로 열기·텍스트 추출
- `scripts/`: 엔진 준비·native 테스트·NDK 빌드

JNI는 첫 버전에서 문서 한 개를 읽어 결과를 반환합니다.
향후 원본 레이아웃은 `DocumentCore::build_page_layer_tree`를 Android Canvas로 연결하고,
편집은 Rust 문서 세션을 유지하는 방식으로 확장합니다.

## 라이선스

rhwp는 MIT입니다. [rhwp 원문 라이선스](THIRD_PARTY_NOTICES.md)를 유지하며
APK에도 `assets/rhwp-license.txt`를 포함합니다. 별도 폰트는 번들하지 않습니다.
기존 저장소의 루트 문서는 웹 앱에 관한 자료이며 Android 구현의 사용법은 이 문서가 기준입니다.
