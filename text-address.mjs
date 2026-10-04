// Body paragraphs and cell paragraphs have separate identities, even on the same line.
export function paragraphKey(p) {
  return p.control === undefined ? `${p.section}:${p.paragraph}` :
    `${p.section}:${p.paragraph}:cell:${p.control}:${p.cell}:${p.cellParagraph}`;
}

export function runAddress(run) {
  if (run.parentParaIdx === undefined) return { section: run.secIdx, paragraph: run.paraIdx };
  // ponytail: nested tables keep their full path and stay read-only until path editing is supported.
  if (!Number.isInteger(run.cellIdx) || run.cellPath?.length !== 1) return null;
  return { section: run.secIdx, paragraph: run.parentParaIdx, control: run.controlIdx,
    cell: run.cellIdx, cellParagraph: run.cellParaIdx };
}

export function sameParagraph(a, b) { return !!a && !!b && paragraphKey(a) === paragraphKey(b); }
