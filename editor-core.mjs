// 본문·표 셀 텍스트 편집과 저장 검증. DOM 없이 Worker와 자동 검사에서 함께 사용합니다.
const { sameParagraph } = await import("./text-address.mjs" + new URL(import.meta.url).search);
const { pictureKey, picturesOnPage, pictureSource, locatePicture, checkedImage, checkedPictureProps, setPictureProps, verifyPictures } =
  await import("./picture-core.mjs" + new URL(import.meta.url).search);
const MAX_TEXT = 200000;
const MAX_PARAGRAPHS = 5000;
const HISTORY_LIMIT = 100;

function checked(result) {
  const value = JSON.parse(result);
  if (!value.ok) throw new Error(value.error || "문서 엔진이 수정을 거절했습니다.");
  return value;
}

function controlShape(doc) {
  return JSON.parse(doc.getControls()).map(({ ctrlId, list, para, controlIndex }) => ({ ctrlId, list, para, controlIndex }));
}

function cellShape(doc) {
  return JSON.parse(doc.getCursorModel()).lists.filter(c => c.isCell).map(c => ({
    listId: c.listId, hostListId: c.hostListId, section: c.sectionIndex, paragraph: c.hostPara,
    control: c.controlIndex, cell: c.cellIndex, paragraphs: c.paraCount,
    row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan
  }));
}

function paragraphText(doc, p) {
  if (p.control === undefined) return doc.getTextRange(p.section, p.paragraph, 0, doc.getParagraphLength(p.section, p.paragraph));
  return doc.getTextInCell(p.section, p.paragraph, p.control, p.cell, p.cellParagraph, 0,
    doc.getCellParagraphLength(p.section, p.paragraph, p.control, p.cell, p.cellParagraph));
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
        if (!header || header.length < 256 || header[35] !== 5 || header[34] > 1)
          this.reason = "구형 HWP는 이번 버전에서 보기만 지원합니다.";
        else if (new DataView(Uint8Array.from(header).buffer).getUint32(36, true) & ~1)
          this.reason = "암호·배포용·서명·변경추적 등 특수 HWP는 보기만 지원합니다.";
      } catch { this.reason = "편집 가능한 일반 HWP 5.0·5.1 파일인지 확인하지 못했습니다."; }
    } else if (this.format !== "hwpx") this.reason = "이 형식은 이번 버전에서 보기만 지원합니다.";
    this.paragraphs = this.readParagraphs();
  }

  readParagraphs(doc = this.doc) {
    const controls = JSON.parse(doc.getControls());
    const blocked = new Set(controls.filter(c => !["secd", "cold"].includes(c.ctrlId)).map(c => `${c.list}:${c.para}`));
    const paragraphs = [];
    let total = 0;
    for (let section = 0; section < doc.getSectionCount(); section++) {
      for (let paragraph = 0; paragraph < doc.getParagraphCount(section); paragraph++) {
        const text = doc.getTextRange(section, paragraph, 0, doc.getParagraphLength(section, paragraph));
        total += text.length;
        if (paragraphs.length >= MAX_PARAGRAPHS || total > MAX_TEXT) {
          this.reason ||= "편집 범위인 5천 문단·20만 글자를 넘는 문서입니다.";
          return paragraphs.map(p => ({ ...p, editable: false }));
        }
        // list는 구역 번호와 같지 않을 수 있으므로 위치 기반 제어 문자도 검사합니다.
        const positions = JSON.parse(doc.getControlTextPositions(section, paragraph));
        const metadataOnly = section === 0 && paragraph === 0 && positions.length <= 2 &&
          controls.filter(c => c.list === 0 && c.para === 0).every(c => ["secd", "cold"].includes(c.ctrlId));
        const object = blocked.has(`${section}:${paragraph}`) || (positions.length > 0 && !metadataOnly);
        paragraphs.push({ section, paragraph, text, editable: !this.reason && !object && text.length <= 20000, object });
      }
    }
    for (const cell of cellShape(doc).filter(c => c.hostListId === 0)) {
      const props = JSON.parse(doc.getCellProperties(cell.section, cell.paragraph, cell.control, cell.cell));
      for (let cellParagraph = 0; cellParagraph < cell.paragraphs; cellParagraph++) {
        const address = { section: cell.section, paragraph: cell.paragraph, control: cell.control, cell: cell.cell, cellParagraph };
        const text = paragraphText(doc, address);
        total += text.length;
        if (paragraphs.length >= MAX_PARAGRAPHS || total > MAX_TEXT) {
          this.reason ||= "편집 범위인 5천 문단·20만 글자를 넘는 문서입니다.";
          return paragraphs.map(p => ({ ...p, editable: false }));
        }
        const object = controls.some(c => c.list === cell.listId && c.para === cellParagraph);
        paragraphs.push({ ...address, text, object, editable: !this.reason && !object && !props.cellProtect &&
          !props.textDirection && text.length <= 20000 });
      }
    }
    return paragraphs;
  }

  summary() {
    return { revision: this.revision, dirty: this.revision !== this.savedRevision,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      canEdit: !this.reason, reason: this.reason,
      paragraphs: this.paragraphs, pages: this.doc.pageCount(), format: this.format };
  }

  trim(stack) {
    while (stack.length > HISTORY_LIMIT) stack.shift();
  }

  edit(section, paragraph, before, text, cellAddress = {}) {
    const target = this.paragraphs.find(p => sameParagraph(p, { ...cellAddress, section, paragraph }));
    if (!target?.editable || this.reason) throw new Error("이 문단은 이번 버전에서 편집할 수 없습니다.");
    if (typeof text !== "string" || text.length > 20000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text) ||
        Array.from(text).some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff))
      throw new Error("문단은 2만 글자 이하의 일반 텍스트로 입력하세요. 줄바꿈과 탭은 사용할 수 있습니다.");
    if (target.text !== before) throw new Error("문단이 변경되었습니다. 현재 내용을 다시 확인해 주세요.");
    if (text === before) return this.summary();
    if (this.paragraphs.reduce((n, p) => n + p.text.length, 0) - before.length + text.length > MAX_TEXT)
      throw new Error("본문과 표 셀을 합쳐 20만 글자까지 편집할 수 있습니다.");
    // Rust의 문자 위치는 Unicode code point 단위입니다. 이모지의 UTF-16 쌍을 자르지 않습니다.
    const oldChars = Array.from(before), newChars = Array.from(text);
    let start = 0, end = 0;
    while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) start++;
    while (end < oldChars.length - start && end < newChars.length - start && oldChars.at(-end - 1) === newChars.at(-end - 1)) end++;
    return this.mutate(() => {
      const remove = oldChars.length - start - end, insert = newChars.slice(start, newChars.length - end).join("");
      if (target.control === undefined) checked(this.doc.replaceText(section, paragraph, start, remove, insert));
      else {
        const args = [section, paragraph, target.control, target.cell, target.cellParagraph, start];
        if (remove) checked(this.doc.deleteTextInCell(...args, remove));
        if (insert) checked(this.doc.insertTextInCell(...args, insert));
      }
      if (paragraphText(this.doc, target) !== text) throw new Error("수정한 텍스트를 확인하지 못했습니다.");
    });
  }

  mutate(change) {
    if (this.reason) throw new Error("보기 전용 문서입니다.");
    // 엔진의 스냅샷 상한(100개)과 별도로 이력을 보관해 복원 중 축출을 막습니다.
    const history = { bytes: this.capture(), revision: this.revision };
    const snapshot = this.doc.saveSnapshot();
    try {
      change();
      const paragraphs = this.readParagraphs();
      this.undoStack.push(history);
      this.trim(this.undoStack);
      this.redoStack = [];
      this.revision = ++this.nextRevision;
      this.paragraphs = paragraphs;
    } catch (error) {
      checked(this.doc.restoreSnapshot(snapshot));
      this.doc.discardSnapshot(snapshot);
      throw error;
    }
    this.doc.discardSnapshot(snapshot);
    return this.summary();
  }

  picture(data) {
    if (this.reason || data.revision !== this.revision) throw new Error(this.reason || "문서가 변경되었습니다. 사진을 다시 선택하세요.");
    if (!Number.isInteger(data.page) || data.page < 0 || data.page >= this.doc.pageCount()) throw new Error("사진이 있는 쪽을 확인하세요.");
    let selected;
    if (data.action === "insert") {
      const p = this.paragraphs.find(p => sameParagraph(p, data.caret));
      if (!p?.editable || !Number.isInteger(data.caret.offset) || data.caret.offset < 0 ||
          data.caret.offset > Array.from(p.text).length) throw new Error("본문이나 표 셀을 클릭해 사진을 넣을 위치를 선택하세요.");
      const image = checkedImage(data.image), props = checkedPictureProps(data.props);
      const summary = this.mutate(() => {
        const path = p.control === undefined ? [] : [{ controlIndex: p.control, cellIndex: p.cell, cellParaIndex: p.cellParagraph }];
        const result = checked(this.doc.insertPicture(p.section, p.paragraph, data.caret.offset, JSON.stringify(path),
          image.bytes, props.width, props.height, image.width, image.height, image.extension, "사진"));
        selected = { section: p.section, paragraph: p.paragraph, control: result.controlIdx ?? result.controlIndex,
          path: [] };
        if (!path.length) checked(setPictureProps(this.doc, selected, { treatAsChar: true }));
        if (this.capture().length > 8 * 1024 * 1024) throw new Error("편집 문서는 사진을 포함해 8 MB까지 지원합니다.");
      });
      return { ...summary, selectedPicture: locatePicture(this.doc, selected, data.page) };
    }
    const p = picturesOnPage(this.doc, data.page, this.reason).find(p => p.key === pictureKey(data.picture));
    if (!p?.editable) throw new Error("이 사진은 편집할 수 없습니다. 일반 본문·표 셀의 사진을 선택하세요.");
    const props = checkedPictureProps(data.props || {});
    if (p.props.sizeProtect && ("width" in props || "height" in props)) throw new Error("크기가 보호된 사진입니다.");
    if (!["properties", "replace", "delete"].includes(data.action)) throw new Error("사진 작업을 확인하세요.");
    const image = data.action === "replace" ? checkedImage(data.image) : null;
    const summary = this.mutate(() => {
      if (data.action === "delete") checked(p.path.length ? this.doc.deleteCellPictureControlByPath(p.section,
        p.paragraph, JSON.stringify(p.path), p.control) : this.doc.deletePictureControl(p.section, p.paragraph, p.control));
      else {
        if (image) {
          const source = pictureSource(this.doc, p);
          // 기존 HWP의 imgDim 좌표계를 유지해야 교체 사진 전체가 표시됩니다.
          const [w, h] = source.extent || [image.width * 75, image.height * 75];
          checked(this.doc.assignPictureImage(p.section, p.paragraph, JSON.stringify(p.path), p.control,
            image.bytes, Math.ceil(w / 75), Math.ceil(h / 75), image.extension));
        }
        // 앵커 전환은 엔진이 위치를 초기화하므로 전환 뒤 실제 이동 좌표를 적용합니다.
        if (p.props.treatAsChar && props.treatAsChar === false) checked(setPictureProps(this.doc, p, { treatAsChar: false }));
        checked(setPictureProps(this.doc, p, props));
      }
      if (this.capture().length > 8 * 1024 * 1024) throw new Error("편집 문서는 사진을 포함해 8 MB까지 지원합니다.");
    });
    return { ...summary, selectedPicture: data.action === "delete" ? null : locatePicture(this.doc, p, data.page) };
  }

  history(direction) {
    if (this.reason) throw new Error("보기 전용 문서입니다.");
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const to = direction === "undo" ? this.redoStack : this.undoStack;
    if (!from.length) return this.summary();
    const current = { bytes: this.capture(), revision: this.revision };
    const previous = from.at(-1);
    const restored = new this.doc.constructor(previous.bytes);
    let paragraphs;
    try { paragraphs = this.readParagraphs(restored); }
    catch (error) { restored.free(); throw error; }
    this.doc.free();
    this.doc = restored;
    from.pop();
    to.push(current);
    this.trim(to);
    this.revision = previous.revision;
    this.paragraphs = paragraphs;
    return this.summary();
  }

  capture() {
    const result = this.format === "hwpx" ? this.doc.exportHwpxWithReport() : this.doc.exportHwpWithReport();
    try {
      const loss = JSON.parse(result.contentLoss());
      if (loss.count || loss.losses?.length) throw new Error(`저장 시 문서 내용이 손실될 수 있어 중단했습니다 (${loss.count}건).`);
      return result.takeBytes();
    } finally { result.free(); }
  }

  export(HwpDocument) {
    if (this.reason || !this.summary().canEdit) throw new Error(this.reason || "저장할 수 없는 문서입니다.");
    const bytes = this.capture();
    const reopened = new HwpDocument(bytes);
    try {
      if (reopened.getSourceFormat() !== this.format || reopened.getTextFileUnicode() !== this.doc.getTextFileUnicode() ||
          JSON.stringify(controlShape(reopened)) !== JSON.stringify(controlShape(this.doc)) ||
          JSON.stringify(cellShape(reopened)) !== JSON.stringify(cellShape(this.doc)) ||
          reopened.getSectionCount() !== this.doc.getSectionCount())
        throw new Error("저장 결과에서 텍스트 또는 문서 개체가 달라져 다운로드를 중단했습니다.");
      for (let s = 0; s < this.doc.getSectionCount(); s++) {
        if (reopened.getParagraphCount(s) !== this.doc.getParagraphCount(s)) throw new Error("저장 결과의 문단 수가 달라졌습니다.");
        for (let p = 0; p < this.doc.getParagraphCount(s); p++) {
          if (reopened.getTextRange(s, p, 0, reopened.getParagraphLength(s, p)) !==
              this.doc.getTextRange(s, p, 0, this.doc.getParagraphLength(s, p))) throw new Error("저장 결과의 본문이 달라졌습니다.");
        }
      }
      for (const p of this.paragraphs.filter(p => p.control !== undefined)) {
        if (paragraphText(reopened, p) !== p.text) throw new Error("저장 결과의 표 셀 내용이 달라졌습니다.");
      }
      verifyPictures(this.doc, reopened);
    } finally { reopened.free(); }
    return { bytes, revision: this.revision, format: this.format };
  }
}
