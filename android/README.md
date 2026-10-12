# 한글 읽기 — Android 원본 서식 뷰어

Kotlin / Compose UI와 Rust / rhwp 엔진으로 HWP 3.x·5.x·HWPX를 읽습니다.
문단·글자 서식, 수식, 표·병합 셀·테두리, 그림, 도형, 글상자, 차트,
머리말·꼬리말·각주·쪽번호 등 rhwp가 해석하는 요소를 페이지 배치대로 표시합니다.
HTML·WebView·서버를 사용하지 않습니다.

## 사용법

- **문서 열기**: 기기·클라우드 저장소의 HWP/HWPX 선택
- **이전/다음**, **쪽 번호**: 페이지 이동 및 번호로 바로 이동
- **+/−**, **배율 숫자**, **두 손가락**: 확대·맞춤 및 확대된 페이지 이동
- **텍스트 복사**: 해당 쪽의 본문을 선택·복사하는 보기로 전환
- **글꼴 추가**: TTF/OTF/TTC 파일을 설치하고 현재 문서를 다시 읽어 적용

원본 글꼴이 없으면 번들·시스템 글꼴로 대체합니다. 한국어 명조·고딕·고정폭,
수식과 옛한글용 오픈 폰트를 번들합니다. 같은 글꼴을 추가하면 원본 표시를 개선할 수 있습니다.
폰트 파일은 16 MiB까지, 문서는 32 MiB까지 읽습니다. 기존 200쪽 제한은 제거했습니다.
현재 쪽을 필요할 때 렌더링하고 최대 12쪽의 출력 파일을 캐시합니다.

읽기 전용입니다. 편집·암호 입력은 후속 기능입니다.
HWP3와 복잡한 개체의 호환성은 rhwp의 지원 범위에 따릅니다.
문서 구조 경고 및 표시 엔진의 placeholder 개체는 화면에 안내합니다.
모든 한컴 문서의 픽셀 단위 동일성을 보장하지 않습니다.

## 렌더링 구조

```text
HWP3 / HWP5 / HWPX
    → rhwp DocumentCore (Rust 세션)
    → PageLayerTree → 호환 SVG/PDF 출력 (쪽별)
    → Android PdfRenderer
    → Compose 페이지 화면
```

기존의 완성된 SVG/PDF 백엔드로 표·수식·도형·이미지·겹침 순서를 함께 재생합니다.
직접 PaintOp의 일부만 구현하는 별도 Android 그래픽 엔진을 만들지 않습니다.
PDF는 앱 내부의 표시용 임시 파일이며 원본 HWP를 수정하지 않습니다.
글리프를 경로로 저장해 PDF 폰트 서브셋 오류와 변환 메모리를 줄이고,
본문은 별도 텍스트 보기로 제공해 선택·복사를 유지합니다.

비트맵은 표시 폭·확대율에 맞춰 갱신하며 최대 4096px 폭·800만 픽셀로 제한합니다.
새 문서를 열거나 ViewModel이 정리되면 Rust 세션과 해당 임시 파일을 닫습니다.

## 빌드

필요: JDK 17, Android SDK 35, NDK 27.2.12479018, Rust 1.93.1,
cargo-ndk 4.1.2, Python 3.12. Gradle 8.11.1은 Wrapper로 받습니다.

```bash
cd android
rustup show
cargo install cargo-ndk --version 4.1.2 --locked
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
bash scripts/prepare-rhwp.sh
python -m pip install -r scripts/requirements.txt
python scripts/prepare-fonts.py
bash scripts/test-native.sh
bash scripts/build-native.sh
./gradlew :app:assembleDebug :app:lintDebug
```

Android Studio에서는 android 폴더를 열고 먼저 폰트·네이티브 빌드를 준비합니다.
Android 8.0(API 26) 이상 ARM64 기기와 x86_64 에뮬레이터 대상입니다.
Windows Gradle은 gradlew.bat이며 네이티브 준비는 Bash 환경이 필요합니다.
APK: app/build/outputs/apk/debug/app-debug.apk.

## 검증

CI는 실제 HWP3/HWP5/HWPX 및 수식·그림·표 샘플을 렌더링합니다.
첫 쪽·마지막 쪽, 페이지 식별자·닫힌 세션·범위 오류를 검사하고
독립 PDF rasterizer로 생성한 쪽의 페이지 수·크기·비어 있지 않은 결과를 확인합니다.

Android 에뮬레이터에서 JNI → PdfRenderer → Compose 화면까지 실행하고,
쪽 이미지와 화면 캡처를 CI artifact에 남깁니다. 개인 실기기 확인은 별도입니다.
검증 샘플은 test APK에만 포함하며 배포 앱에는 문서를 번들하지 않습니다.

## 파일

- MainActivity.kt: 원본·텍스트 보기, 파일·글꼴 선택과 페이지·배율 조작
- PageViewer.kt: Android PdfRenderer 및 화면 확대·이동
- ReaderViewModel.kt: 비동기 열기와 세션 소유권
- NativeReader.kt: JNI 계약
- FontStore.kt: 기본 글꼴 준비와 사용자 글꼴 검증
- native/src/lib.rs: rhwp 세션, 쪽별 출력, 리소스 수명과 캐시
- scripts/: 고정 엔진·폰트 준비, 렌더 테스트·NDK 빌드

rhwp v0.8.7: 1a76570e833917d15817415a53c09ad61ab3203f.
업스트림 vendor/svg2pdf 패치를 함께 사용합니다.
폰트는 고정 커밋의 WOFF2를 SFNT로 해제하며 글리프와 이름을 유지합니다.
폰트·엔진 소스와 네이티브 산출물은 Git 대신 준비 스크립트로 관리합니다.

## 라이선스

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)의 rhwp MIT 고지를 유지합니다.
APK의 assets/fonts에는 폰트 저작권·라이선스 metadata, OFL, GUST 및 출처 목록을 포함합니다.
원본의 상용 글꼴은 자동 다운로드하지 않으며 사용자가 제공할 수 있습니다.
