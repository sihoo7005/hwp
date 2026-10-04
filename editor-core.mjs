// 본문 텍스트 편집과 저장 검증. DOM 없이 Worker와 자동 검사에서 함께 사용합니다.
const MAX_TEXT = 200000;
const MAX_PARAGRAPHS = 5000;
const HISTORY_LIMIT = 10;

function checked(result) {
  const value = JSON.parse(result);
  if (!value.ok) throw new Error(value.error || "문서 엔진이 수정을 거절했습니다.");
  return value;
}

function controlShape(doc) {
  return JSON.parse(doc.getControls()).map(({ ctrlId, list, para, controlIndex }) => ({ ctrlId, list, para, controlIndex }));
}

export class TextSession {
  constructor(doc, source, { CFB, passwordUsed = false } = {}) {
    this.doc = doc;
    this.format = doc.getSourceFormat();
    this.undoStack = [];
    this.redoStack = [];
    this.revision = 0;
    this.nextRevision = 0;
    this.savedRevision = 0;
    this.reason = "";
    if (source.length > 8 * 1024 * 1024) this.reason = "텍스트 편집은 8 MB 이하의 문서에서 지원합니다.";
    else if (passwordUsed) this.reason = "암호 문서는 이번 버전에서 보기만 지원합니다.";
    else if (this.format === "hwp") {
      try {
        const container = CFB.read(source, { type: "array" });
        const header = CFB.find(container, "FileHeader")?.content;
        if (!header || header.length < 256 || header[35] !== 5 || header[34] !== 0)
          this.reason = "구형 HWP는 이번 버전에서 보기만 지원합니다.";
        else if (new DataView(Uint8Array.from(header).buffer).getUint32(36, true) & ~1)
          this.reason = "암호·배포용·서명·변경추적 등 특수 HWP는 보기만 지원합니다.";
      } catch { this.reason = "편집 가능한 일반 HWP 5.0 파일인지 확인하지 못했습니다."; }
    } else if (this.format !== "hwpx") this.reason = "이 형식은 이번 버전에서 보기만 지원합니다.";
    this.paragraphs = this.readParagraphs();
    this.originalControls = controlShape(doc);
  }

  readParagraphs() {
    const controls = JSON.parse(this.doc.getControls());
    const blocked = new Set(controls.filter(c => !["secd", "cold"].includes(c.ctrlId)).map(c => `${c.list}:${c.para}`));
    const paragraphs = [];
    let total = 0;
    for (let section = 0; section < this.doc.getSectionCount(); section++) {
      for (let paragraph = 0; paragraph < this.doc.getParagraphCount(section); paragraph++) {
        const text = this.doc.getTextRange(section, paragraph, 0, this.doc.getParagraphLength(section, paragraph));
        total += text.length;
        if (paragraphs.length >= MAX_PARAGRAPHS || total > MAX_TEXT) {
          this.reason ||= "편집 범위인 5천 문단·20만 글자를 넘는 문서입니다.";
          return paragraphs.map(p => ({ ...p, editable: false }));
        }
        // list는 구역 번호와 같지 않을 수 있으므로 위치 기반 제어 문자도 검사합니다.
        const positions = JSON.parse(this.doc.getControlTextPositions(section, paragraph));
        const metadataOnly = section === 0 && paragraph === 0 && positions.length <= 2 &&
          controls.filter(c => c.list === 0 && c.para === 0).every(c => ["secd", "cold"].includes(c.ctrlId));
        const object = blocked.has(`${section}:${paragraph}`) || (positions.length > 0 && !metadataOnly);
        paragraphs.push({ section, paragraph, text, editable: !this.reason && !object && text.length <= 20000, object });
      }
    }
    return paragraphs;
  }

  summary() {
    return { revision: this.revision, dirty: this.revision !== this.savedRevision,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      canEdit: !this.reason && this.paragraphs.some(p => p.editable), reason: this.reason,
      paragraphs: this.paragraphs, pages: this.doc.pageCount(), format: this.format };
  }

  trim(stack) {
    while (stack.length > HISTORY_LIMIT) this.doc.discardSnapshot(stack.shift().snapshot);
  }

  edit(section, paragraph, before, text) {
    const target = this.paragraphs.find(p => p.section === section && p.paragraph === paragraph);
    if (!target?.editable || this.reason) throw new Error("이 문단은 이번 버전에서 편집할 수 없습니다.");
    if (typeof text !== "string" || text.length > 20000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text) ||
        Array.from(text).some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff))
      throw new Error("문단은 2만 글자 이하의 일반 텍스트로 입력하세요. 줄바꿈과 탭은 사용할 수 있습니다.");
    if (target.text !== before) throw new Error("문단이 변경되었습니다. 현재 내용을 다시 확인해 주세요.");
    if (text === before) return this.summary();
    if (this.paragraphs.reduce((n, p) => n + p.text.length, 0) - before.length + text.length > MAX_TEXT)
      throw new Error("본문 편집은 20만 글자까지 지원합니다.");
    // Rust의 문자 위치는 Unicode code point 단위입니다. 이모지의 UTF-16 쌍을 자르지 않습니다.
    const oldChars = Array.from(before), newChars = Array.from(text);
    let start = 0, end = 0;
    while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) start++;
    while (end < oldChars.length - start && end < newChars.length - start && oldChars.at(-end - 1) === newChars.at(-end - 1)) end++;
    const snapshot = this.doc.saveSnapshot();
    try {
      checked(this.doc.replaceText(section, paragraph, start, oldChars.length - start - end,
        newChars.slice(start, newChars.length - end).join("")));
      if (this.doc.getTextRange(section, paragraph, 0, this.doc.getParagraphLength(section, paragraph)) !== text)
        throw new Error("수정한 텍스트를 확인하지 못했습니다.");
      const paragraphs = this.readParagraphs();
      this.undoStack.push({ snapshot, revision: this.revision });
      this.trim(this.undoStack);
      for (const item of this.redoStack) this.doc.discardSnapshot(item.snapshot);
      this.redoStack = [];
      this.revision = ++this.nextRevision;
      this.paragraphs = paragraphs;
    } catch (error) {
      checked(this.doc.restoreSnapshot(snapshot));
      this.doc.discardSnapshot(snapshot);
      throw error;
    }
    return this.summary();
  }

  history(direction) {
    if (this.reason) throw new Error("보기 전용 문서입니다.");
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const to = direction === "undo" ? this.redoStack : this.undoStack;
    if (!from.length) return this.summary();
    const current = { snapshot: this.doc.saveSnapshot(), revision: this.revision };
    const previous = from.at(-1);
    try { checked(this.doc.restoreSnapshot(previous.snapshot)); }
    catch (error) { this.doc.discardSnapshot(current.snapshot); throw error; }
    from.pop();
    this.doc.discardSnapshot(previous.snapshot);
    to.push(current);
    this.trim(to);
    this.revision = previous.revision;
    this.paragraphs = this.readParagraphs();
    return this.summary();
  }

  export(HwpDocument) {
    if (this.reason || !this.summary().canEdit) throw new Error(this.reason || "저장할 수 없는 문서입니다.");
    const result = this.format === "hwpx" ? this.doc.exportHwpxWithReport() : this.doc.exportHwpWithReport();
    let bytes;
    try {
      const loss = JSON.parse(result.contentLoss());
      if (loss.count || loss.losses?.length) throw new Error(`저장 시 문서 내용이 손실될 수 있어 중단했습니다 (${loss.count}건).`);
      bytes = result.takeBytes();
    } finally { result.free(); }
    const reopened = new HwpDocument(bytes);
    try {
      if (reopened.getSourceFormat() !== this.format || reopened.getTextFileUnicode() !== this.doc.getTextFileUnicode() ||
          JSON.stringify(controlShape(reopened)) !== JSON.stringify(this.originalControls) ||
          reopened.getSectionCount() !== this.doc.getSectionCount())
        throw new Error("저장 결과에서 텍스트 또는 문서 개체가 달라져 다운로드를 중단했습니다.");
      for (let s = 0; s < this.doc.getSectionCount(); s++) {
        if (reopened.getParagraphCount(s) !== this.doc.getParagraphCount(s)) throw new Error("저장 결과의 문단 수가 달라졌습니다.");
        for (let p = 0; p < this.doc.getParagraphCount(s); p++) {
          if (reopened.getTextRange(s, p, 0, reopened.getParagraphLength(s, p)) !==
              this.doc.getTextRange(s, p, 0, this.doc.getParagraphLength(s, p))) throw new Error("저장 결과의 본문이 달라졌습니다.");
        }
      }
    } finally { reopened.free(); }
    return { bytes, revision: this.revision, format: this.format };
  }
}
