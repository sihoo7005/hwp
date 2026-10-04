# HWP 단어 바꾸기 · 실험판

일반 HWP 5.0 파일을 열고, 같은 길이의 한글·영문·숫자 문자열을 모두 치환해 새 `.hwp`로 내려받는 작은 웹사이트입니다. 문서는 브라우저의 Web Worker에서 처리하며 외부 서버로 업로드하지 않습니다.

## 실행

Node.js와 Python이 필요합니다. 이 폴더에서 실행합니다.

```sh
npm ci --ignore-scripts --no-bin-links
npm test
npm run build
npm run serve
```

브라우저에서 **http://127.0.0.1:8765** 에 접속하세요. `dist/index.html`을 파일 앱에서 바로 열면 Worker가 실행되지 않을 수 있습니다. 서버 종료는 터미널에서 `Ctrl+C`입니다.

## 사용

1. 한글에서 만든 짧은 본문 문서를 선택합니다.
2. 찾을 단어와 같은 글자 수의 바꿀 단어를 입력합니다. 예: `서울 → 부산`.
3. **치환 결과 보기**를 누릅니다. 모든 치환은 선택한 원본을 기준으로 수행합니다.
4. **결과 HWP 다운로드**를 누르고, 새 파일을 한글 프로그램에서 열어 확인합니다.

찾기는 정규식이 아닌 문자열 검색입니다. 단어의 일부도 일치할 수 있고, 대소문자를 구분합니다. 제어 문자 경계를 넘는 문자열은 바꾸지 않습니다. 빈 검색, 다른 길이, 같은 단어, 이모지·공백·기호를 포함한 입력은 거절합니다.

## 범위와 한계

- HWP 5.0의 압축·비압축 본문을 읽습니다. 파일은 최대 8 MB, 압축 해제 누적 크기는 32 MB, 본문 표시는 20만 글자·5천 문단으로 제한합니다.
- 표·그림·수식·필드·알 수 없는 본문 구조가 있는 문서는 본문 확인만 허용합니다. 암호·배포용·DRM·전자서명·문서 이력·변경추적 등 특수 문서는 열기를 거절합니다.
- 원본의 문단·서식·줄 배치 레코드는 그대로 두고 본문의 같은 길이 문자열만 바꿉니다. 줄 배치 캐시를 보존하므로 글자 폭이 바뀌는 경우 화면이나 줄바꿈에 문제가 없는지 실제 한글에서 확인해야 합니다.
- 미리보기 텍스트 `PrvText`는 수정 본문으로 갱신하고, 이전 본문의 미리보기 이미지 `PrvImage`는 제거합니다. 다른 스트림은 보존하며 다운로드 전에 본문과 스트림을 다시 검사합니다.
- 이 사이트의 본문 화면은 글꼴·쪽 배치를 재현하지 않습니다. 포함된 문서 스크립트는 실행하지 않습니다.
- 자체 파서의 재열기 성공은 한글 프로그램의 호환성 보장이 아닙니다. 실제 한글에서 열기·추가 편집·재저장까지 확인해야 합니다.

자동 검사는 합성 CFB/HWP 레코드를 사용해 치환·압축·확장 레코드·제어 문자 보존·다른 스트림 보존·미지원 문서 거절을 확인합니다. 공개 `hwplib` 저장소의 [본문 샘플](https://github.com/neolord0/hwplib/blob/main/sample_hwp/changing-paragraph-text.hwp)과 [표 샘플](https://github.com/neolord0/hwplib/blob/main/sample_hwp/basic/%ED%91%9C.hwp)은 개발 중 별도로 확인하는 자료이며 저장소에 복사하지 않습니다.

2026-10-04 검증 결과: 자동 검사 9개 통과. 공개 본문 샘플에서 `샘플 → 실험` 치환·저장·자체 파서 재열기를 확인했습니다. Chromium에서 파일 선택→Worker 처리→치환 결과→다운로드, 길이가 다른 입력 거절, 표 문서의 편집 제한과 390px 화면 배치를 확인했습니다. 실제 한글 프로그램 재열기와 실제 휴대폰 키보드의 조합 입력은 아직 검증하지 않았습니다.

## GitHub Pages 배포

`npm run build`로 생성한 `dist/`가 배포할 정적 사이트 전체입니다. `.github/workflows/pages.yml`은 `main`에 푸시할 때 의존성을 설치하고 테스트·빌드해 배포 산출물을 만듭니다. 저장소의 Actions 변수 `PAGES_ENABLED`가 `true`이면 이어서 GitHub Pages에 배포합니다. 원본 HWP와 참고 PDF는 웹사이트 배포 산출물에 포함하지 않습니다.

GitHub 저장소의 **Settings → Pages → Source**는 **GitHub Actions**로 설정합니다. GitHub Free에서는 공개 저장소에 Pages를 사용할 수 있고, 비공개 저장소에서는 지원되는 유료 요금제가 필요합니다. [GitHub 공식 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Pages를 활성화한 뒤 **Settings → Secrets and variables → Actions → Variables**에서 `PAGES_ENABLED=true`를 설정합니다. **Actions → Test and deploy website → Run workflow**로 첫 배포를 시작할 수 있고, 이후 `main`에 푸시하면 자동 배포합니다.

2026-10-04 현재 Pages 활성화 API는 이 비공개 저장소에 대해 “Your current plan does not support GitHub Pages for this repository”라고 응답했습니다. 저장소 공개 전환 또는 지원 요금제 사용을 결정하기 전까지 배포는 비활성 상태이며 테스트·빌드는 실행됩니다.

배포 성공 후 기본 주소는 `https://sihoo7005.github.io/hwp/`입니다. GitHub Actions의 워크플로 실행 결과에서 실제 배포 상태를 확인하세요.

전체 개발 계획은 [HWP_WEB_PLAN.md](./HWP_WEB_PLAN.md)에 있습니다.

## 고지

본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

CFB 컨테이너 처리는 `cfb 1.2.2`, 압축 처리는 `pako 2.1.0`을 사용합니다. 의존성의 라이선스는 빌드 시 `dist/THIRD_PARTY_NOTICES.txt`에 포함합니다.
