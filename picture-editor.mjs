const { HU_PER_MM, HU_PER_PX, pictureKey } = await import("./picture-core.mjs" + new URL(import.meta.url).search);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// Browser decoding also applies the orientation of phone camera photos.
export async function readPicture(blob, crop = null, source = null) {
  if (!blob || !blob.size || blob.size > 8 * 1024 * 1024) throw new Error("사진은 8 MB 이하로 선택하세요.");
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error("사진을 읽을 수 없습니다. PNG·JPEG·WebP 등 브라우저에서 열 수 있는 사진을 선택하세요."); }
  try {
    if (bitmap.width * bitmap.height > 16000000 || bitmap.width > 16384 || bitmap.height > 16384)
      throw new Error("사진은 1,600만 화소 이하로 선택하세요.");
    let x = 0, y = 0, w = bitmap.width, h = bitmap.height;
    if (crop) {
      const values = [crop.left, crop.top, crop.right, crop.bottom];
      if (values.some(v => !Number.isFinite(v) || v < 0 || v >= 100) || crop.left + crop.right >= 100 || crop.top + crop.bottom >= 100)
        throw new Error("자르기 비율의 합은 가로·세로 각각 100% 미만이어야 합니다.");
      if (source?.crop && source.extent?.every(n => n > 0)) {
        x = bitmap.width * source.crop.left / source.extent[0];
        y = bitmap.height * source.crop.top / source.extent[1];
        w = bitmap.width * (source.crop.right - source.crop.left) / source.extent[0];
        h = bitmap.height * (source.crop.bottom - source.crop.top) / source.extent[1];
      }
      x += w * crop.left / 100; y += h * crop.top / 100;
      w *= 1 - (crop.left + crop.right) / 100; h *= 1 - (crop.top + crop.bottom) / 100;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h));
    canvas.getContext("2d").drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);
    const mime = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const encoded = await new Promise(resolve => canvas.toBlob(resolve, mime, .92));
    if (!encoded || encoded.size > 8 * 1024 * 1024) throw new Error("변환한 사진이 8 MB를 넘습니다. 더 작은 사진을 선택하세요.");
    return { bytes: new Uint8Array(await encoded.arrayBuffer()), width: canvas.width, height: canvas.height,
      extension: mime === "image/jpeg" ? "jpg" : "png" };
  } finally { bitmap.close(); }
}

export class PictureEditor {
  constructor(pageEditor, { change, warn, resize }) {
    this.editor = pageEditor; this.change = change; this.warn = warn; this.resize = resize;
    this.panel = document.querySelector("#picture-panel");
    this.frame = document.createElement("div"); this.frame.className = "picture-frame"; this.frame.tabIndex = 0;
    this.frame.setAttribute("role", "group"); this.frame.setAttribute("aria-label", "선택한 사진. 방향키로 이동, Delete로 삭제, Escape로 선택 해제");
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = document.createElement("button"); handle.type = "button"; handle.dataset.corner = corner;
      handle.className = `picture-handle ${corner}`; handle.setAttribute("aria-label", `사진 ${corner} 모서리 크기 조절`);
      this.frame.append(handle);
    }
    this.editor.surface.append(this.frame); this.frame.hidden = true;
    this.reset();
    const surface = this.editor.surface;
    surface.addEventListener("pointerdown", e => this.down(e), true);
    surface.addEventListener("pointermove", e => this.move(e), true);
    surface.addEventListener("pointerup", e => this.up(e), true);
    surface.addEventListener("pointercancel", e => { if (this.drag) { this.drag = null; this.paint(); } }, true);
    surface.addEventListener("click", e => { if (this.picturePointer) { e.stopImmediatePropagation(); this.picturePointer = false; } }, true);
    this.frame.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); this.select(null); }
      else if (["Delete", "Backspace"].includes(e.key)) { e.preventDefault(); this.change("delete"); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault(); const step = e.shiftKey ? 10 : 1;
        this.change("properties", { props: this.positionProps(this.selected.x + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0),
          this.selected.y + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0)) });
      }
    });
    const $ = id => this.panel.querySelector(`#${id}`);
    $("picture-close").addEventListener("click", () => this.select(null));
    $("picture-size").addEventListener("submit", e => {
      e.preventDefault(); this.change("properties", { props: { width: Math.round(Number($("picture-width").value) * HU_PER_MM),
        height: Math.round(Number($("picture-height").value) * HU_PER_MM) } });
    });
    for (const name of ["width", "height"]) $(`picture-${name}`).addEventListener("input", () => {
      if (!this.selected || !$("picture-ratio").checked) return;
      const other = name === "width" ? "height" : "width", props = this.selected.props;
      $(`picture-${other}`).value = (Number($(`picture-${name}`).value) * props[other] / props[name]).toFixed(1);
    });
    $("picture-rotate").addEventListener("submit", e => { e.preventDefault(); this.change("properties", {
      props: { rotationAngle: Math.round(Number($("picture-angle").value)) } }); });
    for (const delta of [-90, 90]) $(`picture-rotate-${delta < 0 ? "left" : "right"}`).addEventListener("click", () =>
      this.change("properties", { props: { rotationAngle: (this.selected.props.rotationAngle + delta + 360) % 360 } }));
    $("picture-layout").addEventListener("change", () => {
      const mode = $("picture-layout").value;
      this.change("properties", { props: mode === "inline" ? { treatAsChar: true } :
        { ...this.positionProps(this.selected.x, this.selected.y), textWrap: mode } });
    });
    $("picture-position").addEventListener("submit", e => { e.preventDefault(); this.change("properties", {
      props: this.positionProps(Number($("picture-x").value) * HU_PER_MM / HU_PER_PX,
        Number($("picture-y").value) * HU_PER_MM / HU_PER_PX) }); });
    for (const align of ["Left", "Center", "Right"]) $(`picture-align-${align.toLowerCase()}`).addEventListener("click", () =>
      this.change("properties", { props: { ...this.positionProps(this.selected.x, this.selected.y),
        horzRelTo: "Page", horzAlign: align, horzOffset: 0 } }));
    $("picture-crop").addEventListener("submit", e => {
      e.preventDefault(); const crop = Object.fromEntries(["left", "top", "right", "bottom"].map(n => [n, Number($(`picture-crop-${n}`).value)]));
      this.change("crop", { crop });
    });
    $("picture-delete").addEventListener("click", () => this.change("delete"));
  }

  reset() { this.selected = null; this.pictures = []; this.drag = null; this.pendingSelection = null; this.panel.hidden = true; this.frame.hidden = true; }
  show(data) {
    this.pictures = data.pictures || []; this.page = data.page; this.revision = data.revision;
    this.pageWidth = Number(this.editor.image.dataset.width); this.pageHeight = Number(this.editor.surface.style.height.replace("px", ""));
    const key = this.pendingSelection ? pictureKey(this.pendingSelection) : this.selected?.key;
    this.pendingSelection = null;
    if (key) this.select(this.pictures.find(p => p.key === key && p.editable) || null, false);
    this.paint();
  }
  setBusy(busy) {
    this.busy = busy;
    for (const el of this.panel.querySelectorAll("button,input,select")) el.disabled = busy ||
      !!this.selected?.props.sizeProtect && ["picture-width", "picture-height", "picture-size-apply"].includes(el.id);
    this.frame.style.pointerEvents = busy ? "none" : "";
  }
  select(p, focus = true) {
    const wasHidden = this.panel.hidden;
    this.selected = p; this.panel.hidden = !p;
    if (p) {
      this.editor.input.blur(); this.editor.active = null; this.editor.paint();
      const values = { width: p.props.width / HU_PER_MM, height: p.props.height / HU_PER_MM,
        x: p.x * HU_PER_PX / HU_PER_MM, y: p.y * HU_PER_PX / HU_PER_MM, angle: p.props.rotationAngle };
      for (const [name, value] of Object.entries(values)) this.panel.querySelector(`#picture-${name}`).value =
        name === "angle" ? value : value.toFixed(1);
      this.panel.querySelector("#picture-layout").value = p.props.treatAsChar ? "inline" : p.props.textWrap;
      for (const n of ["left", "top", "right", "bottom"]) this.panel.querySelector(`#picture-crop-${n}`).value = 0;
      if (focus) this.frame.focus({ preventScroll: true });
    }
    this.setBusy(this.busy); this.paint();
    if (wasHidden !== this.panel.hidden) this.resize();
  }
  point(e) {
    const box = this.editor.image.getBoundingClientRect(), scale = this.pageWidth / box.width;
    return { x: (e.clientX - box.left) * scale, y: (e.clientY - box.top) * scale };
  }
  down(e) {
    if (e.button !== 0 || this.editor.isComposing) return;
    const pt = this.point(e);
    const p = this.frame.contains(e.target) ? this.selected : [...this.pictures].reverse().find(p =>
      pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y && pt.y <= p.y + p.h);
    this.picturePointer = !!p;
    if (!p) {
      if (this.selected) {
        // Read the text hit before closing the panel changes the document's zoom and position.
        const hit = this.editor.atPoint(e);
        this.select(null); e.preventDefault(); e.stopImmediatePropagation(); this.picturePointer = true;
        if (hit?.run.editable) {
          this.editor.activate(hit.run, hit.offset, true, e.shiftKey);
          if (e.pointerType !== "touch") {
            this.editor.dragAnchor = this.editor.input.selectionStart; this.editor.dragging = true;
            this.editor.surface.setPointerCapture(e.pointerId);
          }
        }
      }
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (!p.editable) { this.warn("보호된 셀·머리말·중첩 표의 사진은 보기만 지원합니다."); return; }
    if (this.busy) return;
    const wasSelected = this.selected?.key === p.key;
    this.select(p);
    const corner = e.target.dataset.corner;
    if (corner && p.props.sizeProtect) { this.warn("크기가 보호된 사진입니다."); return; }
    if (e.pointerType === "touch" && !wasSelected && !corner) return;
    // Measure the finger/mouse movement, not layout changes when selection opens the panel or hides the keyboard.
    this.drag = { p, clientX: e.clientX, clientY: e.clientY,
      scale: this.pageWidth / this.editor.image.getBoundingClientRect().width,
      threshold: e.pointerType === "touch" ? 8 : 3, corner, pointerId: e.pointerId,
      rect: { x: p.x, y: p.y, w: p.w, h: p.h }, moved: false };
    this.editor.surface.setPointerCapture(e.pointerId);
  }
  move(e) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = this.drag, clientDx = e.clientX - d.clientX, clientDy = e.clientY - d.clientY;
    const dx = clientDx * d.scale, dy = clientDy * d.scale;
    d.moved ||= Math.hypot(clientDx, clientDy) > d.threshold;
    if (!d.moved) return;
    if (!d.corner) d.rect = { ...d.rect, x: clamp(d.p.x + dx, 0, Math.max(0, this.pageWidth - d.p.w)),
      y: clamp(d.p.y + dy, 0, Math.max(0, this.pageHeight - d.p.h)) };
    else {
      let w = clamp(d.p.w + (d.corner.includes("w") ? -dx : dx), 5, 2000);
      let h = clamp(d.p.h + (d.corner.includes("n") ? -dy : dy), 5, 2000);
      if (this.panel.querySelector("#picture-ratio").checked) {
        const factor = Math.abs(w / d.p.w - 1) > Math.abs(h / d.p.h - 1) ? w / d.p.w : h / d.p.h;
        w = d.p.w * factor; h = d.p.h * factor;
      }
      d.rect = { x: d.p.x + (d.corner.includes("w") ? d.p.w - w : 0),
        y: d.p.y + (d.corner.includes("n") ? d.p.h - h : 0), w, h };
    }
    this.paint(d.rect);
  }
  up(e) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = this.drag; this.drag = null;
    if (this.editor.surface.hasPointerCapture(e.pointerId)) this.editor.surface.releasePointerCapture(e.pointerId);
    if (d.moved) this.change("properties", { props: d.corner ? {
      width: Math.round(d.p.props.width * d.rect.w / d.p.w), height: Math.round(d.p.props.height * d.rect.h / d.p.h),
      ...(d.corner !== "se" && !d.p.props.treatAsChar ? this.positionProps(d.rect.x, d.rect.y) : {})
    } : this.positionProps(d.rect.x, d.rect.y) });
    else this.paint();
  }
  positionProps(x, y) {
    return { treatAsChar: false, horzRelTo: "Paper", vertRelTo: "Paper", horzAlign: "Left", vertAlign: "Top",
      horzOffset: Math.round(x * HU_PER_PX), vertOffset: Math.round(y * HU_PER_PX),
      textWrap: this.selected?.props.textWrap || "Square" };
  }
  paint(rect = this.selected) {
    this.frame.hidden = !this.selected;
    if (!this.selected) return;
    Object.assign(this.frame.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    const scale = this.editor.image.getBoundingClientRect().width / this.pageWidth || 1;
    this.frame.style.setProperty("--picture-handle-size", `${(window.innerWidth <= 720 ? 24 : 16) / scale}px`);
    this.frame.dataset.key = this.selected.key;
  }
}
