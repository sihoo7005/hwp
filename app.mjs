// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
const $ = selector => document.querySelector(selector);
const fileInput = $("#file"), viewMode = $("#view-mode"), preview = $("#preview");
const status = $("#status"), pageNumber = $("#page-number"), zoom = $("#zoom");
const editor = $("#text-editor"), undo = $("#undo"), redo = $("#redo"), save = $("#save");
const drafts = new Map(), fields = new Map(), composing = new Set(), requests = new Map();
let worker, state, sourceBytes, currentFile, imageUrl, pageCache;
let nextId = 0, generation = 0, pageRequest = 0, editTimer, flushing, actionBusy = false;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function request(type, data = {}, transfer = []) {
  if (!worker) return Promise.reject(new Error("문서를 먼저 열어 주세요."));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!requests.has(id)) return;
      stopWorker("문서 처리가 45초를 넘었습니다. 입력한 텍스트를 복사한 뒤 문서를 다시 열어 주세요.");
      updateButtons();
    }, 45000);
    requests.set(id, { resolve, reject, timer });
    worker.postMessage({ id, type, ...data }, transfer);
  });
}

function stopWorker(reason = "다른 문서를 열었습니다.") {
  worker?.terminate();
  worker = null;
  for (const entry of requests.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
  requests.clear();
}

function hasUnsaved() { return !!state?.dirty || drafts.size > 0 || composing.size > 0; }
function updateButtons() {
  const busy = actionBusy || !worker;
  undo.disabled = busy || (!state?.canUndo && !drafts.size);
  redo.disabled = busy || !state?.canRedo || drafts.size > 0;
  save.disabled = busy || !state?.canEdit || !hasUnsaved();
  $("#edit-state").textContent = !state ? "" : hasUnsaved() ? "저장하지 않은 변경" : "변경 없음";
}

function resizeField(field) { field.style.height = "auto"; field.style.height = `${Math.max(44, field.scrollHeight)}px`; }

function renderEditor() {
  editor.replaceChildren();
  fields.clear();
  if (!state?.canEdit) return;
  let section = -1;
  for (const p of state.paragraphs) {
    if (section !== p.section) {
      section = p.section;
      const title = document.createElement("h3");
      title.textContent = `구역 ${section + 1}`;
      editor.append(title);
    }
    const key = `${p.section}:${p.paragraph}`;
    const label = document.createElement("label");
    label.className = "editor-paragraph";
    const caption = document.createElement("span");
    caption.className = "paragraph-label";
    caption.textContent = `문단 ${p.paragraph + 1}${p.editable ? '' : p.object ? ' · 표·그림 등 개체 포함 (보기 전용)' : ' · 보기 전용'}`;
    const field = document.createElement("textarea");
    field.id = `paragraph-${p.section}-${p.paragraph}`;
    field.dataset.section = p.section;
    field.dataset.paragraph = p.paragraph;
    field.value = p.text;
    field.readOnly = !p.editable;
    field.maxLength = 20000;
    field.rows = 1;
    field.spellcheck = false;
    field.placeholder = p.object ? "개체는 쪽 보기에서 확인하세요." : "여기에 입력하세요.";
    field.addEventListener("compositionstart", () => { composing.add(key); clearTimeout(editTimer); });
    const changed = event => {
      resizeField(field);
      drafts.set(key, { section: p.section, paragraph: p.paragraph, text: field.value });
      updateButtons();
      clearTimeout(editTimer);
      if (!event?.isComposing && !composing.size) editTimer = setTimeout(() => flushDrafts().catch(e => message(e.message, true)), 250);
    };
    field.addEventListener("input", changed);
    field.addEventListener("compositionend", () => { composing.delete(key); changed(); });
    label.append(caption, field);
    editor.append(label);
    fields.set(key, field);
  }
  for (const field of fields.values()) resizeField(field);
}

function updateState(data, rebuild = false) {
  state = data;
  if (rebuild) renderEditor();
  else for (const p of state.paragraphs) {
    const key = `${p.section}:${p.paragraph}`, field = fields.get(key);
    if (field && !drafts.has(key) && !composing.has(key)) {
      if (field.value !== p.text) { field.value = p.text; resizeField(field); }
    }
  }
  viewMode.disabled = false;
  viewMode.querySelector('[value="edit"]').disabled = !state.canEdit;
  if (viewMode.value === "edit" && !state.canEdit) viewMode.value = "document";
  $("#preview-state").textContent = state.revision === 0 ? "원본" : state.dirty ? "수정 중" : "저장한 수정본";
  $("#viewer-status").textContent = `${state.format.toUpperCase()} · ${state.pages}쪽${state.warnings ? ` · 서식 검사 안내 ${state.warnings}건` : ''}${state.unsupported ? ` · 미지원 HML 요소 ${state.unsupported}건` : ''}${state.truncated ? ' · 전체 텍스트는 처음 20만 글자까지 표시' : ''}`;
  updateButtons();
  renderView();
}

async function flushDrafts() {
  clearTimeout(editTimer);
  if (composing.size) throw new Error("한글 조합 입력을 완료한 뒤 저장하거나 실행 취소하세요.");
  if (flushing) { await flushing; if (drafts.size) return flushDrafts(); return; }
  const epoch = generation;
  const job = (async () => {
    while (drafts.size && epoch === generation) {
      const [key, draft] = drafts.entries().next().value;
      const before = state.paragraphs.find(p => p.section === draft.section && p.paragraph === draft.paragraph)?.text;
      const data = await request("edit", { ...draft, before });
      if (epoch !== generation) return;
      if (drafts.get(key) === draft) drafts.delete(key);
      updateState(data);
      message("입력한 텍스트를 반영했습니다. 저장 버튼으로 새 파일을 내려받으세요.");
    }
  })();
  flushing = job;
  try { await job; } finally { if (flushing === job) flushing = null; updateButtons(); }
}

function releaseImage() { if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; }
function adjustZoom() {
  const image = preview.querySelector(".page-image");
  if (!image) { $("#view-info").textContent = viewMode.value === "edit" ? "본문 텍스트 편집" : "텍스트 보기"; return; }
  const width = Number(image.dataset.width);
  const scale = zoom.value === "fit" ? Math.min(1, Math.max(.05, (preview.clientWidth - 32) / width)) : Number(zoom.value);
  image.style.zoom = scale;
  $("#view-info").textContent = `쪽 보기 · ${Math.round(scale * 100)}%`;
}

function showPage(data) {
  const root = new DOMParser().parseFromString(data.svg, "image/svg+xml").documentElement;
  const width = Number(root.getAttribute("width")), height = Number(root.getAttribute("height"));
  if (root.localName !== "svg" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384)
    throw new Error("쪽 이미지의 크기 또는 형식이 올바르지 않습니다.");
  releaseImage();
  imageUrl = URL.createObjectURL(new Blob([data.svg], { type: "image/svg+xml" }));
  const image = document.createElement("img");
  image.className = "document-paper page-image";
  image.dataset.width = width;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.alt = `${data.page + 1}쪽. 본문을 클릭하면 텍스트 편집으로 이동합니다.`;
  image.src = imageUrl;
  image.onerror = () => { if (preview.contains(image)) message("쪽 이미지를 표시하지 못했습니다. 텍스트 보기를 이용하세요.", true); };
  image.addEventListener("click", event => {
    if (!state?.canEdit) return;
    const rect = image.getBoundingClientRect();
    const x = (event.clientX - rect.left) * width / rect.width, y = (event.clientY - rect.top) * height / rect.height;
    const run = data.runs.find(r => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2);
    if (!run) return;
    viewMode.value = "edit";
    renderView();
    const field = fields.get(`${run.secIdx}:${run.paraIdx}`);
    if (!field || field.readOnly) return;
    const char = Math.max(0, (run.charX || []).findLastIndex(n => n <= x - run.x));
    const offset = Array.from(field.value).slice(0, run.charStart + char).join("").length;
    field.focus();
    field.setSelectionRange(offset, offset);
    field.scrollIntoView({ block: "nearest" });
  });
  preview.replaceChildren(image);
  adjustZoom();
}

function renderView() {
  const token = ++pageRequest, epoch = generation;
  const wasHidden = editor.hidden;
  editor.hidden = viewMode.value !== "edit" || !state;
  preview.hidden = viewMode.value === "edit" && !!state;
  $("#page-navigation").hidden = viewMode.value !== "document" || !state;
  zoom.disabled = viewMode.value !== "document" || !state;
  pageNumber.disabled = !state;
  pageNumber.max = state?.pages || 1;
  pageNumber.value = Math.min(state?.pages || 1, Math.max(1, Math.trunc(Number(pageNumber.value)) || 1));
  $("#previous-page").disabled = !state || Number(pageNumber.value) <= 1;
  $("#next-page").disabled = !state || Number(pageNumber.value) >= state.pages;
  $("#page-total").textContent = state ? `/ ${state.pages}쪽` : "";
  if (viewMode.value === "edit" && state) { if (wasHidden) for (const field of fields.values()) resizeField(field); adjustZoom(); return; }
  releaseImage();
  preview.replaceChildren();
  if (!state) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "문서를 열면 여기에 표시됩니다."; preview.append(p); return; }
  preview.dataset.mode = viewMode.value;
  if (viewMode.value === "text") {
    const text = document.createElement("pre"); text.className = "engine-text"; text.textContent = state.text; preview.append(text); adjustZoom(); return;
  }
  const page = Number(pageNumber.value) - 1;
  if (pageCache?.page === page && pageCache.revision === state.revision) { showPage(pageCache); return; }
  $("#view-info").textContent = "쪽을 표시하고 있습니다…";
  request("page", { page }).then(data => {
    if (token !== pageRequest || epoch !== generation || data.revision !== state?.revision) return;
    pageCache = data;
    showPage(data);
  }).catch(e => { if (epoch === generation && token === pageRequest) message(e.message, true); });
}

async function loadFile(file, secret = "") {
  const epoch = ++generation;
  stopWorker();
  clearTimeout(editTimer);
  drafts.clear(); composing.clear(); fields.clear(); editor.replaceChildren();
  state = null; sourceBytes = null; pageCache = null; flushing = null; actionBusy = false;
  $("#viewer-status").textContent = "";
  $("#preview-state").textContent = "원본";
  currentFile = file;
  viewMode.disabled = true;
  viewMode.value = "edit";
  pageNumber.value = 1;
  $("#password-form").hidden = true;
  $("#password").value = "";
  updateButtons(); renderView();
  if (!file) { $("#file-info").textContent = "파일을 선택하세요."; message("문서를 열면 본문을 직접 수정할 수 있습니다."); return; }
  $("#file-info").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 32 * 1024 * 1024) { message("파일 크기는 최대 32 MB입니다.", true); return; }
  message("문서와 편집할 본문을 읽고 있습니다…");
  try {
    const bytes = await file.arrayBuffer();
    if (epoch !== generation) return;
    sourceBytes = bytes;
    const workerUrl = new URL("./advanced-worker.mjs", import.meta.url);
    workerUrl.search = new URL(import.meta.url).search;
    const current = new Worker(workerUrl);
    worker = current;
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const entry = requests.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer); requests.delete(data.id);
      if (data.type === "error") {
        const error = new Error(data.message);
        error.passwordRequired = data.passwordRequired;
        entry.reject(error);
      } else entry.resolve(data);
    };
    current.onerror = () => { if (worker === current) { stopWorker("문서 처리기를 실행하지 못했습니다. 문서를 다시 열어 주세요."); updateButtons(); } };
    const copy = bytes.slice(0);
    const data = await request("open", { bytes: copy, password: secret }, [copy]);
    if (epoch !== generation) return;
    updateState(data, true);
    message(data.canEdit ? "본문을 클릭해 입력·삭제하세요. 같은 글자 수일 필요 없이 변경하고 저장할 수 있습니다." : data.reason || "본문 편집은 지원하지 않는 문서입니다. 쪽 보기로 확인하세요.");
  } catch (error) {
    if (epoch !== generation) return;
    $("#password-form").hidden = !error.passwordRequired;
    if (error.passwordRequired) { message(/일치/.test(error.message) ? "비밀번호가 일치하지 않습니다. 다시 입력하세요." : "비밀번호를 입력해 문서를 여세요."); $("#password").focus(); }
    else message(error.message, true);
    updateButtons();
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (hasUnsaved() && !window.confirm("저장하지 않은 변경이 있습니다. 변경을 버리고 다른 문서를 열까요?")) { fileInput.value = ""; return; }
  loadFile(file);
});
$("#password-form").addEventListener("submit", event => { event.preventDefault(); const secret = $("#password").value; $("#password").value = ""; if (currentFile && sourceBytes) loadFile(currentFile, secret); });
viewMode.addEventListener("change", () => flushDrafts().then(renderView).catch(e => message(e.message, true)));
pageNumber.addEventListener("change", renderView);
$("#previous-page").addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) - 1; renderView(); });
$("#next-page").addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) + 1; renderView(); });
zoom.addEventListener("change", adjustZoom);
new ResizeObserver(adjustZoom).observe(preview);

async function action(type) {
  if (actionBusy || !state?.canEdit) return;
  const epoch = generation;
  actionBusy = true; updateButtons();
  message(type === "save" ? "입력 내용을 반영하고 저장 파일을 검사하고 있습니다…" : "편집 이력을 반영하고 있습니다…");
  try {
    await flushDrafts();
    if (epoch !== generation) return;
    const data = await request(type);
    if (epoch !== generation) return;
    if (type === "save") {
      const url = URL.createObjectURL(new Blob([data.bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url; link.download = currentFile.name.replace(/\.[^.]+$/, "") + `_수정.${data.format}`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      updateState(await request("saved", { revision: data.revision }));
      message("저장 결과를 다시 열어 검사했습니다. 새 파일 다운로드를 시작했습니다.");
    } else { updateState(data); message(type === "undo" ? "실행을 취소했습니다." : "다시 실행했습니다."); }
  } catch (error) { if (epoch === generation) message(error.message, true); }
  finally { if (epoch === generation) { actionBusy = false; updateButtons(); } }
}
undo.addEventListener("click", () => action("undo"));
redo.addEventListener("click", () => action("redo"));
save.addEventListener("click", () => action("save"));
document.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); action("save"); }
  else if (event.key.toLowerCase() === "z" && !event.target.matches("textarea,input")) { event.preventDefault(); action(event.shiftKey ? "redo" : "undo"); }
});
window.addEventListener("beforeunload", event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } });
