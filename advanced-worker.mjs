// 문서와 비밀번호는 이 Worker 안에서만 처리하며 서버로 보내지 않습니다.
import init, { HwpDocument } from "./vendor/rhwp.js";
let ready;
const documents = new Map();
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  // 초기화·열기·쪽 렌더링을 순서대로 처리합니다.
  queue = queue.then(async () => {
    try {
      await (ready ||= init());
      if (data.type === "open") {
        if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 32 * 1024 * 1024)
          throw new Error("파일 크기는 최대 32 MB입니다.");
        documents.get(data.key)?.free();
        documents.delete(data.key);
        const bytes = new Uint8Array(data.bytes);
        const doc = data.password ? HwpDocument.openWithPassword(bytes, data.password) : new HwpDocument(bytes);
        try {
          const pages = doc.pageCount();
          if (pages < 1 || pages > 5000) throw new Error("문서 보기는 1~5,000쪽까지 지원합니다.");
          const text = JSON.parse(doc.getTextFileUnicode());
          const warnings = JSON.parse(doc.getValidationWarnings());
          const format = doc.getSourceFormat();
          const unsupported = format === "hml" ? (JSON.parse(doc.getHmlOpenMetadata()).warnings?.length || 0) : 0;
          documents.set(data.key, doc);
          self.postMessage({ type: "opened", key: data.key, pages, format, unsupported,
            text: text.slice(0, 200000), truncated: text.length > 200000, warnings: warnings.count || 0 });
        } catch (error) { doc.free(); throw error; }
      } else if (data.type === "page") {
        const doc = documents.get(data.key);
        if (!doc || !Number.isInteger(data.page) || data.page < 0 || data.page >= doc.pageCount())
          throw new Error("표시할 쪽을 찾을 수 없습니다.");
        const svg = doc.renderPageSvg(data.page);
        if (svg.length > 16 * 1024 * 1024) throw new Error("이 쪽의 그림·개체가 표시 한도를 넘었습니다.");
        self.postMessage({ type: "page", id: data.id, key: data.key, page: data.page, svg });
      }
    } catch (error) {
      const message = error?.message || String(error);
      self.postMessage({ type: "error", key: data.key, id: data.id,
        passwordRequired: /비밀번호|암호 문서/.test(message), message });
    }
  });
};
