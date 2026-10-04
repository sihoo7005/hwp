import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as pako from "pako";
import { openHwp, replaceHwp, readRecords, encodeText } from "../hwp.mjs";

const require = createRequire(import.meta.url);
const CFB = require("cfb");
globalThis.CFB = CFB;
globalThis.pako = pako;

function concat(parts) {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function record(tag, level, payload) {
  const header = new Uint8Array(payload.length >= 4095 ? 8 : 4);
  const data = new DataView(header.buffer);
  data.setUint32(0, tag | (level << 10) | (Math.min(payload.length, 4095) << 20), true);
  if (header.length === 8) data.setUint32(4, payload.length, true);
  return concat([header, payload]);
}

// 레코드 처리용 합성 파일이다. 실제 한글 프로그램과의 호환성을 증명하지 않는다.
function fixture({ compressed = false, flags = 0, text = "서울에서 서울을 만납니다.", extra = [], controls = false, sections = 1 } = {}) {
  const cfb = CFB.utils.cfb_new();
  const header = new Uint8Array(256);
  header.set(new TextEncoder().encode("HWP Document File"));
  const data = new DataView(header.buffer);
  data.setUint32(32, 0x05000302, true);
  data.setUint32(36, flags | Number(compressed), true);
  CFB.utils.cfb_add(cfb, "FileHeader", header);
  const props = new Uint8Array(30);
  new DataView(props.buffer).setUint16(0, sections, true);
  const info = record(16, 0, props);
  CFB.utils.cfb_add(cfb, "DocInfo", compressed ? pako.deflateRaw(info) : info);
  for (let i = 0; i < sections; i++) {
    const marker = new Uint8Array(controls ? 16 : 0);
    if (controls) {
      const m = new DataView(marker.buffer);
      m.setUint16(0, 2, true);
      m.setUint32(2, 0x73656364, true);
      marker.set(encodeText("서울"), 6); // 메타데이터에 있는 같은 문자열은 치환하면 안 된다.
      m.setUint16(14, 2, true);
    }
    const textBytes = concat([marker, encodeText(text + "\r")]);
    const para = new Uint8Array(24);
    const p = new DataView(para.buffer);
    p.setUint32(0, textBytes.length / 2, true);
    p.setUint16(12, 1, true);
    p.setUint16(16, 1, true);
    const shape = new Uint8Array(8);
    const line = new Uint8Array(36);
    const body = concat([record(66, 0, para), record(67, 1, textBytes), record(68, 1, shape), record(69, 1, line), ...extra]);
    CFB.utils.cfb_add(cfb, `BodyText/Section${i}`, compressed ? pako.deflateRaw(body) : body);
  }
  CFB.utils.cfb_add(cfb, "PrvText", encodeText("서울 미리보기"));
  CFB.utils.cfb_add(cfb, "PrvImage", Uint8Array.of(1, 2, 3));
  CFB.utils.cfb_add(cfb, "Scripts/DefaultJScript", Uint8Array.of(4, 5, 6));
  return new Uint8Array(CFB.write(cfb, { type: "array", fileType: "cfb" }));
}

for (const compressed of [false, true]) test(`${compressed ? "압축" : "비압축"}: 치환·재열기와 원본/다른 스트림 보존`, () => {
  const bytes = fixture({ compressed, controls: true, sections: 2 });
  const original = bytes.slice();
  const doc = openHwp(bytes);
  assert.equal(doc.editable, true);
  assert.equal(doc.paragraphs[0].text, "서울에서 서울을 만납니다.");
  const result = replaceHwp(doc, "서울", "부산");
  assert.equal(result.count, 4);
  assert.deepEqual(result.paragraphs, ["부산에서 부산을 만납니다.", "부산에서 부산을 만납니다."]);
  assert.deepEqual(bytes, original);
  const saved = CFB.read(result.bytes, { type: "array" });
  const before = CFB.read(bytes, { type: "array" });
  for (const path of ["FileHeader", "DocInfo", "Scripts/DefaultJScript"]) {
    assert.deepEqual([...CFB.find(saved, `/${path}`).content], [...CFB.find(before, `/${path}`).content]);
  }
  assert.equal(CFB.find(saved, "PrvImage"), null);
  assert.equal(new TextDecoder("utf-16le").decode(new Uint8Array(CFB.find(saved, "PrvText").content)), result.paragraphs.join("\r\n"));
  const reopened = openHwp(result.bytes);
  const oldBody = doc.sections[0].bytes;
  const newBody = reopened.sections[0].bytes;
  const textRecord = doc.paragraphs[0].textRecord;
  assert.deepEqual(newBody.subarray(textRecord.offset, textRecord.offset + 16), oldBody.subarray(textRecord.offset, textRecord.offset + 16));
  for (const r of doc.sections[0].records.filter(r => r.tag !== 67)) {
    assert.deepEqual(newBody.subarray(r.offset, r.offset + r.size), oldBody.subarray(r.offset, r.offset + r.size));
  }
  assert.equal(replaceHwp(doc, "서울", "대구").count, 4); // 원본 기준 반복 적용
});

test("길이가 다른 단어·제어 문자·이모지·빈 검색·같은 단어·미발견은 거절", () => {
  const doc = openHwp(fixture());
  for (const [from, to] of [["서울", "대한민국"], ["", ""], ["서울", "부\n"], ["서울", "🙂"], ["서울", "서울"], ["없는", "단어"]]) {
    assert.throws(() => replaceHwp(doc, from, to));
  }
});

test("표·알 수 없는 레코드는 읽기만 허용", () => {
  for (const tag of [77, 999]) {
    const doc = openHwp(fixture({ extra: [record(tag, 1, Uint8Array.of(0))] }));
    assert.equal(doc.editable, false);
    assert.throws(() => replaceHwp(doc, "서울", "부산"), /본문 확인만/);
  }
});

test("암호·배포용·DRM·서명·변경추적 및 알 수 없는 플래그는 거절", () => {
  for (const bit of [1, 2, 4, 6, 7, 8, 9, 10, 13, 14, 16, 17, 31]) assert.throws(() => openHwp(fixture({ flags: 1 << bit })), /특수 문서/);
});

test("CFB가 아닌 파일·잘린 레코드·잘못된 확장 길이는 거절", () => {
  assert.throws(() => openHwp(new TextEncoder().encode("not hwp")), /HWP 5.0/);
  assert.throws(() => readRecords(Uint8Array.of(1, 2, 3)), /헤더/);
  assert.throws(() => readRecords(Uint8Array.of(67, 4, 0xf0, 0xff)), /확장/);
  assert.throws(() => readRecords(record(67, 1, encodeText("서울")).subarray(0, 5)), /길이/);
});

test("확장 길이 레코드와 CFB mini stream 경계를 넘는 본문도 치환", () => {
  const doc = openHwp(fixture({ text: "서울".repeat(1500), compressed: true }));
  const result = replaceHwp(doc, "서울", "부산");
  assert.equal(result.count, 1500);
  assert.equal(result.paragraphs[0], "부산".repeat(1500));
});

test("미리보기 이미지가 앞에 있는 CFB 디렉터리도 경로를 보존", () => {
  const cfb = CFB.read(fixture(), { type: "array" });
  const image = cfb.FileIndex.indexOf(CFB.find(cfb, "PrvImage"));
  const order = [0, image, ...cfb.FileIndex.map((_, i) => i).filter(i => i !== 0 && i !== image)];
  const inverse = new Map(order.map((old, index) => [old, index]));
  cfb.FullPaths = order.map(i => cfb.FullPaths[i]);
  cfb.FileIndex = order.map(i => cfb.FileIndex[i]);
  for (const entry of cfb.FileIndex) {
    for (const key of ["L", "R", "C"]) if (entry[key] >= 0) entry[key] = inverse.get(entry[key]);
  }
  const bytes = new Uint8Array(CFB.write(cfb, { type: "array", fileType: "cfb" }));
  const result = replaceHwp(openHwp(bytes), "서울", "부산");
  assert.equal(result.count, 2);
  assert.equal(openHwp(result.bytes).paragraphs[0].text, "부산에서 부산을 만납니다.");
});

test("브라우저용 라이브러리가 Worker 전역에서 로드됨", () => {
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder });
  for (const path of ["node_modules/cfb/dist/cfb.min.js", "node_modules/pako/dist/pako.min.js"]) {
    vm.runInContext(readFileSync(path, "utf8"), context);
  }
  assert.equal(typeof context.CFB.read, "function");
  assert.equal(typeof context.CFB.write, "function");
  assert.equal(typeof context.pako.Inflate, "function");
  assert.deepEqual([...context.pako.inflateRaw(context.pako.deflateRaw(Uint8Array.of(1, 2, 3)))], [1, 2, 3]);
});
