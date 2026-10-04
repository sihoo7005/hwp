// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
importScripts("./vendor/cfb.min.js", "./vendor/pako.min.js");
const core = import("./hwp.mjs");
let document;
self.onmessage = async event => {
  try {
    const { openHwp, replaceHwp } = await core;
    if (event.data.type === "open") {
      document = openHwp(event.data.bytes);
      self.postMessage({ type: "opened", editable: document.editable, reason: document.reason,
        paragraphs: document.paragraphs.map(p => p.text), sections: document.sections.length });
    } else if (event.data.type === "replace") {
      if (!document) throw new Error("먼저 HWP 파일을 열어 주세요.");
      const result = replaceHwp(document, event.data.from, event.data.to);
      self.postMessage({ type: "replaced", ...result }, [result.bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || "문서를 처리하지 못했습니다." });
  }
};
