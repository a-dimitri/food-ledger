"""Generate the PWA/app icons for the Ledger, with no third-party deps.

Draws a "ledger" motif — a terracotta tile with cream list rows + bullets — via
supersampled point-sampling (alpha-weighted downscale for clean edges) and a
minimal hand-rolled PNG encoder. Run: python tools/gen_icons.py
Outputs to ui/static/icons/. Re-run to regenerate; the PNGs are committed.
"""
from __future__ import annotations
import struct, zlib
from pathlib import Path

TER = (163, 90, 58)      # #a35a3a terracotta background
CREAM = (245, 238, 225)  # list rows / bullets

# Ledger rows in normalized [0,1] coords (y down): (row_y, right_end_x)
ROWS = [(0.315, 0.775), (0.45, 0.70), (0.585, 0.755), (0.72, 0.62)]
ROW_X0, ROW_HALF = 0.30, 0.028   # left start, half-thickness (rounded caps)
DOT_X, DOT_R = 0.235, 0.034      # bullet centre-x, radius
BG_RADIUS = 0.22                 # corner radius for the rounded ("any") tile


def _in_rounded_rect(x, y, rad):
    cx = min(max(x, rad), 1 - rad)
    cy = min(max(y, rad), 1 - rad)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= rad * rad


def _in_content(x, y):
    for yc, x1 in ROWS:
        # bullet
        if (x - DOT_X) ** 2 + (y - yc) ** 2 <= DOT_R * DOT_R:
            return True
        # stadium row
        qx = min(max(x, ROW_X0), x1)
        if (x - qx) ** 2 + (y - yc) ** 2 <= ROW_HALF * ROW_HALF:
            return True
    return False


def render(size, ss, rounded):
    """rounded=True -> transparent outside a rounded tile ('any' icons).
    rounded=False -> full opaque square (maskable / apple-touch)."""
    out = bytearray(size * size * 4)
    n = ss * ss
    for oy in range(size):
        for ox in range(size):
            A = R = G = B = 0
            for j in range(ss):
                sy = (oy * ss + j + 0.5) / (size * ss)
                for i in range(ss):
                    sx = (ox * ss + i + 0.5) / (size * ss)
                    if rounded and not _in_rounded_rect(sx, sy, BG_RADIUS):
                        continue  # transparent sample
                    pr, pg, pb = CREAM if _in_content(sx, sy) else TER
                    A += 255
                    R += pr * 255; G += pg * 255; B += pb * 255
            idx = (oy * size + ox) * 4
            if A:
                out[idx] = R // A; out[idx + 1] = G // A; out[idx + 2] = B // A
            out[idx + 3] = A // n
    return bytes(out)


def write_png(path, size, rgba):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def main():
    out = Path(__file__).resolve().parent.parent / "ui" / "static" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    ss = 3
    jobs = [
        ("icon-192.png", 192, True),
        ("icon-512.png", 512, True),
        ("icon-maskable-512.png", 512, False),
        ("apple-touch-icon-180.png", 180, False),
        ("icon-1024.png", 1024, False)
    ]
    for name, size, rounded in jobs:
        write_png(out / name, size, render(size, ss, rounded))
        print("wrote", name)


if __name__ == "__main__":
    main()
