#!/usr/bin/env python3
"""Report the share of a PNG covered by its single most common colour.

Stdlib only: bench.sh already leans on unzip/file/awk and should not grow an
ImageMagick or Pillow dependency for one number.

A blank render is not "one colour": the black screen that started this carried
the gesture nav pill, so it held two. What separates it from a live screen is
how much of the frame the dominant colour owns.
"""
import sys, zlib, struct


def read_png(path):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a PNG: %s' % path)
    pos, idat, width, height, bitdepth, colortype = 8, [], None, None, None, None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b'IHDR':
            width, height, bitdepth, colortype = struct.unpack('>IIBB', body[:10])
        elif ctype == b'IDAT':
            idat.append(body)
        elif ctype == b'IEND':
            break
        pos += 12 + length
    if bitdepth != 8 or colortype not in (2, 6):
        raise SystemExit('unsupported PNG (bitdepth=%s colortype=%s)' % (bitdepth, colortype))
    return width, height, 3 if colortype == 2 else 4, zlib.decompress(b''.join(idat))


def dominant_share(path, step=4):
    width, height, channels, raw = read_png(path)
    stride = width * channels
    counts, total, prev = {}, 0, bytearray(stride)
    line = 0
    pos = 0
    while pos < len(raw) and line < height:
        filt = raw[pos]
        scan = bytearray(raw[pos + 1:pos + 1 + stride])
        # undo the per-scanline filter; PNG filters reference the pixel to the
        # left (a) and the one above (b)
        for i in range(stride):
            a = scan[i - channels] if i >= channels else 0
            b = prev[i]
            if filt == 1:
                scan[i] = (scan[i] + a) & 0xFF
            elif filt == 2:
                scan[i] = (scan[i] + b) & 0xFF
            elif filt == 3:
                scan[i] = (scan[i] + ((a + b) >> 1)) & 0xFF
            elif filt == 4:
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                scan[i] = (scan[i] + pr) & 0xFF
        if line % step == 0:
            for x in range(0, width, step):
                o = x * channels
                key = (scan[o], scan[o + 1], scan[o + 2])
                counts[key] = counts.get(key, 0) + 1
                total += 1
        prev = scan
        pos += 1 + stride
        line += 1
    if not total:
        raise SystemExit('no pixels sampled')
    return max(counts.values()) / total, total


if __name__ == '__main__':
    share, sampled = dominant_share(sys.argv[1])
    print('%.4f %d' % (share, sampled))
