// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
const $ = selector => document.querySelector(selector);
const fileInput = $("#file"), viewMode = $("#view-mode"), preview = $("#preview");
const status = $("#status"), pageNumber = $("#page-number"), zoom = $("#zoom");
const undo = $("#undo"), redo = $("#redo"), save = $("#save");
const menuTabs = [...document.querySelectorAll('.menu-tabs [role="tab"]')];
const drafts = new Map(), composing = new Set(), requests = new Map();
let worker, state, sourceBytes, currentFile, imageUrl, pageCache;
let nextId = 0, generation = 0, pageRequest = 0, editTimer, flushing, actionBusy = false;
let pictureEditor, pictureFileContext;
const { PageEditor } = await import("./page-editor.mjs" + new URL(import.meta.url).search);
const { PictureEditor, readPicture } = await import("./picture-editor.mjs" + new URL(import.meta.url).search);
const { HU_PER_PX } = await import("./picture-core.mjs" + new URL(import.meta.url).search);
const { paragraphKey, sameParagraph, runAddress } = await import("./text-address.mjs" + new URL(import.meta.url).search);
const pageEditor = new PageEditor({
  change(draft, isComposing) {
    drafts.set(paragraphKey(draft), draft);
    updateButtons(); clearTimeout(editTimer);
    if (!isComposing && !composing.size) editTimer = setTimeout(() => flushDrafts().catch(e => message(e.message, true)), 60);
  },
  composition(active, paragraph) {
    const key = paragraphKey(paragraph);
    if (active) { composing.add(key); clearTimeout(editTimer); } else composing.delete(key);
    updateButtons();
  },
  commit() { if (drafts.size && !composing.size) flushDrafts().catch(e => message(e.message, true)); },
  follow() { if (state && viewMode.value === "document") renderView(true); },
  warn(text) { message(text); }
});
pictureEditor = new PictureEditor(pageEditor, { change: pictureAction, warn: message, resize: adjustZoom, selection: pictureSelection });
pageEditor.image.onerror = () => { if (preview.contains(pageEditor.image)) message("쪽 이미지를 표시하지 못했습니다. 텍스트 보기를 이용하세요.", true); };

function selectMenu(tab, focus = false) {
  for (const item of menuTabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    $(`#${item.getAttribute("aria-controls")}`).hidden = !selected;
  }
  if (focus) tab.focus();
}
$(".menu-tabs").addEventListener("click", event => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectMenu(tab);
});
$(".menu-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = menuTabs.filter(tab => !tab.hidden), index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  selectMenu(tabs[next], true);
});
function syncRibbon() {
  for (const button of document.querySelectorAll("[data-command]")) {
    const source = $(`#${button.dataset.command}`);
    button.disabled = source.disabled || !!source.closest("#picture-panel")?.hidden;
  }
  for (const button of document.querySelectorAll("[data-view]")) button.disabled = viewMode.disabled;
  for (const button of document.querySelectorAll("[data-zoom]")) button.disabled = zoom.disabled;
  $("#toggle-ruler").disabled = zoom.disabled;
}
function pictureSelection(picture) {
  const tab = $("#tab-picture"), wasHidden = tab.hidden;
  tab.hidden = !picture;
  $("#inspector-context").textContent = picture ? "그림" : "문서";
  if (picture && wasHidden) selectMenu(tab);
  else if (!picture && tab.getAttribute("aria-selected") === "true") selectMenu($("#tab-edit"));
  syncRibbon();
}
function updateRuler() {
  const image = preview.querySelector(".page-image"), strip = $("#ruler-strip");
  strip.hidden = !image || viewMode.value !== "document" || $("#toggle-ruler").getAttribute("aria-pressed") !== "true";
  if (strip.hidden) return;
  const box = image.getBoundingClientRect(), width = Number(image.dataset.width), scale = box.width / width;
  const ruler = $("#page-ruler"), mm = 96 / 25.4 * scale;
  ruler.style.width = `${box.width}px`;
  ruler.style.marginLeft = `${box.left - strip.getBoundingClientRect().left}px`;
  ruler.style.setProperty("--ruler-step", `${10 * mm}px`);
  ruler.replaceChildren();
  for (let value = 20; value * mm < box.width; value += 20) {
    const label = document.createElement("span"); label.textContent = value;
    label.style.left = `${value * mm}px`; ruler.append(label);
  }
}
preview.addEventListener("scroll", updateRuler, { passive: true });
$("#toggle-ruler").addEventListener("click", event => {
  const button = event.currentTarget;
  button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
  updateRuler();
});

function message(text, error = false) {
  status.textContent = text;
  status.title = text;
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
  preview.dataset.pending = String(drafts.size > 0 || composing.size > 0);
  $(".document-heading").dataset.dirty = String(hasUnsaved());
  $("#preview-state").hidden = !state;
  undo.disabled = busy || (!state?.canUndo && !drafts.size);
  redo.disabled = busy || !state?.canRedo || drafts.size > 0;
  save.disabled = busy || !state?.canEdit || !hasUnsaved();
  $("#picture-add").disabled = busy || !state?.canEdit || viewMode.value !== "document";
  pageEditor.input.readOnly = busy;
  pictureEditor?.setBusy(busy);
  $("#edit-state").textContent = !state ? "" : hasUnsaved() ? "저장하지 않은 변경" : "변경 없음";
  $("#inspector-file").textContent = currentFile?.name || "열린 문서가 없습니다.";
  $("#inspector-format").textContent = state?.format.toUpperCase() || "—";
  $("#inspector-pages").textContent = state ? `${state.pages}쪽` : "—";
  $("#inspector-edit").textContent = !state ? "문서 대기" : !state.canEdit ? "보기 전용" : hasUnsaved() ? "저장하지 않은 변경" : "변경 없음";
  syncRibbon();
}

function updateState(data, followCaret = true) {
  state = data;
  preview.dataset.revision = state.revision;
  pageEditor.sync(state.paragraphs, drafts);
  viewMode.disabled = false;
  viewMode.querySelector('[value="document"]').textContent = state.canEdit ? "문서 편집" : "문서 보기";
  $("#preview-state").textContent = state.revision === 0 ? "원본" : state.dirty ? "수정 중" : "저장한 수정본";
  $("#viewer-status").textContent = `${state.format.toUpperCase()} · ${state.pages}쪽${state.warnings ? ` · 서식 검사 안내 ${state.warnings}건` : ''}${state.unsupported ? ` · 미지원 HML 요소 ${state.unsupported}건` : ''}${state.truncated ? ' · 전체 텍스트는 처음 20만 글자까지 표시' : ''}`;
  $("#document-properties").textContent = `${$("#viewer-status").textContent} · ${state.canEdit ? "본문·표 셀·사진 편집 가능" : state.reason || "보기 전용"}`;
  updateButtons();
  renderView(followCaret);
}

async function flushDrafts() {
  clearTimeout(editTimer);
  if (composing.size) throw new Error("한글 조합 입력을 완료한 뒤 저장하거나 실행 취소하세요.");
  if (flushing) { await flushing; if (drafts.size) return flushDrafts(); return; }
  const epoch = generation;
  const job = (async () => {
    while (drafts.size && epoch === generation) {
      const [key, draft] = drafts.entries().next().value;
      const before = state.paragraphs.find(p => sameParagraph(p, draft))?.text;
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
  if (!image) { $("#view-info").textContent = state && viewMode.value === "text" ? "텍스트 보기" : ""; updateRuler(); return; }
  const width = Number(image.dataset.width);
  const style = getComputedStyle(preview);
  const available = preview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const scale = zoom.value === "fit" ? Math.min(1, Math.max(.05, available / width)) : Number(zoom.value);
  pageEditor.surface.style.zoom = scale;
  pictureEditor?.paint();
  $("#view-info").textContent = `문서 ${state?.canEdit ? "편집" : "보기"} · ${Math.round(scale * 100)}%`;
  updateRuler();
}

function showPage(data) {
  const root = new DOMParser().parseFromString(data.svg, "image/svg+xml").documentElement;
  const width = Number(root.getAttribute("width")), height = Number(root.getAttribute("height"));
  if (root.localName !== "svg" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384)
    throw new Error("쪽 이미지의 크기 또는 형식이 올바르지 않습니다.");
  releaseImage();
  imageUrl = URL.createObjectURL(new Blob([data.svg], { type: "image/svg+xml" }));
  pageEditor.show(data, imageUrl, width, height);
  pictureEditor.show(data);
  if (!preview.contains(pageEditor.surface)) preview.replaceChildren(pageEditor.surface);
  pageNumber.value = data.page + 1;
  updateNavigation();
  adjustZoom();
}

function updateNavigation() {
  $("#page-navigation").hidden = viewMode.value !== "document" || !state;
  zoom.disabled = viewMode.value !== "document" || !state;
  pageNumber.disabled = !state;
  pageNumber.max = state?.pages || 1;
  pageNumber.value = Math.min(state?.pages || 1, Math.max(1, Math.trunc(Number(pageNumber.value)) || 1));
  $("#previous-page").disabled = !state || Number(pageNumber.value) <= 1;
  $("#next-page").disabled = !state || Number(pageNumber.value) >= state.pages;
  $("#page-total").textContent = state ? `/ ${state.pages}쪽` : "";
  syncRibbon();
}

function renderView(followCaret = false) {
  const token = ++pageRequest, epoch = generation;
  updateNavigation();
  preview.dataset.empty = String(!state);
  if (!state) { releaseImage(); preview.replaceChildren($("#empty-document").content.cloneNode(true)); $("#view-info").textContent = ""; updateRuler(); return; }
  preview.dataset.mode = viewMode.value;
  if (viewMode.value === "text") {
    pictureEditor.select(null);
    releaseImage();
    const text = document.createElement("pre"); text.className = "engine-text"; text.textContent = state.text; preview.replaceChildren(text); adjustZoom(); return;
  }
  const page = Number(pageNumber.value) - 1;
  if (!followCaret && pageCache?.page === page && pageCache.revision === state.revision) { showPage(pageCache); return; }
  $("#view-info").textContent = "쪽을 표시하고 있습니다…";
  request("page", { page, caret: pageEditor.caret(), followCaret }).then(data => {
    if (token !== pageRequest || epoch !== generation || data.revision !== state?.revision) return;
    pageCache = data;
    showPage(data);
  }).catch(e => { if (epoch === generation && token === pageRequest) message(e.message, true); });
}

async function loadFile(file, secret = "") {
  const epoch = ++generation;
  stopWorker();
  clearTimeout(editTimer);
  drafts.clear(); composing.clear(); pageEditor.reset();
  pictureEditor.reset(); pictureFileContext = null;
  state = null; sourceBytes = null; pageCache = null; flushing = null; actionBusy = false;
  $("#viewer-status").textContent = "";
  $("#document-properties").textContent = "";
  $("#preview-state").textContent = "원본";
  currentFile = file;
  $("#document-title").textContent = file?.name || "문서를 열어 주세요";
  $("#document-title").title = $("#document-title").textContent;
  document.title = file ? `${file.name} · HWP 에디터` : "HWP 에디터";
  viewMode.disabled = true;
  viewMode.value = "document";
  pageNumber.value = 1;
  $("#password-form").hidden = true;
  $("#password").value = "";
  updateButtons(); renderView();
  if (!file) { $("#file-info").textContent = "파일을 선택하세요."; message("문서를 열면 본문과 표 셀을 직접 수정할 수 있습니다."); return; }
  $("#file-info").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  if (file.size > 32 * 1024 * 1024) { message("파일 크기는 최대 32 MB입니다.", true); return; }
  message("문서와 편집할 텍스트를 읽고 있습니다…");
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
    updateState(data, false);
    message(data.canEdit ? "문서의 글자를 클릭해 바로 입력·삭제하세요. 수정한 파일 저장으로 내려받을 수 있습니다." : data.reason || "텍스트 편집은 지원하지 않는 문서입니다. 쪽 보기로 확인하세요.");
  } catch (error) {
    if (epoch !== generation) return;
    $("#password-form").hidden = !error.passwordRequired;
    if (error.passwordRequired) { message(/일치/.test(error.message) ? "비밀번호가 일치하지 않습니다. 다시 입력하세요." : "비밀번호를 입력해 문서를 여세요."); $("#password").focus(); }
    else message(error.message, true);
    updateButtons();
  }
}

function chooseFile(file) {
  if (!file) return;
  if (hasUnsaved() && !window.confirm("저장하지 않은 변경이 있습니다. 변경을 버리고 다른 문서를 열까요?")) { fileInput.value = ""; return; }
  fileInput.value = "";
  loadFile(file);
}
fileInput.addEventListener("change", () => chooseFile(fileInput.files[0]));
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.hasAttribute("data-open-file")) fileInput.click();
  else if (button.dataset.command) $(`#${button.dataset.command}`).click();
  else if (button.dataset.view) { viewMode.value = button.dataset.view; viewMode.dispatchEvent(new Event("change")); }
  else if (button.dataset.zoom) { zoom.value = button.dataset.zoom; zoom.dispatchEvent(new Event("change")); }
});
$("#help").addEventListener("click", () => $("#help-dialog").showModal());
window.addEventListener("dragover", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "copy";
  $(".workspace").classList.add("file-drag");
});
window.addEventListener("dragleave", event => { if (!event.relatedTarget) $(".workspace").classList.remove("file-drag"); });
window.addEventListener("drop", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault(); $(".workspace").classList.remove("file-drag");
  const file = event.dataTransfer.files[0];
  if (file?.type.startsWith("image/")) {
    const hit = pageEditor.atPoint(event);
    if (hit?.run.editable) { pictureEditor.select(null); pageEditor.activate(hit.run, hit.offset, false); }
    pictureAction(pictureEditor.selected ? "replace" : "insert", { file });
  } else chooseFile(file);
});
$("#password-form").addEventListener("submit", event => { event.preventDefault(); const secret = $("#password").value; $("#password").value = ""; if (currentFile && sourceBytes) loadFile(currentFile, secret); });
viewMode.addEventListener("change", () => flushDrafts().then(() => renderView()).catch(e => message(e.message, true)));
pageNumber.addEventListener("change", () => renderView());
$("#previous-page").addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) - 1; renderView(); });
$("#next-page").addEventListener("click", () => { pageNumber.value = Number(pageNumber.value) + 1; renderView(); });
zoom.addEventListener("change", adjustZoom);
new ResizeObserver(adjustZoom).observe(preview);

function pictureCaret() {
  const caret = pageEditor.caret();
  if (caret && state?.paragraphs.some(p => p.editable && sameParagraph(p, caret))) return caret;
  const run = pageEditor.runs.find(r => r.editable);
  if (run) return { ...runAddress(run), offset: run.charStart };
  const paragraph = state?.paragraphs.find(p => p.editable);
  return paragraph ? { ...paragraph, offset: 0 } : null;
}

function choosePicture(action) {
  const caret = action === "insert" ? pictureCaret() : pageEditor.caret();
  if (action === "insert" && !caret) { message("사진을 추가할 수 있는 일반 본문이나 표 셀이 없습니다."); return; }
  if (action === "replace" && !pictureEditor.selected) return;
  pictureFileContext = { action, epoch: generation, picture: pictureEditor.selected, caret };
  $("#picture-file").click();
}
$("#picture-add").addEventListener("click", () => choosePicture("insert"));
$("#picture-replace").addEventListener("click", () => choosePicture("replace"));
$("#picture-file").addEventListener("change", () => {
  const file = $("#picture-file").files[0], context = pictureFileContext;
  $("#picture-file").value = ""; pictureFileContext = null;
  if (file && context?.epoch === generation) pictureAction(context.action, { ...context, file });
});
document.addEventListener("paste", event => {
  if (!state?.canEdit || event.target.closest("#picture-panel")) return;
  const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (file) { event.preventDefault(); pictureAction(pictureEditor.selected ? "replace" : "insert", { file }); }
});

async function pictureAction(action, options = {}) {
  if (actionBusy || !state?.canEdit) return;
  const epoch = generation, selected = options.picture || pictureEditor.selected;
  const caret = options.caret || (action === "insert" ? pictureCaret() : pageEditor.caret());
  if (action === "insert" && !caret) { message("사진을 추가할 수 있는 일반 본문이나 표 셀이 없습니다."); return; }
  if (action !== "insert" && !selected) return;
  actionBusy = true; updateButtons(); message("사진 변경을 반영하고 있습니다…");
  try {
    await flushDrafts();
    if (epoch !== generation) return;
    const revision = state.revision;
    const data = { action, picture: selected, caret, page: selected?.page ?? Number(pageNumber.value) - 1,
      revision, props: options.props || {} };
    if (options.file) {
      data.image = await readPicture(options.file);
      if (action === "insert") {
        const run = pageEditor.runs.find(r => sameParagraph(runAddress(r), caret));
        const maxWidth = Math.min(320, run?.cellBounds ? run.cellBounds.w - 8 : Number(pageEditor.image.dataset.width) - 60);
        const scale = Math.min(1, maxWidth / data.image.width, 400 / data.image.height);
        data.props = { width: Math.max(75, Math.round(data.image.width * scale * HU_PER_PX)),
          height: Math.max(75, Math.round(data.image.height * scale * HU_PER_PX)) };
      }
    }
    if (action === "crop") {
      if (!Object.values(options.crop).some(Boolean)) { message("잘라낼 비율을 입력하세요."); return; }
      const source = await request("picture-source", { picture: selected, page: data.page, revision });
      data.image = await readPicture(new Blob([source.bytes], { type: source.mime }), options.crop, source);
      const horizontal = 1 - (options.crop.left + options.crop.right) / 100;
      const vertical = 1 - (options.crop.top + options.crop.bottom) / 100;
      const swapped = Math.abs(selected.props.rotationAngle % 180) === 90;
      data.props = { width: Math.max(1, Math.round(selected.props.width * (swapped ? vertical : horizontal))),
        height: Math.max(1, Math.round(selected.props.height * (swapped ? horizontal : vertical))) };
      data.action = "replace";
    }
    if (epoch !== generation) return;
    const result = await request("picture", data, data.image ? [data.image.bytes.buffer] : []);
    if (epoch !== generation) return;
    pictureEditor.pendingSelection = result.selectedPicture;
    if (Number.isInteger(result.selectedPicture?.page)) pageNumber.value = result.selectedPicture.page + 1;
    if (!result.selectedPicture) pictureEditor.select(null);
    updateState(result, false);
    message(action === "delete" ? "사진을 삭제했습니다. 실행 취소로 복원할 수 있습니다." : "사진 변경을 반영했습니다. 저장 버튼으로 내려받으세요.");
  } catch (error) { if (epoch === generation) { message(error.message, true); pictureEditor.paint(); } }
  finally { if (epoch === generation) { actionBusy = false; updateButtons(); } }
}

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
      const saved = await request("saved", { revision: data.revision });
      if (epoch !== generation) return;
      updateState(saved, false);
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
  else if (event.key.toLowerCase() === "z" && (event.target === pageEditor.input || !event.target.matches("textarea,input"))) { event.preventDefault(); action(event.shiftKey ? "redo" : "undo"); }
});
window.addEventListener("beforeunload", event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } });
updateButtons();
renderView();
