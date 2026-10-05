#!/usr/bin/env python3
"""Draws the app icon — the brand mark: a red rounded square with a white dot —
and writes build/icon.png (1024 px). `npm run icon` then turns it into icon.icns.

Pure standard library, so it runs anywhere Python 3 does.
"""
import math
import struct
import sys
import zlib

SIZE = 1024
# macOS icon grid: the shape leaves a margin for the system's shadow.
BODY = 824
RADIUS = 186
DOT_RADIUS = 132
TOP_LEFT = (0xFF, 0x6B, 0x6F)
BOTTOM_RIGHT = (0xE5, 0x48, 0x4D)


def rounded_rect_distance(x: float, y: float) -> float:
    """Signed distance to the body's outline: negative inside."""
    half = BODY / 2
    qx = abs(x - SIZE / 2) - (half - RADIUS)
    qy = abs(y - SIZE / 2) - (half - RADIUS)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - RADIUS


def coverage(distance: float) -> float:
    """Anti-aliased coverage of a pixel whose centre is `distance` from an edge."""
    return min(max(0.5 - distance, 0.0), 1.0)


def pixel(x: int, y: int) -> bytes:
    cx, cy = x + 0.5, y + 0.5
    body = coverage(rounded_rect_distance(cx, cy))
    if body == 0.0:
        return b"\x00\x00\x00\x00"
    # The gradient runs from the top-left corner of the body to the bottom-right one.
    origin = (SIZE - BODY) / 2
    t = min(max(((cx - origin) + (cy - origin)) / (2 * BODY), 0.0), 1.0)
    # A soft highlight at the top gives the flat colour some depth.
    light = 0.10 * max(0.0, 1.0 - (cy - origin) / (BODY * 0.55))
    colour = [a + (b - a) * t for a, b in zip(TOP_LEFT, BOTTOM_RIGHT)]
    colour = [channel + (255 - channel) * light for channel in colour]
    dot = coverage(math.hypot(cx - SIZE / 2, cy - SIZE / 2) - DOT_RADIUS)
    colour = [channel + (255 - channel) * dot for channel in colour]
    return bytes([round(channel) for channel in colour] + [round(body * 255)])


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def main(path: str) -> None:
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            rows += pixel(x, y)
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    with open(path, "wb") as file:
        file.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "build/icon.png")
