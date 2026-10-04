const { paragraphKey, runAddress, sameParagraph } = await import("./text-address.mjs" + new URL(import.meta.url).search);
const length = text => Array.from(text).length;
export const toCodePoint = (text, offset) => length(text.slice(0, offset));
export const toUtf16 = (text, offset) => Array.from(text).slice(0, offset).join("").length;
const same = (run, p) => run.editable !== false && sameParagraph(runAddress(run), p);

export function offsetAt(run, x) {
  const stops = run.charX || [0];
  let nearest = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - x + run.x) < Math.abs(stops[nearest] - x + run.x)) nearest = i;
  return run.charStart + Math.min(nearest, length(run.text));
}

export function runAtPoint(runs, x, y) {
  const line = runs.filter(r => y >= r.y - 2 && y <= r.y + r.h + 2 &&
    (!r.cellBounds || (x >= r.cellBounds.x && x <= r.cellBounds.x + r.cellBounds.w)));
  const hit = line.find(r => x >= r.x && x <= r.x + Math.max(1, r.w)) ||
    line.filter(r => x >= r.x - 3 && x <= r.x + Math.max(12, r.w) + 12)
      .sort((a, b) => Math.min(Math.abs(x - a.x), Math.abs(x - a.x - a.w)) - Math.min(Math.abs(x - b.x), Math.abs(x - b.x - b.w)))[0];
  if (hit) return hit;
  // Clicking the blank part of a cell activates the closest line in that cell.
  return runs.filter(r => r.cellBounds && x >= r.cellBounds.x && x <= r.cellBounds.x + r.cellBounds.w &&
    y >= r.cellBounds.y && y <= r.cellBounds.y + r.cellBounds.h)
    .sort((a, b) => Math.abs(y - a.y - a.h / 2) - Math.abs(y - b.y - b.h / 2) ||
      Math.abs(x - a.x) - Math.abs(x - b.x))[0];
}

export function caretAt(runs, paragraph, offset) {
  const candidates = runs.filter(r => same(r, paragraph));
  const run = candidates.find(r => offset >= r.charStart && offset < r.charStart + length(r.text)) ||
    candidates.find(r => offset === r.charStart) || candidates.findLast(r => r.charStart <= offset);
  if (!run) return null;
  const index = Math.min(Math.max(0, offset - run.charStart), length(run.text));
  return { x: run.x + (run.charX?.[index] ?? run.w), y: run.y, height: run.h, run };
}

export function selectionRects(runs, paragraph, start, end) {
  return runs.filter(r => same(r, paragraph)).flatMap(r => {
    const a = Math.max(start, r.charStart), b = Math.min(end, r.charStart + length(r.text));
    if (a >= b) return [];
    const x = r.charX[a - r.charStart] ?? 0, right = r.charX[b - r.charStart] ?? r.w;
    return [{ x: r.x + x, y: r.y, width: Math.max(1, right - x), height: r.h }];
  });
}

// IMEs can report an entire word, including unchanged letters before the original caret.
export function compositionRange(original, value, selectionEnd, data = null) {
  if (typeof data === "string" && data.length) {
    const start = selectionEnd - data.length, end = original.length - (value.length - selectionEnd);
    if (start >= 0 && end >= start && value.slice(start, selectionEnd) === data &&
        original.slice(0, start) === value.slice(0, start) && original.slice(end) === value.slice(selectionEnd))
      return { start: toCodePoint(original, start), end: toCodePoint(original, end), text: data };
  }
  if (original === value) return null;
  const before = Array.from(original), after = Array.from(value);
  let start = 0, end = before.length, newEnd = after.length;
  while (start < end && start < newEnd && before[start] === after[start]) start++;
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) { end--; newEnd--; }
  return { start, end, text: after.slice(start, newEnd).join("") };
}

// Native textarea handles IME/clipboard; the document engine draws all formatted text.
export class PageEditor {
  constructor({ change, composition, commit, warn, follow }) {
    this.change = change; this.composition = composition; this.commit = commit; this.warn = warn;
    this.follow = follow;
    this.surface = document.createElement("div");
    this.surface.className = "document-paper page-surface";
    this.image = document.createElement("img");
    this.image.className = "page-image"; this.image.draggable = false;
    this.layer = document.createElement("div"); this.layer.className = "document-selection"; this.layer.setAttribute("aria-hidden", "true");
    this.input = document.createElement("textarea");
    this.input.id = "document-input"; this.input.className = "document-input";
    this.input.setAttribute("aria-label", "문서 본문과 표 셀 편집. 글자를 클릭하거나 방향키로 이동하세요.");
    this.input.spellcheck = false; this.input.maxLength = 20000; this.input.autocomplete = "off";
    this.surface.append(this.image, this.layer, this.input);
    this.reset();
    this.image.addEventListener("load", () => {
      this.renderedParagraphs = this.pageParagraphs;
      if (!this.isComposing && this.renderedText() === this.input.value) this.compositionPending = false;
      this.paint();
    });
    const changed = event => {
      if (!this.active) return;
      if (event?.isComposing) this.compositionData = event.data;
      else if (!this.isComposing) this.compositionData = null;
      this.change({ ...this.active, text: this.input.value }, this.isComposing);
      this.paint();
    };
    this.input.addEventListener("input", changed);
    this.input.addEventListener("compositionstart", () => {
      if (!this.active) return;
      this.isComposing = true; this.compositionData = null; this.compositionPending = false;
      this.compositionOffset = toCodePoint(this.input.value, this.input.selectionStart);
      this.composition(true, this.active);
    });
    this.input.addEventListener("compositionend", () => {
      this.isComposing = false;
      this.compositionPending = !!this.active && this.renderedText() !== this.input.value;
      if (this.active) { this.composition(false, this.active); changed(); }
    });
    this.input.addEventListener("focus", () => {
      if (!this.active) {
        const run = this.runs.find(r => r.editable);
        if (run) this.activate(run, run.charStart, false);
      }
      this.paint();
    });
    this.input.addEventListener("blur", () => { this.paint(); if (!this.isComposing) this.commit(); });
    this.input.addEventListener("select", () => this.selectionChanged());
    this.input.addEventListener("keyup", () => this.selectionChanged());
    this.input.addEventListener("keydown", event => this.navigate(event));
    document.addEventListener("selectionchange", () => { if (document.activeElement === this.input) this.selectionChanged(); });
    this.surface.addEventListener("pointerdown", event => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      event.preventDefault();
      const run = this.atPoint(event);
      if (!this.choose(run, event, event.shiftKey)) return;
      this.dragAnchor = this.input.selectionDirection === "backward" ? this.input.selectionEnd : this.input.selectionStart;
      this.dragging = true;
      if (event.isTrusted) this.surface.setPointerCapture(event.pointerId);
    });
    this.surface.addEventListener("pointermove", event => {
      if (!this.dragging) return;
      const hit = this.atPoint(event);
      // ponytail: selection stays in one paragraph; expand it with paragraph structure editing.
      if (!hit?.run.editable || !same(hit.run, this.active)) return;
      const offset = toUtf16(this.input.value, hit.offset);
      this.input.setSelectionRange(Math.min(this.dragAnchor, offset), Math.max(this.dragAnchor, offset), offset < this.dragAnchor ? "backward" : "forward");
      this.paint();
    });
    this.surface.addEventListener("pointerup", () => { this.dragging = false; });
    this.surface.addEventListener("pointercancel", () => { this.dragging = false; });
    this.surface.addEventListener("click", event => { if (event.pointerType === "touch") this.choose(this.atPoint(event), event); });
  }

  reset() {
    this.active = null; this.runs = []; this.paragraphs = []; this.drafts = new Map();
    this.isComposing = false; this.dragging = false; this.compositionData = null; this.compositionPending = false;
    this.renderedParagraphs = []; this.pageParagraphs = [];
    this.followKey = null;
    this.input.value = ""; this.input.disabled = true; this.input.blur(); this.layer.replaceChildren();
  }

  sync(paragraphs, drafts) {
    this.paragraphs = paragraphs; this.drafts = drafts;
    this.input.disabled = !paragraphs.some(p => p.editable);
    if (this.active && !this.isComposing && !drafts.has(paragraphKey(this.active))) {
      const p = paragraphs.find(p => sameParagraph(p, this.active));
      if (p && this.input.value !== p.text) {
        const start = this.input.selectionStart, end = this.input.selectionEnd, direction = this.input.selectionDirection;
        this.input.value = p.text; this.input.setSelectionRange(start, end, direction);
      }
    }
    this.paint();
  }

  show(data, url, width, height) {
    this.runs = data.runs; this.page = data.page; this.pageParagraphs = this.paragraphs;
    this.surface.style.width = `${width}px`; this.surface.style.height = `${height}px`;
    this.image.dataset.width = width; this.image.dataset.page = data.page; this.image.dataset.revision = data.revision;
    this.image.style.width = `${width}px`; this.image.style.height = `${height}px`;
    this.image.alt = `${data.page + 1}쪽. 본문이나 표 셀을 클릭해 이 문서 위에서 수정하세요.`;
    this.image.src = url;
    this.surface.classList.toggle("editable-page", data.runs.some(r => r.editable));
    this.paint();
    if (document.activeElement === this.input && this.active && caretAt(this.runs, this.active, this.caret().offset))
      this.input.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!this.active) {
      const first = this.runs.find(r => r.editable);
      if (first) { this.input.style.left = `${first.x}px`; this.input.style.top = `${first.y}px`; }
    }
  }

  caret() {
    if (!this.active) return null;
    const offset = this.input.selectionDirection === "backward" ? this.input.selectionStart : this.input.selectionEnd;
    return { ...this.active, offset: toCodePoint(this.input.value, offset) };
  }

  atPoint(event) {
    const box = this.image.getBoundingClientRect(), scale = Number(this.image.dataset.width) / box.width;
    const x = (event.clientX - box.left) * scale, y = (event.clientY - box.top) * scale;
    const run = runAtPoint(this.runs, x, y);
    return run ? { run, offset: offsetAt(run, x) } : null;
  }

  choose(hit, event, extend = false) {
    if (this.isComposing) return false;
    if (!hit) return false;
    if (!hit.run.editable) { this.input.blur(); this.warn("보호된 셀·개체가 있는 문단·중첩 표·머리말 등은 보기만 지원합니다."); return false; }
    this.activate(hit.run, hit.offset, true, extend);
    return true;
  }

  activate(run, offset, focus = true, extend = false) {
    const p = this.paragraphs.find(p => same(run, p));
    if (!p?.editable) return;
    const key = paragraphKey(p), current = this.active && same(run, this.active);
    const anchor = current && extend ? (this.input.selectionDirection === "backward" ? this.input.selectionEnd : this.input.selectionStart) : null;
    if (!current) {
      this.input.value = this.drafts.get(key)?.text ?? p.text;
      this.compositionPending = false; this.compositionData = null;
    }
    this.active = runAddress(run);
    this.input.dataset.section = p.section; this.input.dataset.paragraph = p.paragraph;
    for (const name of ["control", "cell", "cellParagraph"]) {
      if (p[name] === undefined) delete this.input.dataset[name]; else this.input.dataset[name] = p[name];
    }
    const position = toUtf16(this.input.value, offset);
    this.input.setSelectionRange(anchor === null ? position : Math.min(anchor, position), anchor === null ? position : Math.max(anchor, position), anchor !== null && position < anchor ? "backward" : "forward");
    if (focus) this.input.focus({ preventScroll: true });
    this.paint();
  }

  renderedText() { return this.renderedParagraphs.find(p => sameParagraph(p, this.active))?.text ?? this.input.value; }

  paint() {
    this.layer.replaceChildren();
    if (!this.active) return;
    const preview = (this.isComposing || this.compositionPending) ?
      compositionRange(this.renderedText(), this.input.value, this.input.selectionEnd, this.compositionData) : null;
    const point = caretAt(this.runs, this.active, preview?.start ?? (this.isComposing ? this.compositionOffset : this.caret().offset));
    if (!point) return;
    this.input.style.left = `${point.x}px`; this.input.style.top = `${point.y}px`;
    this.input.style.height = `${Math.max(16, point.height)}px`;
    if (document.activeElement !== this.input) return;
    const rects = selectionRects(this.runs, this.active, toCodePoint(this.input.value, this.input.selectionStart), toCodePoint(this.input.value, this.input.selectionEnd));
    for (const r of rects) {
      const mark = document.createElement("div"); mark.className = "selection-rect";
      Object.assign(mark.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      this.layer.append(mark);
    }
    const cursor = document.createElement("div"); cursor.className = "document-caret";
    Object.assign(cursor.style, { left: `${point.x}px`, top: `${point.y}px`, height: `${point.height}px` });
    this.layer.append(cursor);
    if (preview) {
      for (const r of selectionRects(this.runs, this.active, preview.start, preview.end)) {
        const mask = document.createElement("div"); mask.className = "composition-mask";
        Object.assign(mask.style, { left: `${r.x - 1}px`, top: `${r.y - 1}px`, width: `${r.width + 2}px`, height: `${r.height + 2}px` });
        this.layer.append(mask);
      }
      const text = document.createElement("span"); text.className = "composition-text"; text.textContent = preview.text;
      Object.assign(text.style, { left: `${point.x}px`, top: `${point.y}px`, fontFamily: point.run.fontFamily, fontSize: `${point.run.fontSize}px`, fontWeight: point.run.bold ? "bold" : "normal", fontStyle: point.run.italic ? "italic" : "normal", color: point.run.textColor });
      this.layer.append(text);
      cursor.style.left = `${point.x + text.offsetWidth}px`;
      this.layer.append(cursor);
    }
  }

  selectionChanged() {
    this.paint();
    if (!this.active || this.isComposing || document.activeElement !== this.input) return;
    if (this.drafts.has(paragraphKey(this.active))) return;
    const runs = this.runs.filter(r => same(r, this.active)), caret = this.caret();
    if (!runs.length) return;
    if (caret.offset >= runs[0].charStart && caret.offset <= runs.at(-1).charStart + length(runs.at(-1).text)) { this.followKey = null; return; }
    const key = `${paragraphKey(caret)}:${caret.offset}`;
    if (this.followKey !== key) { this.followKey = key; this.follow(); }
  }

  navigate(event) {
    if (!this.active || event.isComposing || this.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); this.input.blur(); return; }
    if (event.key === "Tab") return; // Keep native keyboard access to the toolbar.
    const caret = this.caret(), point = caretAt(this.runs, this.active, caret.offset);
    if (!point) return;
    let run, offset;
    if (event.key === "Home" || event.key === "End") {
      const line = this.runs.filter(r => r.editable && same(r, this.active) && Math.abs(r.y - point.y) < 1);
      run = event.key === "Home" ? line[0] : line.at(-1);
      offset = event.key === "Home" ? run.charStart : run.charStart + length(run.text);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const candidates = this.runs.filter(r => r.editable && (r.y - point.y) * direction > 1);
      candidates.sort((a, b) => Math.abs(a.y - point.y) - Math.abs(b.y - point.y) || Math.abs(a.x - point.x) - Math.abs(b.x - point.x));
      run = candidates[0]; if (run) offset = offsetAt(run, point.x);
    } else if (!event.shiftKey && this.input.selectionStart === this.input.selectionEnd &&
        ((event.key === "ArrowLeft" && caret.offset === 0) || (event.key === "ArrowRight" && caret.offset === length(this.input.value)))) {
      const current = this.paragraphs.findIndex(p => sameParagraph(p, this.active));
      const next = this.paragraphs[current + (event.key === "ArrowLeft" ? -1 : 1)];
      if (next?.editable) {
        const options = this.runs.filter(r => same(r, next));
        run = event.key === "ArrowLeft" ? options.at(-1) : options[0];
        if (run) offset = event.key === "ArrowLeft" ? length(next.text) : 0;
      }
    } else return;
    event.preventDefault();
    if (run && (!event.shiftKey || same(run, this.active))) this.activate(run, offset, true, event.shiftKey);
  }
}
