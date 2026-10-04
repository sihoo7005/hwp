// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
const bounded = (value, min, max, fallback = 0) => value >= min && value <= max ? value : fallback;
const dataView = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const color = value => `#${[value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
  .map(n => n.toString(16).padStart(2, "0")).join("")}`;
const defaultPage = { width: 793.7, height: 1122.5, left: 113.4, right: 113.4, top: 132.3, bottom: 113.4 };
const TABLE_ID = 0x74626c20;

function readBorders(bytes, records) {
  const data = dataView(bytes);
  const widths = [.1, .12, .15, .2, .25, .3, .4, .5, .6, .7, 1, 1.5, 2, 3, 4, 5];
  return [null, ...records.filter(r => r.tag === 20).map(r => {
    if (r.size < 36) return null;
    const style = {};
    ["Left", "Right", "Top", "Bottom"].forEach((side, i) => {
      // 실제 파일은 방향마다 종류·굵기·색을 연속 저장한다.
      const o = r.offset + 2 + i * 6;
      const type = data.getUint8(o);
      const line = type === 0 ? "none" : type === 3 || type === 7 ? "dotted" :
        [2, 4, 5, 6].includes(type) ? "dashed" : [8, 9, 10, 11].includes(type) ? "double" : "solid";
      style[`border${side}`] = `${(widths[data.getUint8(o + 1)] || .1) * 96 / 25.4}px ${line} ${color(data.getUint32(o + 2, true))}`;
    });
    style.backgroundColor = r.size >= 40 && (data.getUint32(r.offset + 32, true) & 1) ? color(data.getUint32(r.offset + 36, true)) : "transparent";
    return style;
  })];
}

function readTables(section, paragraphs, borders, budget) {
  const data = dataView(section.bytes);
  const byOffset = new Map(section.paragraphs.map((p, i) => [p.header.offset, paragraphs[i]]));
  const parents = new Map();
  const stack = [], tables = [];
  for (const r of section.records) {
    while (stack.length && r.level <= stack.at(-1).level) stack.pop();
    const current = stack.at(-1);
    if (r.tag === 66) {
      const paragraph = byOffset.get(r.offset);
      for (const level of parents.keys()) if (level >= r.level) parents.delete(level);
      parents.set(r.level, paragraph);
      if (current && r.level === current.level + 1) {
        if (current.list) current.list.paragraphs.push(paragraph);
        else current.table.valid = false;
      } else if (current) current.table.valid = false;
    } else if (r.tag === 71 && r.size >= 4 && data.getUint32(r.offset, true) === TABLE_ID) {
      const owner = parents.get(r.level - 1);
      if (!owner) continue;
      budget.tables++;
      if (budget.tables > 1000 || stack.length >= 10) { if (current) current.table.valid = false; continue; }
      const flags = r.size >= 24 ? data.getUint32(r.offset + 4, true) : 0;
      const table = { valid: r.size >= 24, rows: 0, columns: 0, cells: [], caption: null,
        width: r.size >= 24 ? bounded(data.getUint32(r.offset + 16, true) / 75, 1, 2400) : 0,
        align: (flags >>> 10) & 7, margins: [0, 0, 0, 0] };
      if (r.size >= 36) table.margins = [28, 30, 32, 34].map(o => bounded(data.getUint16(r.offset + o, true) / 75, 0, 100));
      (owner.tables ||= []).push(table);
      tables.push(table);
      stack.push({ level: r.level, table, list: null, hasMetadata: false });
    } else if (r.tag === 71 && r.size >= 16 && data.getUint32(r.offset, true) === 0x61746e6f && (data.getUint32(r.offset + 4, true) & 0xfff) === 4) {
      const owner = parents.get(r.level - 1);
      const run = owner?.runs.find(run => run.object && run.controlId === 0x61746e6f);
      if (run) {
        const decoration = offset => { const code = data.getUint16(r.offset + offset, true); return code >= 32 ? String.fromCharCode(code) : ""; };
        run.text = decoration(12) + data.getUint16(r.offset + 8, true) + decoration(14);
        run.object = false;
        owner.text = owner.runs.map(run => run.text).join("");
      }
    } else if (current && r.level === current.level + 1 && r.tag === 77) {
      current.hasMetadata = true;
      const t = current.table;
      if (r.size < 20) { t.valid = false; continue; }
      t.rows = data.getUint16(r.offset + 4, true);
      t.columns = data.getUint16(r.offset + 6, true);
      const slots = t.rows * t.columns;
      if (!t.rows || t.rows > 256 || !t.columns || t.columns > 64 || slots > 10000 || r.size < 20 + t.rows * 2) t.valid = false;
      else {
        budget.slots += slots;
        if (budget.slots > 20000) t.valid = false;
        t.border = borders[data.getUint16(r.offset + 18 + t.rows * 2, true)];
      }
      t.spacing = bounded(data.getUint16(r.offset + 8, true) / 75, 0, 100);
    } else if (current && r.level === current.level + 1 && r.tag === 72) {
      const list = { paragraphs: [], expected: r.size >= 8 ? data.getUint32(r.offset, true) : -1 };
      current.list = list;
      if (!current.hasMetadata) {
        if (current.table.caption || r.size < 12) current.table.valid = false;
        current.table.caption = { ...list, side: r.size >= 12 ? data.getUint32(r.offset + 8, true) & 3 : 3 };
        current.list = current.table.caption;
      } else {
        budget.cells++;
        // HWP 5.0의 실제 셀 리스트 헤더는 문단 수 DWORD + 속성 DWORD이다.
        if (r.size < 34 || budget.cells > 5000) { current.table.valid = false; continue; }
        const o = r.offset;
        const flags = data.getUint32(o + 4, true);
        const cell = { ...list, column: data.getUint16(o + 8, true), row: data.getUint16(o + 10, true),
          colSpan: data.getUint16(o + 12, true), rowSpan: data.getUint16(o + 14, true),
          width: bounded(data.getUint32(o + 16, true) / 75, 0, 2400),
          height: bounded(data.getUint32(o + 20, true) / 75, 0, 4800),
          padding: [24, 26, 28, 30].map(at => bounded(data.getUint16(o + at, true) / 75, 0, 100)),
          align: ["top", "middle", "bottom"][(flags >>> 5) & 3] || "top",
          border: borders[data.getUint16(o + 32, true)] || current.table.border };
        if (flags & 7) current.table.valid = false; // 세로쓰기 셀은 텍스트로 남긴다.
        current.table.cells.push(cell);
        current.list = cell;
      }
    }
  }
  for (const t of tables.reverse()) {
    if (!t.valid || !t.rows || !t.columns) { t.valid = false; continue; }
    const occupied = new Uint8Array(t.rows * t.columns);
    cells: for (const c of t.cells) {
      if (!c.colSpan || !c.rowSpan || c.column + c.colSpan > t.columns || c.row + c.rowSpan > t.rows || c.expected !== c.paragraphs.length) { t.valid = false; break; }
      if (c.paragraphs.some(p => p.tables?.some(nested => !nested.valid))) { t.valid = false; break; }
      for (let row = c.row; row < c.row + c.rowSpan; row++) for (let col = c.column; col < c.column + c.colSpan; col++) {
        const slot = row * t.columns + col;
        if (occupied[slot]) { t.valid = false; break cells; }
        occupied[slot] = 1;
      }
    }
    if (occupied.some(value => !value) || (t.caption && t.caption.expected !== t.caption.paragraphs.length)) t.valid = false;
    if (!t.valid) continue;
    t.columnWidths = Array(t.columns).fill(0);
    for (const c of t.cells) if (c.colSpan === 1) t.columnWidths[c.column] = Math.max(t.columnWidths[c.column], c.width);
    for (const c of t.cells) for (let col = c.column; col < c.column + c.colSpan; col++) if (!t.columnWidths[col]) t.columnWidths[col] = c.width / c.colSpan;
    t.columnWidths = t.columnWidths.map(width => width || 1);
    if (!t.width) t.width = Math.min(2400, t.columnWidths.reduce((sum, width) => sum + width, 0));
    for (const c of t.cells) for (const p of c.paragraphs) p.inTable = true;
    for (const p of t.caption?.paragraphs || []) p.inTable = true;
  }
}

export function readView(document) {
  const info = dataView(document.infoBytes);
  const records = document.infoRecords;
  const borders = readBorders(document.infoBytes, records);
  const tableBudget = { slots: 0, cells: 0, tables: 0 };
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
    const paragraphs = section.paragraphs.map(p => {
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
            id: shapes[shape]?.id ?? 0, object: Boolean(run.object),
            ...(run.controlId !== undefined ? { controlId: run.controlId } : {}) });
          position = next;
        }
      }
      return { text: p.text, nested: p.level > 0,
        style: paras[data.getUint16(p.header.offset + 8, true)] || {}, runs };
    });
    readTables(section, paragraphs, borders, tableBudget);
    return { page, paragraphs };
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

function renderTable(table, chars, highlight) {
  const block = document.createElement("div");
  block.className = "table-block";
  const [left, right, top, bottom] = table.margins;
  Object.assign(block.style, { paddingLeft: `${left}px`, paddingRight: `${right}px`, marginTop: `${top}px`, marginBottom: `${bottom}px` });
  const element = document.createElement("table");
  element.className = "document-table";
  element.setAttribute("aria-label", `${table.rows}행 ${table.columns}열 표`);
  Object.assign(element.style, { width: `${table.width}px`, borderCollapse: table.spacing ? "separate" : "collapse",
    borderSpacing: `${table.spacing}px`, marginLeft: table.align === 1 || table.align === 2 ? "auto" : "0",
    marginRight: table.align === 1 ? "auto" : "0" });
  if (table.caption) {
    const caption = document.createElement("caption");
    // ponytail: 좌우 캡션도 표 위에 표시한다. 정확한 좌우 배치는 개체 레이아웃 단계에서 처리한다.
    caption.style.captionSide = table.caption.side === 3 ? "bottom" : "top";
    for (const paragraph of table.caption.paragraphs) caption.append(renderParagraph(paragraph, chars, highlight));
    element.append(caption);
  }
  const columns = document.createElement("colgroup");
  const totalWidth = table.columnWidths.reduce((sum, width) => sum + width, 0);
  for (const width of table.columnWidths) {
    const col = document.createElement("col");
    col.style.width = `${width / totalWidth * 100}%`;
    columns.append(col);
  }
  element.append(columns);
  const body = document.createElement("tbody");
  const rows = Array.from({ length: table.rows }, () => []);
  for (const cell of table.cells) rows[cell.row].push(cell);
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const cell of cells.sort((a, b) => a.column - b.column)) {
      const td = document.createElement("td");
      td.colSpan = cell.colSpan;
      td.rowSpan = cell.rowSpan;
      const [l, r, t, b] = cell.padding;
      Object.assign(td.style, { height: `${cell.height}px`, padding: `${t}px ${r}px ${b}px ${l}px`, verticalAlign: cell.align,
        ...(cell.border || { border: "1px solid #aab5c2" }) });
      for (const paragraph of cell.paragraphs) td.append(renderParagraph(paragraph, chars, highlight));
      if (!cell.paragraphs.length) td.textContent = "\u00a0";
      tr.append(td);
    }
    body.append(tr);
  }
  element.append(body);
  block.append(element);
  return block;
}

function renderParagraph(paragraph, chars, highlight) {
  const fragment = document.createDocumentFragment();
  const s = paragraph.style;
  const create = () => {
    const p = document.createElement("p");
    p.className = "document-paragraph";
    if (paragraph.nested) p.classList.add("nested-paragraph");
    Object.assign(p.style, { textAlign: s.align || "left", textIndent: `${s.indent || 0}px`,
      margin: `${s.before || 0}px ${s.right || 0}px ${s.after || 0}px ${s.left || 0}px`, lineHeight: s.lineHeight || 1.6 });
    return p;
  };
  let p = create(), position = 0, tableAt = 0;
  const tables = paragraph.tables || [];
  const matches = [];
  if (highlight) for (let at = 0; (at = paragraph.text.indexOf(highlight, at)) !== -1; at += highlight.length) matches.push(at);
  for (const run of paragraph.runs) {
    const table = run.controlId === TABLE_ID ? tables[tableAt++] : null;
    if (table?.valid) {
      if (p.hasChildNodes()) fragment.append(p);
      fragment.append(renderTable(table, chars, highlight));
      p = create();
    } else {
      const span = document.createElement("span");
      if (run.object) span.className = "object-placeholder";
      const c = chars[run.id] || {};
      const fonts = (c.fonts || []).map(name => `"${name.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, " ")}"`);
      Object.assign(span.style, { fontFamily: [...fonts, '"Noto Sans KR"', "sans-serif"].join(","),
        fontSize: `${c.size || 11}pt`, fontWeight: c.bold ? "700" : "400", fontStyle: c.italic ? "italic" : "normal",
        color: c.color || "#000000", backgroundColor: c.background || "transparent", letterSpacing: `${c.spacing || 0}em`,
        textDecorationLine: [c.underline && "underline", c.overline && "overline", c.strike && "line-through"].filter(Boolean).join(" ") || "none" });
      appendText(span, run.text, highlight, position, matches);
      p.append(span);
    }
    position += run.text.length;
  }
  if (!paragraph.runs.length && !tables.some(t => t.valid)) p.textContent = "\u00a0";
  if (p.hasChildNodes()) fragment.append(p);
  for (const table of tables.slice(tableAt)) if (table.valid) fragment.append(renderTable(table, chars, highlight));
  return fragment;
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
      if (mode === "document") {
        if (!paragraph.inTable) sheet.append(renderParagraph(paragraph, model.chars, highlight));
        continue;
      }
      const p = document.createElement("p");
      p.className = "document-paragraph";
      if (paragraph.nested) p.classList.add("nested-paragraph");
      const matches = [];
      if (highlight) for (let at = 0; (at = paragraph.text.indexOf(highlight, at)) !== -1; at += highlight.length) matches.push(at);
      appendText(p, paragraph.text || "\u00a0", highlight, 0, matches);
      sheet.append(p);
    }
    group.append(sheet);
    fragment.append(group);
  });
  return fragment;
}
