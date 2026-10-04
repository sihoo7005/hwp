// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
import { renderView } from "./viewer.mjs";
const fileInput = document.querySelector("#file");
const controls = document.querySelector("#controls");
const from = document.querySelector("#from");
const to = document.querySelector("#to");
const download = document.querySelector("#download");
const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
const previewState = document.querySelector("#preview-state");
const fileInfo = document.querySelector("#file-info");
const viewMode = document.querySelector("#view-mode");
const zoom = document.querySelector("#zoom");
const version = document.querySelector("#document-version");
const viewInfo = document.querySelector("#view-info");
const viewerStatus = document.querySelector("#viewer-status");
const pageNavigation = document.querySelector("#page-navigation");
const pageNumber = document.querySelector("#page-number");
const previousPage = document.querySelector("#previous-page");
const nextPage = document.querySelector("#next-page");
const passwordForm = document.querySelector("#password-form");
const password = document.querySelector("#password");
const engineViews = new Map();
let engineWorker;
let engineTimer;
let pendingJobs = 0;
let pageUrl;
let requestId = 0;
let sourceBytes;
let engineError = "";
let worker;
let original = null;
let resultView = null;
let result;
let filename;
let editable = false;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function adjustZoom() {
  const papers = preview.querySelectorAll(".document-paper");
  const width = Math.max(0, ...Array.from(papers, p => Number(p.dataset.width)));
  const scale = zoom.value === "fit" ? Math.min(1, Math.max(.05, (preview.clientWidth - 32) / width)) : Number(zoom.value);
  for (const paper of papers) paper.style.zoom = scale;
  viewInfo.textContent = width ? `${preview.querySelector('.page-image') ? '쪽 보기' : `${papers.length}개 구역`} · ${Math.round(scale * 100)}%` : "";
}

function releasePage() {
  if (pageUrl) URL.revokeObjectURL(pageUrl);
  pageUrl = null;
}

function showPage(data) {
  const parsed = new DOMParser().parseFromString(data.svg, "image/svg+xml");
  const root = parsed.documentElement;
  const width = Number(root.getAttribute("width"));
  const height = Number(root.getAttribute("height"));
  if (root.localName !== "svg" || !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    viewerStatus.textContent = "쪽 이미지의 크기 또는 형식이 올바르지 않습니다. 텍스트 보기로 확인하세요.";
    return;
  }
  releasePage();
  // SVG를 이미지로 표시하여 문서 속 스크립트·외부 링크가 실행되지 않게 합니다.
  pageUrl = URL.createObjectURL(new Blob([data.svg], { type: "image/svg+xml" }));
  const image = document.createElement("img");
  image.className = "document-paper page-image";
  image.dataset.width = width;
  image.width = Math.round(width);
  image.height = Math.round(height);
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.alt = `${data.page + 1}쪽 문서 미리보기. 글 선택과 복사는 텍스트 보기를 이용하세요.`;
  image.onerror = () => { if (preview.contains(image)) viewerStatus.textContent = "쪽 이미지를 표시하지 못했습니다. 텍스트 또는 기본 서식 보기를 이용하세요."; };
  image.src = pageUrl;
  preview.replaceChildren(image);
  adjustZoom();
}

function engineRequest(data, transfer = []) {
  pendingJobs++;
  clearTimeout(engineTimer);
  engineTimer = setTimeout(() => {
    engineWorker?.terminate();
    engineWorker = null;
    engineViews.clear();
    engineError = "문서 처리가 45초를 넘었습니다. 더 작은 문서를 선택하거나 기본 서식으로 확인하세요.";
    render();
  }, 45000);
  engineWorker.postMessage(data, transfer);
}

function openEngine(bytes, key, secret = "") {
  if (!engineWorker) {
    pendingJobs = 0;
    const current = new Worker(new URL("./advanced-worker.mjs", import.meta.url), { type: "module" });
    engineWorker = current;
    current.onmessage = ({ data }) => {
      if (engineWorker !== current) return;
      pendingJobs--;
      if (pendingJobs <= 0) clearTimeout(engineTimer);
      if (data.type === "page" && data.id !== requestId) return;
      if (data.type === "opened") {
        engineViews.set(data.key, data);
        engineError = "";
        passwordForm.hidden = true;
        render();
      } else if (data.type === "page") {
        if (viewMode.value !== "document" || data.key !== version.value) return;
        engineViews.get(data.key).page = data;
        showPage(data);
      } else if (data.type === "error") {
        if (data.id && data.id !== requestId) return;
        engineError = data.passwordRequired ? (/일치/.test(data.message) ? "비밀번호가 일치하지 않습니다. 다시 입력하세요." : "비밀번호를 입력해 문서를 여세요.") : `쪽 보기 오류: ${data.message}`;
        passwordForm.hidden = !data.passwordRequired;
        if (data.passwordRequired) password.focus();
        render(false);
      }
    };
    current.onerror = () => {
      if (engineWorker !== current) return;
      clearTimeout(engineTimer);
      current.terminate();
      engineWorker = null;
      engineViews.clear();
      engineError = "쪽 보기 처리기를 실행하지 못했습니다. 기본 서식 보기를 이용하거나 파일을 다시 선택하세요.";
      render();
    };
  }
  const copy = bytes.slice(0);
  engineViews.delete(key);
  engineError = "";
  engineRequest({ type: "open", key, bytes: copy, password: secret }, [copy]);
  render();
}

function render(requestPage = true) {
  releasePage();
  requestId++;
  const isResult = version.value === "result" && resultView;
  const model = isResult ? resultView : original;
  const advanced = engineViews.get(version.value);
  if (viewMode.value === "basic" && !model) viewMode.value = "document";
  preview.dataset.mode = viewMode.value;
  preview.replaceChildren();
  previewState.textContent = isResult ? "치환 결과" : "원본";
  viewMode.disabled = !model && !advanced;
  viewMode.querySelector('[value="basic"]').disabled = !model;
  version.disabled = !model && !advanced;
  zoom.disabled = (!model && !advanced) || viewMode.value === "text";
  pageNavigation.hidden = viewMode.value !== "document" || !advanced;
  pageNumber.max = advanced?.pages || 1;
  const page = Math.min(advanced?.pages || 1, Math.max(1, Math.trunc(Number(pageNumber.value)) || 1));
  pageNumber.value = page;
  pageNumber.disabled = !advanced;
  previousPage.disabled = !advanced || page <= 1;
  nextPage.disabled = !advanced || page >= advanced.pages;
  document.querySelector("#page-total").textContent = advanced ? `/ ${advanced.pages}쪽` : "";
  viewerStatus.textContent = engineError || (advanced ?
    `${advanced.format.toUpperCase()} · ${advanced.pages}쪽${advanced.warnings ? ` · 서식 검사 안내 ${advanced.warnings}건: 원본과 배치를 비교해 주세요.` : ''}${advanced.unsupported ? ` · 미지원 HML 요소 ${advanced.unsupported}건은 화면에서 생략됩니다.` : ''}${advanced.truncated ? ' · 텍스트는 처음 20만 글자만 표시합니다.' : ''}` : sourceBytes ? "쪽 배치를 읽고 있습니다…" : "");
  if (viewMode.value === "document" && advanced && !engineError) {
    if (advanced.page?.page === page - 1) showPage(advanced.page);
    else {
      if (requestPage) engineRequest({ type: "page", key: version.value, page: page - 1, id: requestId });
      viewInfo.textContent = "쪽을 표시하고 있습니다…";
    }
  } else if (viewMode.value === "text" && !model && advanced) {
    const text = document.createElement("pre");
    text.className = "engine-text";
    text.textContent = advanced.text;
    preview.append(text);
    viewInfo.textContent = "텍스트 보기";
  } else {
    preview.append(renderView(model, viewMode.value === "text" ? "text" : "document", isResult ? to.value : ""));
    if (viewMode.value === "text") viewInfo.textContent = model ? "텍스트 보기" : "";
    else adjustZoom();
  }
  preview.scrollTop = 0;
  preview.scrollLeft = 0;
}

viewMode.addEventListener("change", render);
version.addEventListener("change", () => { pageNumber.value = 1; render(); });
pageNumber.addEventListener("change", () => render());
previousPage.addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) - 1; render(); });
nextPage.addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) + 1; render(); });
passwordForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!sourceBytes) return;
  const secret = password.value;
  password.value = "";
  openEngine(sourceBytes, "original", secret);
});
zoom.addEventListener("change", adjustZoom);
new ResizeObserver(() => {
  if (viewMode.value !== "text") adjustZoom();
}).observe(preview);

function resetResult() {
  result = null;
  resultView = null;
  engineViews.delete("result");
  download.disabled = true;
  version.value = "original";
  version.querySelector('[value="result"]').disabled = true;
  render();
}

fileInput.addEventListener("change", async () => {
  worker?.terminate();
  worker = null;
  original = null;
  clearTimeout(engineTimer);
  engineWorker?.terminate();
  engineWorker = null;
  engineViews.clear();
  pendingJobs = 0;
  engineError = "";
  sourceBytes = null;
  pageNumber.value = 1;
  passwordForm.hidden = true;
  password.value = "";
  editable = false;
  controls.disabled = true;
  resetResult();
  const file = fileInput.files[0];
  if (!file) { fileInfo.textContent = "파일을 선택하세요."; message("파일을 선택하면 본문을 표시합니다."); return; }
  filename = file.name.replace(/\.hwp$/i, "") + "_수정.hwp";
  fileInfo.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 32 * 1024 * 1024) { message("파일 크기는 최대 32 MB입니다.", true); return; }
  try {
    const bytes = await file.arrayBuffer();
    if (fileInput.files[0] !== file) return;
    sourceBytes = bytes;
    openEngine(bytes, "original");
  } catch { message("파일을 읽지 못했습니다. 다시 선택하세요.", true); return; }
  if (!/\.hwp$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
    message("이 문서는 보기만 지원합니다. 치환은 8 MB 이하의 단순 HWP 5.0 본문에서 사용할 수 있습니다.");
    return;
  }
  message("본문과 서식을 읽고 있습니다…");
  const current = new Worker(new URL("./worker.js", import.meta.url));
  worker = current;
  current.onmessage = event => {
    if (worker !== current) return;
    const data = event.data;
    if (data.type === "opened") {
      original = data.view;
      editable = data.editable;
      controls.disabled = !editable;
      render();
      message(editable ? `${data.sections}개 구역, ${data.paragraphs.length}개 문단을 읽었습니다. 바꿀 단어를 입력하세요.` : data.reason);
    } else if (data.type === "replaced") {
      controls.disabled = false;
      result = data.bytes;
      resultView = data.view;
      download.disabled = false;
      version.querySelector('[value="result"]').disabled = false;
      version.value = "result";
      pageNumber.value = 1;
      openEngine(data.bytes.buffer, "result");
      message(`${data.count}곳을 바꿨습니다. 결과를 내려받아 한글에서 확인하세요.`);
    } else if (data.type === "error") {
      controls.disabled = !editable;
      message(editable ? data.message : `치환은 지원하지 않는 문서입니다. ${data.message}`, editable);
    }
  };
  current.onerror = () => {
    if (worker !== current) return;
    controls.disabled = true;
    message("처리기를 실행하지 못했습니다. 서버로 접속했는지 확인하고 파일을 다시 선택하세요.", true);
  };
  try {
    const bytes = sourceBytes.slice(0);
    if (worker === current) current.postMessage({ type: "open", bytes }, [bytes]);
  } catch { if (worker === current) message("파일을 읽지 못했습니다. 다시 선택하세요.", true); }
});

for (const field of [from, to]) field.addEventListener("input", () => {
  resetResult();
  if (editable) message("원본 기준으로 치환 결과를 다시 확인하세요.");
});

document.querySelector("#replace-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!worker || !editable) return;
  resetResult();
  controls.disabled = true;
  message("단어를 바꾸고 저장 결과를 검사하고 있습니다…");
  worker.postMessage({ type: "replace", from: from.value, to: to.value });
});

download.addEventListener("click", () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([result], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
