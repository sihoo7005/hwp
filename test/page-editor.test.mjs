import test from "node:test";
import assert from "node:assert/strict";
import { toCodePoint, toUtf16, offsetAt, runAtPoint, caretAt, selectionRects, compositionRange } from "../page-editor.mjs";
import { paragraphKey, runAddress } from "../text-address.mjs";

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

test("표 셀 좌표: 같은 문단 번호의 옆 셀·본문·중첩 표와 커서 및 선택을 구분", () => {
  const base = { secIdx: 0, paraIdx: 0, parentParaIdx: 4, controlIdx: 0, cellParaIdx: 0,
    charStart: 0, y: 20, h: 15, text: "셀😀", w: 30, charX: [0, 10, 30] };
  const runs = [0, 1].map(cellIdx => ({ ...base, cellIdx, x: 10 + cellIdx * 200,
    cellPath: [{ controlIndex: 0, cellIndex: cellIdx, cellParaIndex: 0 }] }));
  runs.push({ ...base, cellIdx: 0, x: 500, cellPath: [runs[0].cellPath[0], runs[0].cellPath[0]] });
  runs[1].cellBounds = { x: 200, y: 10, w: 180, h: 40 };
  assert.equal(runAtPoint(runs, 370, 45), runs[1], "셀 안의 빈 공간도 그 셀을 선택");
  assert.equal(runAtPoint([{ ...runs[0], x: 180, w: 10, cellBounds: { x: 0, y: 10, w: 200, h: 40 } }, runs[1]], 201, 20),
    runs[1], "셀 경계의 클릭 여유가 옆 셀을 가리지 않음");
  const p = runAddress(runs[1]);
  assert.notEqual(paragraphKey(p), paragraphKey(runAddress(runs[0])));
  assert.notEqual(paragraphKey(p), paragraphKey({ section: 0, paragraph: 4 }));
  assert.equal(runAddress(runs[2]), null);
  assert.equal(caretAt(runs, p, 1).x, 220);
  assert.deepEqual(selectionRects(runs, p, 0, 2), [{ x: 210, y: 20, width: 30, height: 15 }]);
});


test("IME 표시: 단어 전체 조합·기존 글자 삭제·같은 단어·이모지·누락된 data의 교체 범위", () => {
  assert.deepEqual(compositionRange("서울 문서", "서울시 문서", 3, "서울시"), { start: 0, end: 2, text: "서울시" });
  assert.deepEqual(compositionRange("서울서울", "서울서울시", 5, "서울시"), { start: 2, end: 4, text: "서울시" });
  assert.deepEqual(compositionRange("단어가 길어요", "단어 길어요", 2, "단어"), { start: 0, end: 3, text: "단어" });
  assert.deepEqual(compositionRange("😀서울 문서", "😀서울시 문서", 5, "😀서울시"), { start: 0, end: 3, text: "😀서울시" });
  assert.deepEqual(compositionRange("서울 문서", "서울 문서", 2, "서울"), { start: 0, end: 2, text: "서울" });
  assert.deepEqual(compositionRange("서울 문서", "부산 문서", 2), { start: 0, end: 2, text: "부산" });
  assert.deepEqual(compositionRange("서울 문서", " 문서", 0, ""), { start: 0, end: 2, text: "" });
  assert.equal(compositionRange("서울 문서", "서울 문서", 2), null, "조합 취소 시 원본 표시");
});
