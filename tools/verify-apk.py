#!/usr/bin/env python3
"""Check the deliverable uses this native build and all declared JNI entrypoints."""
from pathlib import Path
import hashlib
import re
import struct
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
apk = root / "dist/모바일한글.apk"
library = root / "android/app/src/main/jniLibs/arm64-v8a/libhwp_reader.so"
native = library.read_bytes()
with zipfile.ZipFile(apk) as archive:
    packaged = archive.read("lib/arm64-v8a/libhwp_reader.so")
    assert packaged == native, "APK contains a different native engine"
    assert not any(n.lower().endswith((".html", ".htm", ".js", ".wasm"))
                   for n in archive.namelist()), "Unexpected web assets in APK"
    assert any(n.startswith("classes") and n.endswith(".dex") for n in archive.namelist())
    assert "assets/fonts/NotoSansKR-Regular.ttf" in archive.namelist()
assert native[:5] == b"\x7fELF\x02", "Expected ELF64 native library"
header_offset = struct.unpack_from("<Q", native, 32)[0]
header_size, count = struct.unpack_from("<HH", native, 54)
load_alignments = [struct.unpack_from("<Q", native, header_offset + i * header_size + 48)[0]
                   for i in range(count)
                   if struct.unpack_from("<I", native, header_offset + i * header_size)[0] == 1]
assert load_alignments and min(load_alignments) >= 16384, "Native engine lacks 16 KiB segment alignment"
symbols = subprocess.check_output(
    ["/data/data/com.termux/files/usr/bin/llvm-nm", "-D", "--defined-only", str(library)], text=True)
source = (root / "android/app/src/main/java/com/sihoo/hwp/NativeReader.kt").read_text()
methods = re.findall(r"private external fun (\w+)\(", source)
missing = [name for name in methods if "Java_com_sihoo_hwp_NativeReader_" + name not in symbols]
assert methods and not missing, f"Missing JNI methods: {missing}"
report = [
    "PASS: APK embeds the newly built native engine.",
    f"PASS: All {len(methods)} Kotlin JNI declarations have exported native methods.",
    "PASS: Android bytecode, Korean fonts, and native ARM64 engine are included.",
    "PASS: No HTML, JavaScript, or WASM assets are packaged.",
    f"PASS: Native engine ELF LOAD alignment: {load_alignments}.",
    f"APK bytes: {apk.stat().st_size}",
    f"APK SHA-256: {hashlib.sha256(apk.read_bytes()).hexdigest()}",
    f"Native engine SHA-256: {hashlib.sha256(native).hexdigest()}",
    "UI installation/device instrumentation tests were not run.",
]
(root / "dist/verification.txt").write_text("\n".join(report) + "\n")
print("\n".join(report))
