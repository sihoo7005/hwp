// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
// ponytail: 동일 길이 치환만 허용한다. 삽입·삭제에는 문단·서식 위치 갱신이 필요하다.
const MAX_FILE = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_RECORDS = 100000;
const decoder = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });
const simpleRecords = new Set([66, 67, 68, 69, 71, 73, 74, 75]);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function encodeText(text) {
  const bytes = new Uint8Array(text.length * 2);
  const data = view(bytes);
  for (let i = 0; i < text.length; i++) data.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

function inflate(bytes, budget) {
  const chunks = [];
  let total = 0;
  const stream = new globalThis.pako.Inflate({ raw: true, chunkSize: 65536 });
  stream.onData = chunk => {
    total += chunk.length;
    budget.size += chunk.length;
    check(budget.size <= MAX_EXPANDED, "압축 해제한 문서가 32 MB 한도를 초과합니다.");
    chunks.push(chunk);
  };
  stream.push(bytes, true);
  check(stream.ended && !stream.err, "문서의 압축 데이터가 손상되었거나 지원하지 않는 형식입니다.");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function readRecords(bytes, budget = { records: 0 }) {
  const data = view(bytes);
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    check(offset + 4 <= bytes.length, "레코드 헤더가 잘린 문서입니다.");
    const header = data.getUint32(offset, true);
    const tag = header & 1023;
    const level = (header >>> 10) & 1023;
    let size = header >>> 20;
    offset += 4;
    if (size === 4095) {
      check(offset + 4 <= bytes.length, "확장 레코드 길이가 잘린 문서입니다.");
      size = data.getUint32(offset, true);
      offset += 4;
    }
    check(size <= bytes.length - offset, "레코드 길이가 실제 데이터와 맞지 않습니다.");
    budget.records = (budget.records || 0) + 1;
    check(budget.records <= MAX_RECORDS, "문서의 레코드 수가 너무 많습니다.");
    records.push({ tag, level, offset, size });
    offset += size;
  }
  return records;
}

function textRuns(bytes, record) {
  check(record.size % 2 === 0, "본문의 문자 데이터 길이가 잘못되었습니다.");
  const data = view(bytes);
  const end = record.offset + record.size;
  const runs = [];
  const displayRuns = [];
  let offset = record.offset;
  let text = "";
  let supported = true;
  while (offset < end) {
    const code = data.getUint16(offset, true);
    if (code >= 32) {
      const start = offset;
      while (offset < end && data.getUint16(offset, true) >= 32) offset += 2;
      const value = decoder.decode(bytes.subarray(start, offset));
      runs.push({ offset: start, text: value });
      displayRuns.push({ position: (start - record.offset) / 2, length: value.length, text: value });
      text += value;
      continue;
    }
    // 규격의 char는 1 WCHAR, inline/extended 컨트롤은 8 WCHAR이다.
    const size = code >= 1 && code <= 23 && code !== 10 && code !== 13 ? 16 : 2;
    check(offset + size <= end, "본문의 제어 문자가 잘렸습니다.");
    if (size === 16) check(data.getUint16(offset + 14, true) === code, "본문의 제어 문자 경계가 잘못되었습니다.");
    if (![2, 9, 10, 13, 24, 30, 31].includes(code)) supported = false;
    const value = code === 9 ? "\t" : code === 10 ? "\n" : code === 24 ? "-" :
      code === 30 || code === 31 ? " " : code !== 2 && code !== 13 ? "[개체]" : "";
    if (value) displayRuns.push({ position: (offset - record.offset) / 2, length: size / 2,
      text: value, control: true, object: value === "[개체]",
      ...(size === 16 && value === "[개체]" ? { controlId: data.getUint32(offset + 2, true) } : {}) });
    text += value;
    offset += size;
  }
  return { runs, displayRuns, text, supported };
}

export function openHwp(input) {
  const bytes = new Uint8Array(input);
  check(bytes.length <= MAX_FILE, "파일 크기는 최대 8 MB입니다.");
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  check(signature.every((n, i) => bytes[i] === n), "HWP 5.0 파일을 선택하세요. HWPX와 구형 HWP는 지원하지 않습니다.");
  const CFB = globalThis.CFB;
  const container = CFB.read(bytes, { type: "array" });
  const root = container.FullPaths[0];
  const streams = container.FileIndex.map((entry, i) => ({ entry, path: container.FullPaths[i].slice(root.length) }))
    .filter(item => item.entry.type === 2);
  check(new Set(streams.map(item => item.path.toLowerCase())).size === streams.length, "중복된 스트림 이름이 있는 문서입니다.");
  const header = streams.find(item => item.path === "FileHeader");
  check(header?.entry.content.length === 256, "HWP 파일 헤더가 없거나 잘못되었습니다.");
  const headerBytes = new Uint8Array(header.entry.content);
  check(String.fromCharCode(...headerBytes.subarray(0, 17)) === "HWP Document File", "HWP 파일 서명이 잘못되었습니다.");
  const version = view(headerBytes).getUint32(32, true);
  check((version >>> 24) === 5 && ((version >>> 16) & 255) === 0, "이 실험판은 HWP 5.0 문서만 지원합니다.");
  const flags = view(headerBytes).getUint32(36, true);
  const allowedFlags = (1 << 0) | (1 << 3) | (1 << 5) | (1 << 11) | (1 << 12) | (1 << 15);
  check((flags & ~allowedFlags) === 0, "암호·배포용·DRM·서명·이력·변경추적 등 특수 문서는 지원하지 않습니다.");
  check(!streams.some(item => /^(ViewText\/|DocHistory\/)|(?:DigitalSignature|DrmLicense|CertDrmInfo)/.test(item.path)), "보호 또는 이력 정보가 있는 문서는 지원하지 않습니다.");
  const compressed = Boolean(flags & 1);
  const budget = { size: 0, records: 0 };
  const docInfo = streams.find(item => item.path === "DocInfo");
  check(docInfo, "DocInfo 문서 정보가 없습니다.");
  const infoBytes = compressed ? inflate(docInfo.entry.content, budget) : new Uint8Array(docInfo.entry.content);
  const infoRecords = readRecords(infoBytes, budget);
  const props = infoRecords.find(record => record.tag === 16);
  check(props?.size >= 2, "구역 수를 확인할 문서 속성이 없습니다.");
  const sections = streams.filter(item => /^BodyText\/Section\d+$/.test(item.path))
    .sort((a, b) => Number(a.path.match(/\d+$/)[0]) - Number(b.path.match(/\d+$/)[0]));
  const sectionCount = view(infoBytes).getUint16(props.offset, true);
  check(sections.length > 0 && sections.length <= 256 && sections.length === sectionCount, "문서 구역 수가 잘못되었거나 너무 많습니다.");
  check(sections.every((item, i) => item.path === `BodyText/Section${i}`), "문서 구역 순서가 잘못되었습니다.");
  let editable = true;
  let textSize = 0;
  const paragraphs = [];
  for (const section of sections) {
    section.bytes = compressed ? inflate(section.entry.content, budget) : new Uint8Array(section.entry.content);
    section.records = readRecords(section.bytes, budget);
    section.paragraphs = [];
    let paragraph = null;
    for (const record of section.records) {
      if (!simpleRecords.has(record.tag)) editable = false;
      const data = view(section.bytes);
      if (record.tag === 71) {
        check(record.size >= 4, "컨트롤 헤더가 잘렸습니다.");
        const id = data.getUint32(record.offset, true);
        if (id !== 0x73656364 && id !== 0x636f6c64) editable = false;
      }
      if (record.tag === 66) {
        check(record.size >= 22, "문단 헤더가 잘렸습니다.");
        paragraph = { header: record, textRecord: null, runs: [], displayRuns: [], charShapes: [], text: "", level: record.level };
        section.paragraphs.push(paragraph);
        paragraphs.push(paragraph);
        check(paragraphs.length <= 5000, "화면에 표시할 문단이 5천 개 한도를 초과합니다.");
        if (record.level !== 0 || ![22, 24].includes(record.size)) editable = false;
      } else if (record.tag === 67) {
        check(paragraph && !paragraph.textRecord && record.level === paragraph.level + 1, "문단과 본문 텍스트의 구조가 맞지 않습니다.");
        const parsed = textRuns(section.bytes, record);
        check((data.getUint32(paragraph.header.offset, true) & 0x7fffffff) === record.size / 2, "문단의 문자 수가 실제 데이터와 맞지 않습니다.");
        Object.assign(paragraph, parsed, { textRecord: record });
        if (!parsed.supported) editable = false;
        textSize += parsed.text.length;
        check(textSize <= 200000, "화면에 표시할 본문이 20만 글자 한도를 초과합니다.");
      } else if (record.tag === 68 && paragraph && record.level === paragraph.level + 1) {
        check(record.size % 8 === 0, "문단의 글자 모양 정보가 잘렸습니다.");
        budget.styles = (budget.styles || 0) + record.size / 8;
        check(budget.styles <= 50000, "화면에 표시할 글자 모양 구간이 5만 개 한도를 초과합니다.");
        for (let offset = record.offset; offset < record.offset + record.size; offset += 8) {
          const position = data.getUint32(offset, true);
          check(position <= (data.getUint32(paragraph.header.offset, true) & 0x7fffffff), "글자 모양의 위치가 문단 범위를 벗어납니다.");
          check(paragraph.charShapes.length === 0 ? position === 0 : position > paragraph.charShapes.at(-1).position,
            "문단의 글자 모양 순서가 잘못되었습니다.");
          paragraph.charShapes.push({ position, id: data.getUint32(offset + 4, true) });
        }
      }
    }
  }
  check(paragraphs.length > 0, "읽을 수 있는 본문 문단이 없습니다.");
  return { bytes, streams, sections, infoBytes, infoRecords, compressed, paragraphs, editable,
    reason: editable ? "" : "표·그림·수식·필드 또는 미지원 구조가 있어 본문 확인만 가능합니다." };
}

export function replaceHwp(document, from, to) {
  check(document.editable, document.reason);
  check(from.length > 0 && from.length <= 200 && from.length === to.length, "찾을 단어와 바꿀 단어는 같은 글자 수여야 합니다.");
  check(/^[가-힣a-zA-Z0-9]+$/.test(from) && /^[가-힣a-zA-Z0-9]+$/.test(to), "이번 실험에서는 한글·영문·숫자로 된 단어만 바꿀 수 있습니다.");
  check(from !== to, "찾을 단어와 다른 단어를 입력하세요.");
  const replacements = new Map();
  const expected = [];
  let count = 0;
  for (const section of document.sections) {
    const patched = section.bytes.slice();
    let changed = false;
    for (const paragraph of section.paragraphs) {
      for (const run of paragraph.runs) {
        let start = 0;
        let match;
        while ((match = run.text.indexOf(from, start)) !== -1) {
          patched.set(encodeText(to), run.offset + match * 2);
          count++;
          changed = true;
          start = match + from.length;
        }
      }
      expected.push(paragraph.textRecord ? textRuns(patched, paragraph.textRecord).text : paragraph.text);
    }
    if (changed) replacements.set(section.path, document.compressed ? globalThis.pako.deflateRaw(patched) : patched);
  }
  check(count > 0, "본문에서 찾을 단어를 발견하지 못했습니다.");
  // ponytail: 줄 배치 캐시는 원형 보존한다. 글자 폭이 바뀌는 결과의 한글 재열기는 별도 검증해야 한다.
  const CFB = globalThis.CFB;
  const output = CFB.read(document.bytes, { type: "array" });
  for (const [path, content] of replacements) CFB.utils.cfb_add(output, `/${path}`, content);
  const preview = expected.join("\r\n");
  CFB.utils.cfb_add(output, "PrvText", encodeText(preview));
  // 이전 본문을 보여주는 미리보기 이미지는 제거한다. 한글에서 저장하면 다시 생성될 수 있다.
  CFB.utils.cfb_del(output, "PrvImage");
  // 삭제 후 디렉터리 인덱스·트리 포인터를 재작성해야 모든 스트림의 경로가 유지된다.
  CFB.utils.cfb_gc(output);
  const bytes = new Uint8Array(CFB.write(output, { type: "array", fileType: "cfb" }));
  // 다운로드 전에 같은 파서로 다시 읽어 구조와 실제 치환 수를 확인한다.
  const reopened = openHwp(bytes);
  check(reopened.paragraphs.length === document.paragraphs.length, "저장 결과의 문단 수가 달라졌습니다.");
  check(reopened.paragraphs.every((p, i) => p.text === expected[i]), "저장 결과의 본문이 예상한 치환 결과와 다릅니다.");
  for (const item of document.streams) {
    if (["PrvText", "PrvImage"].includes(item.path) || replacements.has(item.path)) continue;
    const preserved = reopened.streams.find(saved => saved.path === item.path);
    check(preserved && preserved.entry.content.length === item.entry.content.length &&
      Array.from(item.entry.content).every((byte, i) => byte === preserved.entry.content[i]),
      `저장 중 ${item.path} 스트림이 변경되었습니다.`);
  }
  return { bytes, count, paragraphs: reopened.paragraphs.map(p => p.text), document: reopened };
}
