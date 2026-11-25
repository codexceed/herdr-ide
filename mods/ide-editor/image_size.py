"""Prints an image's file name, width and height, for the Markdown preview.

Usage: image_size.py FILE. Reads only the header: SVG (width/height, else viewBox), PNG, GIF,
JPEG and WebP. Stdlib only. Exits 1 with a message when the size can't be read.
"""
import os
import re
import struct
import sys


def svg_size(head):
    tag = re.search(r"<svg\b[^>]*>", head.decode("utf-8", "replace"))
    if not tag:
        return None
    tag = tag.group(0)

    def num(name):
        m = re.search(r"\s" + name + r"\s*=\s*[\"']\s*([0-9.]+)\s*(?:px)?\s*[\"']", tag)
        return float(m.group(1)) if m else None

    w, h = num("width"), num("height")
    vb = re.search(r"\sviewBox\s*=\s*[\"']([^\"']*)", tag)
    if vb and not (w and h):
        v = [float(x) for x in re.split(r"[\s,]+", vb.group(1).strip())]
        if len(v) == 4 and v[2] > 0 and v[3] > 0:
            w, h = (w, w * v[3] / v[2]) if w else (h * v[2] / v[3], h) if h else (v[2], v[3])
    return (w or 300, h or 150)  # a browser's default size for an SVG that names none


def jpeg_size(f):
    f.seek(2)
    while True:
        b = f.read(1)
        while b and b != b"\xff":
            b = f.read(1)
        while b == b"\xff":
            b = f.read(1)
        if not b:
            return None
        marker = b[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            _, _, h, w = struct.unpack(">HBHH", f.read(7))
            return (w, h)
        (length,) = struct.unpack(">H", f.read(2))
        f.seek(length - 2, 1)


def size(path):
    with open(path, "rb") as f:
        head = f.read(65536)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", head[6:10])
        if head[:2] == b"\xff\xd8":
            return jpeg_size(f)
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            kind = head[12:16]
            if kind == b"VP8X":
                return (1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little"))
            if kind == b"VP8 ":
                w, h = struct.unpack("<HH", head[26:30])
                return (w & 0x3FFF, h & 0x3FFF)
            if kind == b"VP8L":
                bits = int.from_bytes(head[21:25], "little")
                return (1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF))
        if b"<svg" in head:
            return svg_size(head)
    return None


def main():
    path = sys.argv[1]
    try:
        wh = size(path)
    except (OSError, struct.error, ValueError) as e:
        sys.exit(f"Cannot read the image: {e}")
    if not wh or wh[0] <= 0 or wh[1] <= 0:
        sys.exit("Not an image this preview can show (SVG, PNG, GIF, JPEG or WebP)")
    print(os.path.basename(path), round(wh[0]), round(wh[1]))


if __name__ == "__main__":
    main()
