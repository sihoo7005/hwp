// 문서·비밀번호·편집 이력은 이 Worker 안에서만 처리합니다.
importScripts("./vendor/cfb.min.js");
const ready = Promise.all([import("./vendor/rhwp.js"), import("./editor-core.mjs" + new URL(self.location.href).search),
  import("./text-address.mjs" + new URL(self.location.href).search)]);
if (typeof OffscreenCanvas !== "undefined") {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (context) self.measureTextWidth = (font, text) => { context.font = font; return context.measureText(text).width; };
}
let initialized;
let doc;
let session;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const [{ default: init, HwpDocument }, { TextSession }, { paragraphKey, runAddress, sameParagraph }] = await ready;
      await (initialized ||= init());
      if (data.type === "open") {
        if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 32 * 1024 * 1024)
          throw new Error("파일 크기는 최대 32 MB입니다.");
        doc?.free();
        doc = null;
        session = null;
        const bytes = new Uint8Array(data.bytes);
        doc = data.password ? HwpDocument.openWithPassword(bytes, data.password) : new HwpDocument(bytes);
        if (doc.pageCount() < 1 || doc.pageCount() > 5000) throw new Error("문서 보기는 1~5,000쪽까지 지원합니다.");
        session = new TextSession(doc, bytes, { CFB, passwordUsed: !!data.password });
      }
      if (!session) throw new Error("문서를 먼저 열어 주세요.");
      if (data.type === "page") {
        if (!Number.isInteger(data.page) || data.page < 0 || data.page >= doc.pageCount()) throw new Error("표시할 쪽을 찾을 수 없습니다.");
        let page = data.page;
        if (data.followCaret && data.caret && session.paragraphs.some(p => p.editable && sameParagraph(p, data.caret))) {
          const c = data.caret;
          const cursor = JSON.parse(c.control === undefined ? doc.getCursorRect(c.section, c.paragraph, c.offset) :
            doc.getCursorRectInCell(c.section, c.paragraph, c.control, c.cell, c.cellParagraph, c.offset));
          if (Number.isInteger(cursor?.pageIndex) && cursor.pageIndex >= 0 && cursor.pageIndex < doc.pageCount()) page = cursor.pageIndex;
        }
        const svg = doc.renderPageSvg(page);
        if (svg.length > 16 * 1024 * 1024) throw new Error("이 쪽의 그림·개체가 표시 한도를 넘었습니다.");
        const runs = JSON.parse(doc.getPageTextLayout(page)).runs || [];
        const editable = new Set(session.paragraphs.filter(p => p.editable).map(paragraphKey));
        const tables = new Map();
        const pageRuns = runs.slice(0, 5000).map(r => {
          const address = runAddress(r);
          let cellBounds;
          if (address?.control !== undefined && editable.has(paragraphKey(address))) {
            const table = `${address.section}:${address.paragraph}:${address.control}`;
            if (!tables.has(table)) tables.set(table, JSON.parse(doc.getTableCellBboxes(address.section,
              address.paragraph, address.control, page)));
            // Header tables can expose the same paragraph indices. Only the body cell's own fragment is editable.
            cellBounds = tables.get(table).find(b => b.cellIdx === address.cell && b.pageIndex === page &&
              r.x >= b.x - 2 && r.x <= b.x + b.w + 2 && r.y >= b.y - 2 && r.y <= b.y + b.h + 2);
          }
          return { ...r, cellBounds, editable: !!address && editable.has(paragraphKey(address)) &&
            (address.control === undefined || !!cellBounds) };
        });
        self.postMessage({ id: data.id, type: data.type, page, revision: session.revision, svg,
          runs: pageRuns });
        return;
      }
      if (data.type === "edit") session.edit(data.section, data.paragraph, data.before, data.text, data);
      else if (["undo", "redo"].includes(data.type)) {
        session.history(data.type);
        doc = session.doc;
      } else if (data.type === "save") {
        const saved = session.export(HwpDocument);
        self.postMessage({ id: data.id, type: data.type, ...saved }, [saved.bytes.buffer]);
        return;
      } else if (data.type === "saved") session.savedRevision = data.revision;
      else if (!["open", "state"].includes(data.type)) throw new Error("지원하지 않는 편집 요청입니다.");
      const text = JSON.parse(doc.getTextFileUnicode());
      const warnings = JSON.parse(doc.getValidationWarnings());
      const unsupported = session.format === "hml" ? (JSON.parse(doc.getHmlOpenMetadata()).warnings?.length || 0) : 0;
      self.postMessage({ id: data.id, type: data.type, ...session.summary(), text: text.slice(0, 200000),
        truncated: text.length > 200000, warnings: warnings.count || 0, unsupported });
    } catch (error) {
      const message = error?.message || String(error);
      self.postMessage({ id: data.id, type: "error", passwordRequired: /비밀번호|암호 문서/.test(message), message });
    }
  });
};
