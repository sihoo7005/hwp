// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
const fileInput = document.querySelector("#file");
const controls = document.querySelector("#controls");
const from = document.querySelector("#from");
const to = document.querySelector("#to");
const download = document.querySelector("#download");
const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
const previewState = document.querySelector("#preview-state");
const fileInfo = document.querySelector("#file-info");
let worker;
let original = [];
let result;
let filename;
let editable = false;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function render(paragraphs, highlight = "") {
  const fragment = document.createDocumentFragment();
  for (const text of paragraphs) {
    const p = document.createElement("p");
    if (!highlight) p.textContent = text || "\u00a0";
    else {
      const parts = text.split(highlight);
      parts.forEach((part, i) => {
        if (i) { const mark = document.createElement("mark"); mark.textContent = highlight; p.append(mark); }
        p.append(document.createTextNode(part));
      });
    }
    fragment.append(p);
  }
  preview.replaceChildren(fragment);
}

function resetResult() {
  result = null;
  download.disabled = true;
  previewState.textContent = "원본";
}

fileInput.addEventListener("change", async () => {
  worker?.terminate();
  worker = null;
  original = [];
  editable = false;
  controls.disabled = true;
  resetResult();
  render([]);
  const file = fileInput.files[0];
  if (!file) { fileInfo.textContent = "파일을 선택하세요."; message("파일을 선택하면 본문을 표시합니다."); return; }
  filename = file.name.replace(/\.hwp$/i, "") + "_수정.hwp";
  fileInfo.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 8 * 1024 * 1024) { message("파일 크기는 최대 8 MB입니다.", true); return; }
  message("본문을 읽고 있습니다…");
  const current = new Worker(new URL("./worker.js", import.meta.url));
  worker = current;
  current.onmessage = event => {
    if (worker !== current) return;
    const data = event.data;
    if (data.type === "opened") {
      original = data.paragraphs;
      editable = data.editable;
      controls.disabled = !editable;
      render(original);
      message(editable ? `${data.sections}개 구역, ${original.length}개 문단을 읽었습니다. 바꿀 단어를 입력하세요.` : data.reason);
    } else if (data.type === "replaced") {
      controls.disabled = false;
      result = data.bytes;
      download.disabled = false;
      render(data.paragraphs, to.value);
      previewState.textContent = "치환 결과";
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
  render(original);
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
