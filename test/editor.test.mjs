import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import CFB from "cfb";
import init, { HwpDocument } from "../node_modules/@rhwp/core/rhwp.js";
import { TextSession } from "../editor-core.mjs";
await init({ module_or_path: readFileSync(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)) });
const source = readFileSync(new URL("../hwp file for test.hwp", import.meta.url));

for (const format of ["hwp", "hwpx"]) test(`표 셀 에디터: ${format} 병합·빈 셀·여러 문단·서식·이력·저장과 실패 복구`, () => {
  const base = new HwpDocument(source);
  assert.ok(JSON.parse(base.createTable(0, 3, 0, 2, 3)).ok);
  assert.ok(JSON.parse(base.mergeTableCells(0, 3, 0, 0, 0, 0, 1)).ok);
  base.insertTextInCell(0, 3, 0, 0, 0, 0, "가나다라");
  base.applyCharFormatInCell(0, 3, 0, 0, 0, 2, 4, JSON.stringify({ bold: true }));
  base.splitParagraphInCell(0, 3, 0, 1, 0, 0);
  base.insertTextInCell(0, 3, 0, 1, 1, 0, "같은 셀의 둘째 문단");
  base.setCellProperties(0, 3, 0, 2, JSON.stringify({ cellProtect: true }));
  base.insertClickHereFieldInCell(0, 3, 0, 3, 0, 0, false, "입력", "", "field", true);
  const bytes = format === "hwp" ? base.exportHwp() : base.exportHwpx();
  base.free();
  const doc = new HwpDocument(bytes);
  let session;
  try {
    session = new TextSession(doc, bytes, { CFB });
    const cell = (index, paragraph = 0) => session.paragraphs.find(p => p.paragraph === 3 && p.control === 0 && p.cell === index && p.cellParagraph === paragraph);
    const edit = (p, text) => session.edit(p.section, p.paragraph, p.text, text, p);
    assert.ok(cell(0).editable && cell(1).editable && cell(1, 1).editable);
    assert.equal(cell(2).editable, false, "보호 셀은 수정하지 않음");
    assert.equal(cell(3).editable, false, "필드 등 개체가 있는 셀 문단은 수정하지 않음");
    assert.throws(() => edit(cell(2), "보호 해제"), /편집할 수 없/);
    assert.throws(() => session.edit(0, 3, cell(0).text, "본문으로 잘못 요청"), /편집할 수 없/);
    const style = doc.getCellCharPropertiesAt(0, 3, 0, 0, 0, 2);
    edit(cell(0), "😀가나다라");
    assert.equal(doc.getCellCharPropertiesAt(0, 3, 0, 0, 0, 3), style);
    const after = "😀가나다라\n셀 안 줄바꿈\tABC";
    edit(cell(0), after);
    edit(cell(1), "빈 셀도 입력😀");
    edit(cell(1, 1), "둘째 문단 수정");
    assert.equal(cell(0).text, after, "같은 셀의 다른 문단과 옆 셀의 수정은 분리");
    session.history("undo"); assert.equal(cell(1, 1).text, "같은 셀의 둘째 문단");
    session.history("redo"); assert.equal(cell(1, 1).text, "둘째 문단 수정");
    const revision = session.revision;
    const realInsert = session.doc.insertTextInCell;
    session.doc.insertTextInCell = () => { throw new Error("삽입 실패"); };
    assert.throws(() => edit(cell(0), "실패한 변경"), /삽입 실패/);
    session.doc.insertTextInCell = realInsert;
    assert.equal(session.doc.getTextInCell(0, 3, 0, 0, 0, 0, 20000), after, "삭제 후 삽입 실패 시 전체 복구");
    assert.equal(session.revision, revision);
    edit(cell(0), ""); assert.equal(cell(0).text, ""); session.history("undo");
    const exported = session.export(HwpDocument);
    const reopened = new HwpDocument(exported.bytes);
    try {
      assert.equal(reopened.getTextInCell(0, 3, 0, 0, 0, 0, 20000), after);
      assert.equal(reopened.getCellParagraphCount(0, 3, 0, 1), 2);
      assert.equal(reopened.getTextInCell(0, 3, 0, 1, 0, 0, 20000), "빈 셀도 입력😀");
      assert.equal(reopened.getTextInCell(0, 3, 0, 1, 1, 0, 20000), "둘째 문단 수정");
      assert.equal(JSON.parse(reopened.getCellInfo(0, 3, 0, 0)).colSpan, 2);
      assert.equal(reopened.getCellCharPropertiesAt(0, 3, 0, 0, 0, 3), style);
    } finally { reopened.free(); }
  } finally { (session?.doc || doc).free(); }
});

for (const format of ["hwp", "hwpx"]) test(`텍스트 에디터: ${format} 가변 길이·이모지·줄바꿈 저장, 서식·표 보존과 실행 취소`, () => {
  const base = new HwpDocument(source);
  base.applyCharFormat(0, 0, 3, 7, JSON.stringify({ bold: true }));
  // CI의 원본 테스트 문서에도 표를 포함시켜 본문 편집 중 개체 보존을 검사합니다.
  base.splitParagraph(0, 2, base.getParagraphLength(0, 2));
  assert.ok(JSON.parse(base.createTable(0, 3, 0, 2, 2)).ok);
  const bytes = format === "hwp" ? base.exportHwp() : base.exportHwpx();
  base.free();
  const doc = new HwpDocument(bytes);
  let session;
  try {
    session = new TextSession(doc, bytes, { CFB });
    const text = session.paragraphs[0].text;
    const style = doc.getCharPropertiesAt(0, 0, 4);
    const controls = JSON.parse(doc.getControls()).map(c => c.ctrlId);
    assert.ok(session.summary().canEdit);
    assert.throws(() => session.edit(0, 3, "", "표를 삭제"), /편집할 수 없/);
    assert.throws(() => session.edit(0, 0, "오래된 본문", "새 본문"), /문단이 변경/);
    assert.throws(() => session.edit(0, 0, text, "\ud800"), /일반 텍스트/);
    const prefixEdited = "😀서울" + text.slice(2);
    const after = prefixEdited + "\n길이가 달라도 저장합니다.\tABC";
    session.edit(0, 0, text, prefixEdited);
    session.edit(0, 0, prefixEdited, after);
    assert.equal(session.paragraphs[0].text, after);
    assert.equal(doc.getCharPropertiesAt(0, 0, 5), style, "수정 범위 밖의 굵기와 글꼴 유지");
    assert.ok(session.summary().dirty);
    session.history("undo");
    assert.equal(session.paragraphs[0].text, prefixEdited);
    session.history("undo");
    assert.equal(session.paragraphs[0].text, text);
    assert.equal(session.doc.getCharPropertiesAt(0, 0, 4), style);
    assert.equal(session.summary().dirty, false);
    session.history("redo");
    session.history("redo");
    assert.equal(session.paragraphs[0].text, after);
    const exported = session.export(HwpDocument);
    assert.equal(exported.format, format);
    const reopened = new HwpDocument(exported.bytes);
    try {
      assert.equal(reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0)), after);
      assert.deepEqual(JSON.parse(reopened.getControls()).map(c => c.ctrlId), controls);
      assert.equal(reopened.getCharPropertiesAt(0, 0, 5), style);
    } finally { reopened.free(); }
    session.savedRevision = exported.revision;
    assert.equal(session.summary().dirty, false);
    session.history("undo");
    assert.equal(session.summary().dirty, true);
    session.edit(0, 0, session.paragraphs[0].text, "다른 내용");
    assert.equal(session.summary().canRedo, false);
    const realExport = session.doc.exportHwpWithReport;
    if (format === "hwp") {
      session.doc.exportHwpWithReport = () => ({ contentLoss: () => '{"count":1,"losses":[{}]}', free() {} });
      assert.throws(() => session.export(HwpDocument), /손실/);
      session.doc.exportHwpWithReport = realExport;
    }
  } finally { (session?.doc || doc).free(); }
});

test("텍스트 에디터: 특수 HWP 편집 제한, 100단계 이력과 빈 문단 복구", () => {
  const doc = new HwpDocument(source);
  try {
    const container = CFB.read(source, { type: "array" });
    const header = Uint8Array.from(CFB.find(container, "FileHeader").content);
    new DataView(header.buffer).setUint32(36, 5, true); // 배포용
    CFB.utils.cfb_add(container, "FileHeader", header);
    const protectedSource = Uint8Array.from(CFB.write(container, { type: "array" }));
    const blocked = new TextSession(doc, protectedSource, { CFB });
    assert.equal(blocked.summary().canEdit, false);
    assert.throws(() => blocked.edit(0, 0, blocked.paragraphs[0].text, "변경"), /편집할 수 없/);
    assert.throws(() => blocked.export(HwpDocument), /특수 HWP/);
  } finally { doc.free(); }
  for (const format of ["hwp", "hwpx"]) {
    const base = new HwpDocument(source);
    const bytes = format === "hwp" ? source : base.exportHwpx();
    base.free();
    const doc = new HwpDocument(bytes);
    const session = new TextSession(doc, bytes, { CFB });
    try {
      for (let i = 1; i <= 102; i++) session.edit(0, 1, session.paragraphs[1].text, `${i}번째 문장`);
      assert.equal(session.undoStack.length, 100);
      const realReplace = session.doc.replaceText;
      session.doc.replaceText = () => { throw new Error("수정 실패"); };
      assert.throws(() => session.edit(0, 1, session.paragraphs[1].text, "실패"), /수정 실패/);
      session.doc.replaceText = realReplace;
      assert.equal(session.undoStack.length, 100, "실패해도 100단계 이력을 유지");
      assert.equal(session.paragraphs[1].text, "102번째 문장");
      for (let i = 0; i < 100; i++) session.history("undo");
      assert.equal(session.paragraphs[1].text, "2번째 문장");
      assert.equal(session.summary().canUndo, false);
      assert.equal(session.redoStack.length, 100);
      session.history("undo");
      assert.equal(session.paragraphs[1].text, "2번째 문장", "한도를 넘어서 되돌리지 않음");
      for (let i = 0; i < 100; i++) session.history("redo");
      assert.equal(session.paragraphs[1].text, "102번째 문장");
      assert.equal(session.summary().canRedo, false);
      assert.equal(session.undoStack.length, 100);
      session.history("redo");
      assert.equal(session.paragraphs[1].text, "102번째 문장");
      session.history("undo");
      session.edit(0, 1, session.paragraphs[1].text, "");
      assert.equal(session.summary().canRedo, false, "새 수정은 이전 다시 실행 이력을 지움");
      assert.equal(session.paragraphs[1].text, "");
      session.history("undo");
      assert.equal(session.paragraphs[1].text, "101번째 문장");
    } finally { session.doc.free(); }
  }
});
