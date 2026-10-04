import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import CFB from "cfb";
import init, { HwpDocument } from "../node_modules/@rhwp/core/rhwp.js";
import { TextSession } from "../editor-core.mjs";
import { picturesOnPage, pictureProps, pictureSource, pictureKey } from "../picture-core.mjs";
await init({ module_or_path: readFileSync(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)) });
const red = { bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4z8DwHx9moL0CAHD0P8F+ACg+AAAAAElFTkSuQmCC", "base64")), width: 8, height: 4, extension: "png" };
const blue = { bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAwAAAAGCAYAAAD37n+BAAAAEklEQVR4nGNgYPj/nzQ8AjUAANPFj3Hgq871AAAAAElFTkSuQmCC", "base64")), width: 12, height: 6, extension: "png" };

for (const format of ["hwp", "hwpx"]) test(`사진 ${format}: 추가·크기·회전·교체·배치·삭제·셀·이력과 저장`, () => {
  const base = HwpDocument.createEmpty(); base.createBlankDocument();
  base.insertText(0, 0, 0, "사진 앞뒤😀 본문"); base.insertParagraph(0, 1); base.createTable(0, 1, 0, 2, 2);
  base.insertTextInCell(0, 1, 0, 0, 0, 0, "셀 텍스트"); base.setCellProperties(0, 1, 0, 1, '{"cellProtect":true}');
  base.insertParagraph(0, 2);
  const temporary = JSON.parse(base.insertPicture(0, 2, 0, "[]", red.bytes, 3000, 1500, 8, 4, "png", ""));
  base.copyControl(0, 2, "[]", temporary.controlIdx);
  base.pasteInternalInCell(0, 1, 0, 2, 0, 0); base.pasteInternalInCell(0, 1, 0, 3, 0, 0);
  base.deletePictureControl(0, 2, temporary.controlIdx);
  base.setCellProperties(0, 1, 0, 3, '{"cellProtect":true}');
  const bytes = format === "hwp" ? base.exportHwp() : base.exportHwpx(); base.free();
  const session = new TextSession(new HwpDocument(bytes), bytes, { CFB });
  const run = (action, data = {}) => session.picture({ action, revision: session.revision, page: 0, ...data });
  const current = key => picturesOnPage(session.doc, 0).find(p => p.key === key);
  try {
    const body = session.paragraphs[0].text;
    const inner = picturesOnPage(session.doc, 0).find(p => p.path[0]?.cellIndex === 2);
    const protectedPicture = picturesOnPage(session.doc, 0).find(p => p.path[0]?.cellIndex === 3);
    assert.ok(inner?.editable); assert.equal(protectedPicture.editable, false);
    assert.throws(() => run("delete", { picture: protectedPicture }), /편집할 수 없/);
    run("properties", { picture: inner, props: { width: 3500, height: 1750, rotationAngle: 90 } });
    run("replace", { picture: current(inner.key), image: blue }); session.export(HwpDocument);
    run("delete", { picture: current(inner.key) }); assert.equal(current(inner.key), undefined);
    session.history("undo"); assert.ok(current(inner.key));
    const inserted = run("insert", { image: red, caret: { section: 0, paragraph: 0, offset: 2 }, props: { width: 6000, height: 3000 } });
    const key = pictureKey(inserted.selectedPicture);
    assert.ok(current(key)?.editable);
    assert.equal(current(key).props.treatAsChar, true, "본문 사진은 커서 위치에 글자처럼 삽입");
    assert.equal(session.paragraphs[0].text, body);
    run("properties", { picture: current(key), props: { width: 9000, height: 4500 } });
    assert.equal(current(key).props.width, 9000);
    run("properties", { picture: current(key), props: { rotationAngle: 90 } });
    assert.equal(current(key).props.rotationAngle, 90);
    session.export(HwpDocument);
    run("properties", { picture: current(key), props: { rotationAngle: 0 } });
    run("replace", { picture: current(key), image: blue });
    assert.deepEqual(session.doc.getControlImageData(0, 0, "[]", inserted.selectedPicture.control), blue.bytes);
    assert.equal(current(key).props.width, 9000, "교체해도 틀 크기를 유지");
    const source = pictureSource(session.doc, current(key));
    assert.ok(source.extent);
    assert.equal(source.crop.right, source.extent[0], "해상도가 다른 사진도 오른쪽이 잘리지 않음");
    for (const mode of ["Square", "TopAndBottom", "InFrontOfText", "BehindText"]) {
      run("properties", { picture: current(key), props: { treatAsChar: false, textWrap: mode,
        horzRelTo: "Paper", vertRelTo: "Paper", horzAlign: "Left", vertAlign: "Top", horzOffset: 7500, vertOffset: 15000 } });
      assert.equal(current(key).props.textWrap, mode);
      assert.equal(current(key).props.horzOffset, 7500); assert.equal(current(key).props.vertOffset, 15000);
      session.export(HwpDocument);
    }
    run("properties", { picture: current(key), props: { horzRelTo: "Page", horzAlign: "Center", horzOffset: 0 } });
    assert.equal(current(key).props.horzAlign, "Center");
    run("properties", { picture: current(key), props: { treatAsChar: true } });
    assert.equal(current(key).props.treatAsChar, true);
    assert.equal(session.paragraphs[0].text, body);
    const revision = session.revision;
    assert.throws(() => run("properties", { picture: current(key), props: { width: -1 } }), /크기/);
    assert.throws(() => run("delete", { picture: current(key), revision: revision - 1 }), /변경/);
    assert.equal(session.revision, revision);
    assert.throws(() => run("replace", { picture: current(key), image: { ...red, bytes: Uint8Array.of(1, 2, 3) } }), /PNG/);
    const cell = session.paragraphs.find(p => p.control === 0 && p.cell === 0);
    const cellInserted = run("insert", { image: red, caret: { ...cell, offset: 0 }, props: { width: 3000, height: 1500 } });
    const cellKey = pictureKey(cellInserted.selectedPicture);
    assert.ok(current(cellKey));
    assert.equal(session.paragraphs.find(p => p.control === 0 && p.cell === 0).text, "셀 텍스트");
    const protectedCell = session.paragraphs.find(p => p.control === 0 && p.cell === 1);
    assert.throws(() => run("insert", { image: red, caret: { ...protectedCell, offset: 0 }, props: { width: 3000, height: 1500 } }), /위치/);
    run("delete", { picture: current(key) }); assert.equal(current(key), undefined);
    session.history("undo"); assert.ok(current(key));
    session.history("redo"); assert.equal(current(key), undefined);
    session.history("undo");
    const exported = session.export(HwpDocument), reopened = new HwpDocument(exported.bytes);
    try {
      assert.ok(picturesOnPage(reopened, 0).some(p => p.key === key));
      assert.equal(reopened.getTextInCell(0, 1, 0, 0, 0, 0, 100), "셀 텍스트");
      assert.equal(pictureProps(reopened, inserted.selectedPicture).treatAsChar, true);
    } finally { reopened.free(); }
    const real = session.doc.setPictureProperties;
    session.doc.setPictureProperties = () => { throw new Error("속성 변경 실패"); };
    const before = session.revision;
    assert.throws(() => run("replace", { picture: current(key), image: red, props: { width: 6000 } }), /변경 실패/);
    session.doc.setPictureProperties = real;
    assert.equal(session.revision, before, "실패한 사진 변경은 이력과 문서를 유지");
    assert.deepEqual(session.doc.getControlImageData(0, 0, "[]", inserted.selectedPicture.control), blue.bytes,
      "교체 뒤 속성 변경 실패 시 원래 사진 바이너리도 복구");
  } finally { session.doc.free(); }
});
