// 사진 주소와 엔진 속성은 Worker·저장 검증·화면에서 같은 규칙으로 사용합니다.
export const HU_PER_PX = 75;
export const HU_PER_MM = 7200 / 25.4;
export const pictureKey = (p = {}) => `${p.section}:${p.paragraph}:${JSON.stringify(p.path || [])}:${p.control}`;
export function pictureProps(doc, p) {
  return JSON.parse(p.path?.length ? doc.getCellPicturePropertiesByPath(p.section, p.paragraph,
    JSON.stringify(p.path), p.control) : doc.getPictureProperties(p.section, p.paragraph, p.control));
}
export function setPictureProps(doc, p, props) {
  return p.path?.length ? doc.setCellPicturePropertiesByPath(p.section, p.paragraph,
    JSON.stringify(p.path), p.control, JSON.stringify(props)) :
    doc.setPictureProperties(p.section, p.paragraph, p.control, JSON.stringify(props));
}
export function picturesOnPage(doc, page, reason = "") {
  const controls = JSON.parse(doc.getPageControlLayout(page)).controls || [];
  const locked = JSON.parse(doc.getControls()).filter(c => c.props?.Lock);
  return controls.filter(c => c.type === "image").map(c => {
    const p = { section: c.secIdx, paragraph: c.parentParaIdx ?? c.paraIdx, control: c.controlIdx,
      path: c.cellPath || [], page, x: c.x, y: c.y, w: c.w, h: c.h, plane: c.plane, zOrder: c.zOrder };
    p.key = pictureKey(p);
    p.editable = !reason && !c.headerFooter && p.path.length <= 1;
    if (p.editable && p.path.length) {
      const cell = p.path[0];
      const props = JSON.parse(doc.getCellProperties(p.section, p.paragraph, cell.controlIndex, cell.cellIndex));
      p.editable = !props.cellProtect && !props.textDirection;
    }
    if (locked.some(l => l.list === 0 && l.para === p.paragraph && l.controlIndex === p.control)) p.editable = false;
    if (p.editable) {
      try { p.props = pictureProps(doc, p); }
      catch { p.editable = false; }
    }
    return p;
  });
}
export function pictureSource(doc, p) {
  const bytes = doc.getControlImageData(p.section, p.paragraph, JSON.stringify(p.path || []), p.control);
  const mime = doc.getControlImageMime(p.section, p.paragraph, JSON.stringify(p.path || []), p.control);
  const tree = JSON.parse(doc.getPageLayerTreeWithProfile(p.page, "screen", true, true));
  let extent, crop;
  const ops = [];
  function visit(n) {
    for (const op of n.ops || []) if (op.type === "image" && op.originalSizeHu) ops.push(op);
    for (const child of n.children || []) visit(child);
    if (n.child) visit(n.child);
  }
  visit(tree.root);
  // Check the bytes too: overlapping photos can have the same rectangle.
  // Rotation can give the control and image operation different bounding boxes.
  const distance = op => Math.hypot(op.bbox.x + op.bbox.width / 2 - p.x - p.w / 2,
    op.bbox.y + op.bbox.height / 2 - p.y - p.h / 2);
  for (const op of ops.sort((a, b) => distance(a) - distance(b))) if (op.sourceImageKey) {
    const candidate = doc.getSourceImageBytes(op.sourceImageKey);
    if (candidate.length === bytes.length && candidate.every((v, i) => v === bytes[i])) {
      extent = op.originalSizeHu; crop = op.crop; break;
    }
  }
  return { bytes, mime, extent, crop };
}
export function locatePicture(doc, p, page) {
  const key = pictureKey(p);
  let match = picturesOnPage(doc, page).find(p => p.key === key && p.editable);
  for (let i = 0; !match && i < doc.pageCount(); i++) if (i !== page)
    match = picturesOnPage(doc, i).find(p => p.key === key && p.editable);
  return match || p;
}
export function checkedImage(image) {
  if (!(image?.bytes instanceof Uint8Array) || !image.bytes.length || image.bytes.length > 8 * 1024 * 1024 ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.width > 16384 || image.height > 16384 || image.width * image.height > 16000000)
    throw new Error("사진은 8 MB·1,600만 화소 이하로 선택하세요.");
  const b = image.bytes;
  if (!(image.extension === "png" && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) &&
      !(image.extension === "jpg" && b[0] === 255 && b[1] === 216 && b[2] === 255))
    throw new Error("PNG 또는 JPEG 사진으로 선택하세요.");
  return image;
}
export function checkedPictureProps(props) {
  const numbers = { width: [1, 283465], height: [1, 283465], horzOffset: [-283465, 283465],
    vertOffset: [-283465, 283465], rotationAngle: [-360, 360] };
  const choices = { horzRelTo: ["Paper", "Page", "Column", "Para"], vertRelTo: ["Paper", "Page", "Para"],
    horzAlign: ["Left", "Center", "Right"], vertAlign: ["Top", "Center", "Bottom"],
    textWrap: ["Square", "TopAndBottom", "BehindText", "InFrontOfText"] };
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("사진 속성을 확인하세요.");
  for (const [key, value] of Object.entries(props)) {
    const valid = numbers[key] ? Number.isInteger(value) && value >= numbers[key][0] && value <= numbers[key][1] :
      choices[key] ? choices[key].includes(value) : ["treatAsChar", "horzFlip", "vertFlip", "allowOverlap"].includes(key) && typeof value === "boolean";
    if (!valid) throw new Error("사진 크기·위치·회전 값을 확인하세요.");
  }
  return props;
}
export function verifyPictures(doc, reopened) {
  const all = d => {
    const map = new Map();
    for (let page = 0; page < d.pageCount(); page++) for (const p of picturesOnPage(d, page))
      if (p.props) map.set(p.key, p);
    return map;
  };
  const before = all(doc), after = all(reopened);
  if (before.size !== after.size) throw new Error("저장 결과의 사진 수가 달라졌습니다.");
  for (const [key, p] of before) {
    const other = after.get(key);
    if (!other) throw new Error("저장 결과의 사진 위치가 달라졌습니다.");
    for (const name of ["width", "height", "treatAsChar", "rotationAngle", "horzFlip", "vertFlip", "textWrap",
      "horzRelTo", "vertRelTo", "horzAlign", "vertAlign", "horzOffset", "vertOffset"])
      if (p.props[name] !== other.props[name]) throw new Error(`저장 결과의 사진 속성이 달라졌습니다 (${name}).`);
    const a = doc.getControlImageData(p.section, p.paragraph, JSON.stringify(p.path), p.control);
    const b = reopened.getControlImageData(other.section, other.paragraph, JSON.stringify(other.path), other.control);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error("저장 결과의 사진 데이터가 달라졌습니다.");
  }
}
