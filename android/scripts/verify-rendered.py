#!/usr/bin/env python3
"""Independently rasterize outlined SVG pages; keep PNG previews for review."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET
import fitz

root = Path(__file__).resolve().parents[1] / "native/target/fixtures/rendered"
paths = sorted(root.glob("*.svg"))
assert len(paths) >= 9, "Missing document render fixtures"


def nodes(node):
    yield node
    for child in node.get("children", []):
        yield from nodes(child)


def ink_pixels(pixmap):
    data, stride = pixmap.samples, pixmap.n
    return sum(min(data[i:i+3]) < 245 for i in range(0, len(data), stride))


for path in paths:
    xml = ET.parse(path).getroot()
    elements = list(xml.iter())
    assert not any(e.tag.endswith("}text") for e in elements), "Unoutlined text"
    layout = json.loads(path.with_suffix(".json").read_text())
    source_nodes = list(nodes(layout))
    with fitz.open(path) as document:
        assert len(document) == 1, path
        page = document[0]
        assert page.rect.width > 100 and page.rect.height > 100, path
        pixels = page.get_pixmap(matrix=fitz.Matrix(1.25, 1.25), alpha=False)
        ink = ink_pixels(pixels)
        assert ink > 100, f"Blank rendered page: {path.name}"
        if path.name == "equation.hwpx-0.svg":
            equations = [n for n in source_nodes if n['type'] == 'Equation']
            assert equations, "Equation fixture must contain equations"
            for equation in equations:
                b = equation['bbox']
                if b['w'] < 2 or b['h'] < 2:
                    continue
                clip = fitz.Rect(b['x'], b['y'], b['x']+b['w'], b['y']+b['h'])
                crop = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, alpha=False)
                assert ink_pixels(crop) > 0, "Equation area was lost in Canvas SVG"
        if path.name == "image.hwpx-0.svg":
            assert any(e.tag.endswith('}image') for e in elements), "Embedded picture was lost"
        if path.name == "table.hwpx-0.svg":
            tables = [n for n in source_nodes if n['type'] == 'Table']
            cells = [n for n in source_nodes if n['type'] == 'Cell']
            assert tables and cells, "Table/cell layout was lost"
            # This fixture has three long border edges; do not invent a closed box.
            borders = sum(1 for d in page.get_drawings() for item in d['items']
                          if item[0] == 'l' and abs(item[1] - item[2]) > 20)
            assert borders >= 3, f"Table border geometry missing: {borders}"
        if path.name.startswith('chart.'):
            chart_nodes = [n for n in source_nodes if n['type'] in ('RawSvg', 'Image')]
            assert chart_nodes, "Chart rendering payload was lost"
            data = pixels.samples
            colored = sum(max(data[i:i+3])-min(data[i:i+3]) > 30
                          for i in range(0, len(data), pixels.n))
            assert colored > 50, "Chart series colors were lost"
        if path.name.startswith('shapes.'):
            assert any(n['type'] in ('Group', 'Rect', 'Ellipse', 'Path') for n in source_nodes), "Shapes lost"
        pixels.save(path.with_suffix(".png"))
        print(f"{path.name}: SVG, {pixels.width}x{pixels.height}, {ink} ink pixels")
