# 모바일 한글 Android 소스

Kotlin·Compose UI와 Rust·rhwp 문서 엔진을 사용합니다.
페이지는 AndroidSVG가 기록한 Android Canvas 벡터 명령으로 그립니다.
HTML, WebView, 웹 서버를 앱 실행에 사용하지 않습니다.
SVG는 문서의 표시를 위한 벡터 데이터이며, 편집은 원본 DocumentCore에 반영합니다.

## 기능

- HWP3·HWP5·HWPX 열기와 연속 페이지 표시
- 새 문서, 본문·표 셀 텍스트 입력과 선택, Enter 새 문단
- 굵게·기울임·밑줄·글자 크기·글자 색·정렬·줄 간격
- 표·그림·수식·사각형·새 문단 삽입
- 표의 행·열 추가·삭제, 병합된 셀 나누기
- 실행 취소·다시 실행, 확대·축소·쪽 이동, 본문 복사
- HWP5·HWPX 저장 선택과 저장본 검증
- 화면 회전과 페이지 재사용 때 입력 버퍼 보존
- 저장·닫기·새 문서 전 미저장 변경 확인

HWP3 편집은 HWP5 변환 검사를 통과한 문서에서 지원합니다.
HWP3 형식으로 저장하는 기능은 없습니다.
지원 범위와 제한은 [상위 README](../README.md)를 확인하세요.

## 현재 환경에서 빌드

Android 8.0 이상 ARM64 APK를 생성합니다.
JDK 17, Android SDK 35, Gradle 8.11.1, Rust 및 고정 의존성을 사용합니다.
현재 Termux 환경의 SDK와 도구를 읽고, 쓰기 가능한 임시 폴더에서 빌드합니다.

```sh
bash tools/build-apk.sh
```

프로젝트 루트에서 실행하세요.
첫 빌드는 필요한 AndroidX·Compose 의존성을 다운로드합니다.
캐시를 준비한 뒤에는 다음 명령으로 오프라인 빌드를 실행할 수 있습니다.

```sh
HWP_OFFLINE=1 bash tools/build-apk.sh
```

이 스크립트는 Rust 검사, 네이티브 라이브러리 빌드, 실제 JNI 검사와 APK 빌드를 실행합니다.
APK 서명과 패키지 메타데이터도 확인합니다.
산출물은 `dist/모바일한글.apk`입니다. 로그도 `dist/`에 저장합니다.
앱을 기기에 자동 설치하지 않습니다.

다른 환경에서는 `android/`를 Android Studio로 여세요.
NDK·cargo-ndk로 `scripts/build-native.sh`를 실행하고 `:app:assembleDebug`를 빌드하세요.
검증에 사용하는 세 형식의 파일은 상위 `tests/fixtures/`에 있습니다.
본 배포 APK는 검증 문서를 포함하지 않습니다.

## 코드

| 파일 | 역할 |
|---|---|
| app/src/main/java/com/sihoo/hwp/MainActivity.kt | 네이티브 편집 도구·입력 상태·파일 메뉴 |
| app/src/main/java/com/sihoo/hwp/PageViewer.kt | Android Canvas 페이지와 IME 입력 |
| app/src/main/java/com/sihoo/hwp/ReaderViewModel.kt | 문서·저장본·세션의 비동기 처리 |
| app/src/main/java/com/sihoo/hwp/NativeReader.kt | Kotlin과 Rust의 JNI 계약 |
| native/src/lib.rs | 원본 문서 편집·실행 취소·저장 검증 |
| native/src/canvas_svg.rs | 글꼴 윤곽과 표시용 벡터 데이터 |

저장은 원본 형식의 파일과 별도로 새 파일을 만듭니다.
앱은 저장본을 다시 열어 본문과 표 셀 텍스트를 확인합니다.
저장 위치에 쓰기를 마친 뒤에만 변경 상태를 해제합니다.

## 라이선스

본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

rhwp 고정 커밋: `1a76570e833917d15817415a53c09ad61ab3203f` (0.8.7).
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)와 앱의 폰트 고지를 유지합니다.
이 앱은 한글과컴퓨터의 공식 앱이 아닙니다.
