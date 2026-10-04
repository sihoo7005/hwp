import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import init, { HwpDocument } from "../node_modules/@rhwp/core/rhwp.js";

test("확장 엔진: 그림·분수 수식, HWPX/HML 열기와 암호 문서 검증", async () => {
  await init({ module_or_path: readFileSync(new URL("../node_modules/@rhwp/core/rhwp_bg.wasm", import.meta.url)) });
  const doc = new HwpDocument(readFileSync(new URL("../hwp file for test.hwp", import.meta.url)));
  try {
    assert.ok(JSON.parse(doc.insertEquation(0, 0, 0, "{a} over {b}", 1100, 0)).ok);
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfsAAAAASUVORK5CYII=", "base64"));
    assert.ok(JSON.parse(doc.insertPictureEx(JSON.stringify({ sectionIdx: 0, paraIdx: 1, charOffset: 0,
      width: 2000, height: 2000, naturalWidthPx: 1, naturalHeightPx: 1, extension: "png" }), png)).ok);
    const svg = doc.renderPageSvg(0);
    assert.match(svg, /<image[^>]+href="data:image\/png;base64,/);
    assert.match(svg, /font-style="italic"[^>]*>a<\/text>/);
    assert.match(svg, /font-style="italic"[^>]*>b<\/text>/);
    const sourceText = JSON.parse(doc.getTextFileUnicode());
    assert.match(sourceText, /서울은 대한민국의 수도이다/);
    for (const [bytes, format] of [[doc.exportHwpx(), "hwpx"]]) {
      const reopened = new HwpDocument(bytes);
      try {
        assert.equal(reopened.getSourceFormat(), format);
        assert.match(JSON.parse(reopened.getTextFileUnicode()), /서울은 대한민국의 수도이다/);
        assert.match(reopened.renderPageSvg(0), /<image[^>]+href="data:image\/png;base64,/);
      } finally { reopened.free(); }
    }
    const hml = new HwpDocument(new TextEncoder().encode(`<HWPML Version="2.91"><HEAD SecCnt="1"><MAPPINGTABLE><CHARSHAPELIST Count="1"><CHARSHAPE Id="0" Height="1100"/></CHARSHAPELIST><PARASHAPELIST Count="1"><PARASHAPE Id="0" Align="Left"/></PARASHAPELIST></MAPPINGTABLE></HEAD><BODY><SECTION Id="0"><P ParaShape="0"><TEXT CharShape="0"><CHAR>HML 보기 확인</CHAR></TEXT></P></SECTION></BODY></HWPML>`));
    try {
      assert.equal(hml.getSourceFormat(), "hml");
      assert.match(JSON.parse(hml.getTextFileUnicode()), /HML 보기 확인/);
      assert.match(hml.renderPageSvg(0), /<text /);
    } finally { hml.free(); }
    for (const bytes of [doc.exportHwpWithPassword("test-password"), doc.exportHwpxWithPassword("test-password")]) {
      assert.throws(() => new HwpDocument(bytes), /비밀번호/);
      assert.throws(() => HwpDocument.openWithPassword(bytes, "wrong-password"), /비밀번호/);
      const reopened = HwpDocument.openWithPassword(bytes, "test-password");
      try { assert.match(JSON.parse(reopened.getTextFileUnicode()), /서울은 대한민국의 수도이다/); }
      finally { reopened.free(); }
    }
    assert.throws(() => new HwpDocument(Uint8Array.of(0, 1, 2, 3)));
  } finally { doc.free(); }
});
