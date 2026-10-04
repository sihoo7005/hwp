// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
const bounded = (value, min, max, fallback = 0) => value >= min && value <= max ? value : fallback;
const dataView = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const color = value => `#${[value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
  .map(n => n.toString(16).padStart(2, "0")).join("")}`;
const defaultPage = { width: 793.7, height: 1122.5, left: 113.4, right: 113.4, top: 132.3, bottom: 113.4 };

export function readView(document) {
  const info = dataView(document.infoBytes);
  const records = document.infoRecords;
  const fonts = records.filter(r => r.tag === 19).map(r => {
    if (r.size < 3) return "";
    const length = info.getUint16(r.offset + 1, true);
    if (length > 256 || 3 + length * 2 > r.size) return "";
    return new TextDecoder("utf-16le").decode(document.infoBytes.subarray(r.offset + 3, r.offset + 3 + length * 2));
  });
  const mappings = records.find(r => r.tag === 17);
  const koreanCount = mappings?.size >= 32 ? info.getUint32(mappings.offset + 4, true) : 0;
  const englishCount = mappings?.size >= 32 ? info.getUint32(mappings.offset + 8, true) : 0;
  const chars = records.filter(r => r.tag === 21).map(r => {
    if (r.size < 68) return {};
    const o = r.offset;
    const flags = info.getUint32(o + 46, true);
    const koreanId = info.getUint16(o, true), englishId = info.getUint16(o + 2, true);
    return {
      fonts: [...new Set([koreanId < koreanCount ? fonts[koreanId] : "",
        englishId < englishCount ? fonts[koreanCount + englishId] : ""].filter(Boolean))],
      size: bounded(info.getInt32(o + 42, true) / 100, 2, 200, 11),
      bold: Boolean(flags & 2), italic: Boolean(flags & 1),
      underline: ((flags >>> 2) & 3) === 1, overline: ((flags >>> 2) & 3) === 3,
      strike: Boolean((flags >>> 18) & 7), color: color(info.getUint32(o + 52, true)),
      background: info.getUint32(o + 60, true) === 0xffffffff ? "transparent" : color(info.getUint32(o + 60, true)),
      spacing: bounded(info.getInt8(o + 21) / 100, -.5, .5),
    };
  });
  const paras = records.filter(r => r.tag === 25).map(r => {
    if (r.size < 28) return {};
    const o = r.offset, flags = info.getUint32(o, true);
    const lineType = r.size >= 54 ? info.getUint32(o + 46, true) & 31 : flags & 3;
    const line = r.size >= 54 ? info.getUint32(o + 50, true) : info.getInt32(o + 24, true);
    return {
      align: ["justify", "left", "right", "center", "justify", "justify"][(flags >>> 2) & 7] || "left",
      // 문단 여백·간격은 HWPUNIT의 두 배 정밀도로 저장된다.
      left: bounded(info.getInt32(o + 4, true) / 150, 0, 800),
      right: bounded(info.getInt32(o + 8, true) / 150, 0, 800),
      indent: bounded(info.getInt32(o + 12, true) / 150, -800, 800),
      before: bounded(info.getInt32(o + 16, true) / 150, 0, 800),
      after: bounded(info.getInt32(o + 20, true) / 150, 0, 800),
      lineHeight: lineType === 0 ? bounded(line / 100, .5, 5, 1.6) :
        lineType === 1 ? `${bounded(line / 75, 2, 800, 20)}px` : 1.6,
    };
  });
  return { chars, sections: document.sections.map(section => {
    const data = dataView(section.bytes);
    const pageRecord = section.records.find(r => r.tag === 73 && r.size >= 40);
    let page = { ...defaultPage };
    if (pageRecord) {
      const o = pageRecord.offset;
      let width = data.getUint32(o, true) / 75, height = data.getUint32(o + 4, true) / 75;
      if (data.getUint32(o + 36, true) & 1) [width, height] = [height, width];
      width = bounded(width, 192, 2400, defaultPage.width);
      height = bounded(height, 192, 4800, defaultPage.height);
      // 본문은 위·아래 여백 안쪽의 머리말·꼬리말 영역 다음에 배치한다.
      const top = (data.getUint32(o + 16, true) + data.getUint32(o + 24, true)) / 75;
      const bottom = (data.getUint32(o + 20, true) + data.getUint32(o + 28, true)) / 75;
      page = { width, height,
        left: bounded(data.getUint32(o + 8, true) / 75, 0, width / 3, Math.min(defaultPage.left, width / 4)),
        right: bounded(data.getUint32(o + 12, true) / 75, 0, width / 3, Math.min(defaultPage.right, width / 4)),
        top: bounded(top, 0, height / 3, Math.min(defaultPage.top, height / 4)),
        bottom: bounded(bottom, 0, height / 3, Math.min(defaultPage.bottom, height / 4)) };
    }
    return { page, paragraphs: section.paragraphs.map(p => {
      const runs = [];
      const shapes = p.charShapes;
      let shape = 0;
      for (const run of p.displayRuns) {
        let position = run.position;
        const end = position + run.length;
        while (position < end) {
          while (shape + 1 < shapes.length && shapes[shape + 1].position <= position) shape++;
          const next = run.control ? end : Math.min(end, shapes[shape + 1]?.position ?? end);
          runs.push({ text: run.control ? run.text : run.text.slice(position - run.position, next - run.position),
            id: shapes[shape]?.id ?? 0, object: Boolean(run.object) });
          position = next;
        }
      }
      return { text: p.text, nested: p.level > 0,
        style: paras[data.getUint16(p.header.offset + 8, true)] || {}, runs };
    }) };
  }) };
}

function appendText(element, text, highlight, start, matches) {
  let offset = 0;
  let low = 0, high = matches.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (matches[middle] + highlight.length <= start) low = middle + 1;
    else high = middle;
  }
  for (let i = low; i < matches.length && matches[i] < start + text.length; i++) {
    const match = matches[i];
    const left = Math.max(0, match - start), right = Math.min(text.length, match + highlight.length - start);
    if (right <= left) continue;
    element.append(document.createTextNode(text.slice(offset, left)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(left, right);
    element.append(mark);
    offset = right;
  }
  element.append(document.createTextNode(text.slice(offset)));
}

export function renderView(model, mode, highlight = "") {
  const fragment = document.createDocumentFragment();
  if (!model) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "HWP 파일을 열면 여기에 문서가 표시됩니다.";
    fragment.append(p);
    return fragment;
  }
  model.sections.forEach((section, i) => {
    const group = document.createElement("div");
    group.className = "document-section";
    const caption = document.createElement("p");
    caption.className = "sheet-caption";
    const mm = px => Math.round(px * 25.4 / 96);
    caption.textContent = `구역 ${i + 1} · ${mm(section.page.width)} × ${mm(section.page.height)} mm`;
    group.append(caption);
    const sheet = document.createElement("article");
    sheet.className = mode === "document" ? "document-paper" : "document-text";
    sheet.setAttribute("aria-label", `문서 구역 ${i + 1}`);
    if (mode === "document") {
      // ponytail: 구역마다 본문을 연속 배치한다. 정확한 쪽 나눔에는 별도 레이아웃 엔진이 필요하다.
      const page = section.page;
      Object.assign(sheet.style, { width: `${page.width}px`, minHeight: `${page.height}px`,
        padding: `${page.top}px ${page.right}px ${page.bottom}px ${page.left}px` });
      sheet.dataset.width = page.width;
    }
    for (const paragraph of section.paragraphs) {
      const p = document.createElement("p");
      p.className = "document-paragraph";
      if (paragraph.nested) p.classList.add("nested-paragraph");
      const matches = [];
      if (highlight) for (let at = 0; (at = paragraph.text.indexOf(highlight, at)) !== -1; at += highlight.length) matches.push(at);
      if (mode === "text") appendText(p, paragraph.text || "\u00a0", highlight, 0, matches);
      else {
        const s = paragraph.style;
        Object.assign(p.style, { textAlign: s.align || "left", textIndent: `${s.indent || 0}px`,
          margin: `${s.before || 0}px ${s.right || 0}px ${s.after || 0}px ${s.left || 0}px`, lineHeight: s.lineHeight || 1.6 });
        let position = 0;
        for (const run of paragraph.runs) {
          const span = document.createElement("span");
          if (run.object) span.className = "object-placeholder";
          const c = model.chars[run.id] || {};
          const fonts = (c.fonts || []).map(name => `"${name.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, " ")}"`);
          Object.assign(span.style, { fontFamily: [...fonts, '"Noto Sans KR"', "sans-serif"].join(","),
            fontSize: `${c.size || 11}pt`, fontWeight: c.bold ? "700" : "400", fontStyle: c.italic ? "italic" : "normal",
            color: c.color || "#000000", backgroundColor: c.background || "transparent", letterSpacing: `${c.spacing || 0}em`,
            textDecorationLine: [c.underline && "underline", c.overline && "overline", c.strike && "line-through"].filter(Boolean).join(" ") || "none" });
          appendText(span, run.text, highlight, position, matches);
          p.append(span);
          position += run.text.length;
        }
        if (!paragraph.runs.length) p.textContent = "\u00a0";
      }
      sheet.append(p);
    }
    group.append(sheet);
    fragment.append(group);
  });
  return fragment;
}
