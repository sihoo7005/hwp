#!/usr/bin/env python3
"""Decode pinned rhwp fonts into native SFNT files, retaining embedded notices."""
from pathlib import Path
import shutil
import urllib.request
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vendor/rhwp"
OUT = ROOT / "app/src/main/assets/fonts"
OUT.mkdir(parents=True, exist_ok=True)
names = [
    "NotoSansKR-Regular", "NotoSansKR-Bold", "NotoSerifKR-Regular", "NotoSerifKR-Bold",
    "NanumGothic-Regular", "NanumGothic-Bold", "NanumMyeongjo-Regular", "NanumMyeongjo-Bold",
    "D2Coding-Regular", "D2Coding-Bold", "LatinModernMath-Regular", "SourceHanSerifK-OldHangul-subset",
]
notices = ["Native fonts from rhwp 1a76570e833917d15817415a53c09ad61ab3203f",
           "WOFF2 containers are decoded; glyphs, family names and font tables are retained."]
for name in names:
    source = SOURCE / "assets/fonts" / (name + ".woff2")
    with TTFont(source) as font:
        extension = ".otf" if font.sfntVersion == "OTTO" else ".ttf"
        font.flavor = None
        font.save(OUT / (name + extension))
        notices.append("\n" + name)
        for key in (0, 13, 14):
            value = font["name"].getDebugName(key)
            if value:
                notices.append(value)
        if name == "NotoSansKR-Regular":
            cmap = font.getBestCmap()
            assert all(ord(char) in cmap for char in "한글■□○─"), "Korean/table glyph coverage"
        if name == "LatinModernMath-Regular":
            assert all(ord(char) in font.getBestCmap() for char in "∑∫√∞"), "Math glyph coverage"
shutil.copyfile(SOURCE / "assets/fonts/SourceHanSerifK-OFL.txt", OUT / "OFL.txt")
# Include the publisher's full GUST license in addition to font metadata.
license_path = OUT / "GUST-FONT-LICENSE.txt"
if not license_path.exists():
    with urllib.request.urlopen("https://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt", timeout=30) as response:
        license_path.write_bytes(response.read())
shutil.copyfile(SOURCE / "assets/fonts/FONTS.md", OUT / "SOURCES.md")
(OUT / "FONT-NOTICES.txt").write_text("\n".join(notices), encoding="utf-8")
print(f"Prepared {len(names)} native fonts with Korean and math coverage checks.")
