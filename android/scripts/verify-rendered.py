#!/usr/bin/env python3
"""Check generated page PDFs with an independent PDF rasterizer; retain previews."""
from pathlib import Path
import json
import fitz

root = Path(__file__).resolve().parents[1] / "native/target/fixtures/rendered"
paths = sorted(root.glob("*.pdf"))
assert len(paths) >= 6, "Missing document render fixtures"
for path in paths:
    with fitz.open(path) as pdf:
        assert len(pdf) == 1, path
        page = pdf[0]
        assert page.rect.width > 100 and page.rect.height > 100, path
        pixels = page.get_pixmap(matrix=fitz.Matrix(1.25, 1.25), alpha=False)
        data = pixels.samples
        ink = sum(data[i] < 245 or data[i+1] < 245 or data[i+2] < 245
                  for i in range(0, len(data), pixels.n))
        assert ink > 100, f"Blank rendered page: {path.name}"
        if path.name == "equation.hwpx-0.pdf":
            boxes = json.loads((root / "equation-boxes.json").read_text())
            for x, y, width, height in boxes:
                if width < 2 or height < 2:
                    continue
                box = fitz.Rect(x, y, x + width, y + height) * 0.75
                crop = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=box, alpha=False)
                assert any(value < 240 for value in crop.samples), "Equation area was lost in PDF output"
        if path.name == "image.hwpx-0.pdf":
            assert page.get_images(full=True), "Embedded image was lost in PDF output"
        if path.name == "table.hwpx-0.pdf":
            # SVG exporters may lower borders to filled thin rectangles, not strokes.
            borders = 0
            for drawing in page.get_drawings():
                for item in drawing['items']:
                    if item[0] == 'l' and (item[1] - item[2]).magnitude > 20:
                        borders += 1
                    if item[0] == 're':
                        rect = item[1]
                        if min(rect.width, rect.height) < 3 and max(rect.width, rect.height) > 20:
                            borders += 1
            print(f"Table long edges: {borders}")
            assert borders >= 4, "Table border geometry missing"
        pixels.save(path.with_suffix(".png"))
        print(f"{path.name}: one page, {pixels.width}x{pixels.height}, {ink} ink pixels")
