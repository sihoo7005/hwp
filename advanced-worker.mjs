// 문서·비밀번호·편집 이력은 이 Worker 안에서만 처리합니다.
importScripts("./vendor/cfb.min.js");
const ready = Promise.all([import("./vendor/rhwp.js"), import("./editor-core.mjs" + new URL(self.location.href).search)]);
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
      const [{ default: init, HwpDocument }, { TextSession }] = await ready;
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
        if (data.followCaret && data.caret && session.paragraphs.some(p => p.editable && p.section === data.caret.section && p.paragraph === data.caret.paragraph)) {
          const cursor = JSON.parse(doc.getCursorRect(data.caret.section, data.caret.paragraph, data.caret.offset));
          if (Number.isInteger(cursor?.pageIndex) && cursor.pageIndex >= 0 && cursor.pageIndex < doc.pageCount()) page = cursor.pageIndex;
        }
        const svg = doc.renderPageSvg(page);
        if (svg.length > 16 * 1024 * 1024) throw new Error("이 쪽의 그림·개체가 표시 한도를 넘었습니다.");
        const runs = JSON.parse(doc.getPageTextLayout(page)).runs || [];
        const editable = new Set(session.paragraphs.filter(p => p.editable).map(p => `${p.section}:${p.paragraph}`));
        self.postMessage({ id: data.id, type: data.type, page, revision: session.revision, svg,
          runs: runs.slice(0, 5000).map(r => ({ ...r, editable: r.parentParaIdx === undefined && editable.has(`${r.secIdx}:${r.paraIdx}`) })) });
        return;
      }
      if (data.type === "edit") session.edit(data.section, data.paragraph, data.before, data.text);
      else if (["undo", "redo"].includes(data.type)) session.history(data.type);
      else if (data.type === "save") {
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
