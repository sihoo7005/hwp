import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import CFB from "cfb";
import init, { HwpDocument } from "../node_modules/@rhwp/core/rhwp.js";
import { TextSession } from "../editor-core.mjs";
await init({ module_or_path: readFileSync(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)) });
const source = readFileSync(new URL("../hwp file for test.hwp", import.meta.url));

for (const format of ["hwp", "hwpx"]) test(`텍스트 에디터: ${format} 가변 길이·이모지·줄바꿈 저장, 서식·표 보존과 실행 취소`, () => {
  const base = new HwpDocument(source);
  base.applyCharFormat(0, 0, 3, 7, JSON.stringify({ bold: true }));
  // CI의 원본 테스트 문서에도 표를 포함시켜 본문 편집 중 개체 보존을 검사합니다.
  base.splitParagraph(0, 2, base.getParagraphLength(0, 2));
  assert.ok(JSON.parse(base.createTable(0, 3, 0, 2, 2)).ok);
  const bytes = format === "hwp" ? base.exportHwp() : base.exportHwpx();
  base.free();
  const doc = new HwpDocument(bytes);
  try {
    const session = new TextSession(doc, bytes, { CFB });
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
    assert.equal(doc.getCharPropertiesAt(0, 0, 4), style);
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
    const realExport = doc.exportHwpWithReport;
    if (format === "hwp") {
      doc.exportHwpWithReport = () => ({ contentLoss: () => '{"count":1,"losses":[{}]}', free() {} });
      assert.throws(() => session.export(HwpDocument), /손실/);
      doc.exportHwpWithReport = realExport;
    }
  } finally { doc.free(); }
});

test("텍스트 에디터: 특수 HWP 편집 제한, 10단계 이력과 빈 문단 복구", () => {
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
    const session = new TextSession(doc, source, { CFB });
    for (let i = 1; i <= 12; i++) session.edit(0, 1, session.paragraphs[1].text, `${i}번째 문장`);
    assert.equal(session.undoStack.length, 10);
    for (let i = 0; i < 10; i++) session.history("undo");
    assert.equal(session.paragraphs[1].text, "2번째 문장");
    session.edit(0, 1, session.paragraphs[1].text, "");
    assert.equal(session.paragraphs[1].text, "");
    session.history("undo");
    assert.equal(session.paragraphs[1].text, "2번째 문장");
  } finally { doc.free(); }
});
