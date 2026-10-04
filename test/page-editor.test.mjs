import test from "node:test";
import assert from "node:assert/strict";
import { toCodePoint, toUtf16, offsetAt, runAtPoint, caretAt, selectionRects } from "../page-editor.mjs";

test("문서 위 편집: 이모지·서식 구간·줄 나눔의 커서와 선택 좌표", () => {
  const p = { section: 0, paragraph: 1 };
  const base = { secIdx: 0, paraIdx: 1, y: 20, h: 15 };
  const runs = [
    { ...base, text: "가😀", charStart: 0, x: 10, w: 30, charX: [0, 10, 30] },
    { ...base, text: "나다", charStart: 2, x: 40, w: 20, charX: [0, 10, 20], bold: true },
    { ...base, text: "라", charStart: 4, x: 10, y: 40, w: 10, charX: [0, 10] },
    { ...base, text: "셀", charStart: 0, x: 400, w: 10, charX: [0, 10], parentParaIdx: 1 },
  ];
  assert.equal(toCodePoint("가😀나다", 3), 2);
  assert.equal(toUtf16("가😀나다", 2), 3);
  assert.equal(offsetAt(runs[0], 29), 1, "클릭은 가까운 글자 경계로 이동");
  assert.equal(offsetAt(runs[0], 38), 2);
  assert.equal(runAtPoint(runs, 48, 22), runs[1], "앞 서식 구간의 클릭 여유가 다음 구간을 가리지 않음");
  assert.equal(runAtPoint(runs, 405, 22), runs[3], "셀 위치는 본문으로 오인하지 않음");
  assert.equal(runAtPoint(runs, 800, 22), undefined);
  assert.equal(caretAt(runs, p, 2).x, 40);
  assert.equal(caretAt(runs, p, 4).y, 40, "줄 시작 위치를 우선");
  assert.equal(caretAt(runs, p, 5).x, 20);
  assert.deepEqual(selectionRects(runs, p, 1, 5), [
    { x: 20, y: 20, width: 20, height: 15 },
    { x: 40, y: 20, width: 20, height: 15 },
    { x: 10, y: 40, width: 10, height: 15 },
  ]);
  assert.deepEqual(selectionRects(runs, p, 2, 2), []);
  assert.equal(caretAt([{ ...base, text: "", charStart: 0, x: 10, w: 200, charX: [0] }], p, 0).x, 10);
  assert.equal(caretAt(runs, { section: 1, paragraph: 1 }, 0), null);
});
