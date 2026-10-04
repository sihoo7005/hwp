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
  viewInfo.textContent = width ? `${papers.length}개 구역 · ${Math.round(scale * 100)}%` : "";
}

function render() {
  const isResult = version.value === "result" && resultView;
  const model = isResult ? resultView : original;
  preview.dataset.mode = viewMode.value;
  preview.replaceChildren(renderView(model, viewMode.value, isResult ? to.value : ""));
  previewState.textContent = isResult ? "치환 결과" : "원본";
  viewMode.disabled = !model;
  version.disabled = !model;
  zoom.disabled = !model || viewMode.value === "text";
  if (viewMode.value === "text") viewInfo.textContent = model ? "텍스트 보기" : "";
  else adjustZoom();
  preview.scrollTop = 0;
  preview.scrollLeft = 0;
}

viewMode.addEventListener("change", render);
version.addEventListener("change", render);
zoom.addEventListener("change", adjustZoom);
new ResizeObserver(() => {
  if (viewMode.value === "document") adjustZoom();
}).observe(preview);

function resetResult() {
  result = null;
  resultView = null;
  download.disabled = true;
  version.value = "original";
  version.querySelector('[value="result"]').disabled = true;
  render();
}

fileInput.addEventListener("change", async () => {
  worker?.terminate();
  worker = null;
  original = null;
  editable = false;
  controls.disabled = true;
  resetResult();
  const file = fileInput.files[0];
  if (!file) { fileInfo.textContent = "파일을 선택하세요."; message("파일을 선택하면 본문을 표시합니다."); return; }
  filename = file.name.replace(/\.hwp$/i, "") + "_수정.hwp";
  fileInfo.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 8 * 1024 * 1024) { message("파일 크기는 최대 8 MB입니다.", true); return; }
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
      render();
      message(`${data.count}곳을 바꿨습니다. 결과를 내려받아 한글에서 확인하세요.`);
    } else if (data.type === "error") {
      controls.disabled = !editable;
      message(data.message, true);
    }
  };
  current.onerror = () => {
    if (worker !== current) return;
    controls.disabled = true;
    message("처리기를 실행하지 못했습니다. 서버로 접속했는지 확인하고 파일을 다시 선택하세요.", true);
  };
  try {
    const bytes = await file.arrayBuffer();
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
