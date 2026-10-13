# 한글 문서 — Android 원본 서식 뷰어·에디터

Kotlin / Compose UI와 Rust / rhwp 엔진으로 HWP 3.x·5.x·HWPX를 읽습니다.
문단·글자 서식, 수식, 표·병합 셀·테두리, 그림, 도형, 글상자, 차트,
머리말·꼬리말·각주·쪽번호 등 rhwp가 해석하는 요소를 페이지 배치대로 표시합니다.
HTML·WebView·서버를 사용하지 않습니다.

## 사용법

- **파일**: 문서 열기·글꼴 추가·문서 닫기·편집본 저장
- **홈**: 본문 텍스트 편집, 실행 취소·다시 실행, 글꼴 추가
- **삽입**: 표·그림·도형·수식·차트 메뉴. 삽입은 아직 비활성입니다.
- **보기**: 폭 맞춤·원본/텍스트 보기·쪽 번호로 이동
- **도움말**: 사용 안내·편집 지원 범위·문서 경고
- **문서 영역**: 여러 페이지를 세로로 이어서 스크롤. 필요한 페이지만 읽고 표시합니다.
- **아래 상태 표시줄**: 현재 쪽/전체 쪽, 편집·저장 상태, 50~500% 확대
- **두 손가락 확대 / 좌우 이동**: 문서 전체에 같은 배율과 가로 위치를 적용합니다.

원본 글꼴이 없으면 번들·시스템 글꼴로 대체합니다. 한국어 명조·고딕·고정폭,
수식과 옛한글용 오픈 폰트를 번들합니다. 같은 글꼴을 추가하면 원본 표시를 개선할 수 있습니다.
폰트 파일은 16 MiB까지, 문서는 32 MiB까지 읽습니다. 기존 200쪽 제한은 제거했습니다.
현재 쪽을 필요할 때 렌더링하고 최대 12쪽의 출력 파일을 캐시합니다.

홈 탭의 **텍스트 편집**에서 일반 HWP 5.x·HWPX 본문 문단을 수정할 수 있습니다.
개체가 들어 있는 문단과 HWP 3.x 문서는 읽기 전용입니다. HWP 5.x 특수 문서(암호,
배포용, 서명, 변경 추적)도 읽기 전용입니다. 문서 전체는 32 MiB까지, 편집은
8 MiB·5천 문단·20만 글자까지 지원합니다. 문단을 적용하면 원본 DocumentCore에 최소 변경을
반영하고 최대 20단계 실행 취소·다시 실행을 제공합니다. 저장은 원본 형식을 유지한
새 HWP/HWPX 파일로 내보냅니다. 내용 손실 보고가 있거나 저장본을 다시 열어 본문을
확인하지 못하면 저장을 중단합니다.

글자·문단 서식 도구와 표·그림·도형·수식·차트 삽입·수정은 아직 구현 중입니다.
암호 문서 입력, 표 셀 텍스트 편집, 모든 문서의 완전한 원본 호환도 후속 작업입니다.
HWP3와 복잡한 개체의 호환성은 rhwp의 지원 범위에 따릅니다.
문서 구조 경고 및 표시 엔진의 placeholder 개체는 화면에 안내합니다.
모든 한컴 문서의 픽셀 단위 동일성을 보장하지 않습니다.

## 렌더링 구조

```text
HWP3 / HWP5 / HWPX
    → rhwp DocumentCore (Rust 세션)
    → PageLayerTree → rhwp SVG 렌더러
    → usvg 글리프 경로 변환
    → AndroidSVG → Android Canvas / Picture
    → Compose 페이지 화면
```

rhwp의 SVG 렌더러로 표·수식·도형·이미지·차트·겹침 순서를 재생합니다.
PDF 생성과 PdfRenderer는 표시 경로에서 제거했습니다. AndroidSVG가 SVG의 벡터
경로·클립·그라데이션·이미지를 Android Canvas 명령으로 기록합니다.
확대는 Canvas 변환으로 같은 벡터 명령을 다시 그리며 페이지를 비트맵으로 만들지 않습니다.

번들·사용자·시스템 폰트로 글리프를 경로로 변환하여 글꼴과 수식의 위치를 유지합니다.
굵기·기울임 보정은 기존 rhwp 함수를 재사용합니다. 이미지로 삽입된 SVG는
Android 이미지 디코더 호환을 위해 해당 리소스만 PNG로 변환합니다(최대 4096px·800만 픽셀).
일부 필터·그림자 효과는 AndroidSVG에서 지원하지 않아 경고를 표시합니다.

DocumentCore 세션과 쪽별 원본 개체 경계 JSON을 유지합니다. 표시 SVG는 저장·편집의
원본이 아닙니다. 문단 편집은 Rust 세션에서 원본 IR에 반영합니다. 개체가 있는 문단을
보호하고, 직렬화 손실 보고와 저장본 재열기로 본문 텍스트를 확인합니다.

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

CI는 실제 HWP3/HWP5/HWPX 및 수식·그림·표·그룹 도형·HWP/HWPX 막대 차트 샘플을 렌더링합니다.
첫 쪽·마지막 쪽, 페이지 식별자·닫힌 세션·범위 오류를 검사하고
독립 SVG rasterizer로 생성한 쪽의 페이지 수·크기·비어 있지 않은 결과를 확인합니다.

Android 에뮬레이터에서 JNI → Android Canvas → Compose 화면까지 실행하고,
쪽 이미지와 화면 캡처를 CI artifact에 남깁니다. 세로 스와이프·쪽 번호 이동·파일 메뉴 연결과 삽입/저장 비활성 상태도 검사합니다.
개인 실기기 확인은 별도입니다.
검증 샘플은 test APK에만 포함하며 배포 앱에는 문서를 번들하지 않습니다.

## 파일

- MainActivity.kt: 파일·홈·삽입·보기 리본, 문단 편집·연속 페이지·쪽 이동·배율
- PageViewer.kt: AndroidSVG / Canvas로 자연스러운 페이지 높이 표시
- ReaderViewModel.kt: 비동기 열기·편집·저장과 세션 소유권
- NativeReader.kt: JNI 열기·렌더·편집·이력·저장 계약
- FontStore.kt: 기본 글꼴 준비와 사용자 글꼴 검증
- native/src/lib.rs: rhwp 세션, 쪽별 출력, 리소스 수명과 캐시
- scripts/: 고정 엔진·폰트 준비, 렌더 테스트·NDK 빌드

rhwp v0.8.7: 1a76570e833917d15817415a53c09ad61ab3203f.
글꼴 보정 유틸리티가 포함된 rhwp 의존성을 위해 업스트림 vendor/svg2pdf 패치를 유지합니다.
앱은 PDF를 생성하지 않습니다.
폰트는 고정 커밋의 WOFF2를 SFNT로 해제하며 글리프와 이름을 유지합니다.
폰트·엔진 소스와 네이티브 산출물은 Git 대신 준비 스크립트로 관리합니다.

## 라이선스

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)의 rhwp MIT 고지를 유지합니다.
APK의 assets/fonts에는 폰트 저작권·라이선스 metadata, OFL, GUST 및 출처 목록을 포함합니다.
원본의 상용 글꼴은 자동 다운로드하지 않으며 사용자가 제공할 수 있습니다.
