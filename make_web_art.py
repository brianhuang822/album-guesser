#!/usr/bin/env python3
"""
Build album_art_web/ -- the downscaled covers the site actually loads.

album_art/ holds full-resolution art (up to 3000x3000, ~300 MB total), which is
far too heavy to ship to a browser or commit to git. This renders a 1000px
version of every cover referenced by album_data.json, and deletes any file the
data no longer references.

Run it after scrape_album_art.py, whenever album_data.json changes:
    python make_web_art.py
"""

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
SRC = ROOT / "album_art"
DST = ROOT / "album_art_web"
DATA = ROOT / "album_data.json"

MAX_SIZE = 1000   # matches the existing web art; never upscales past the original
QUALITY = 85


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    wanted = {Path(a["image_file"]).name for a in data["albums"]}

    missing = sorted(n for n in wanted if not (SRC / n).exists())
    if missing:
        sys.exit(f"ABORT: {len(missing)} covers missing from {SRC.name}/: {missing[:3]}")

    DST.mkdir(exist_ok=True)
    built = skipped = 0

    for name in sorted(wanted):
        src, dst = SRC / name, DST / name
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            continue
        with Image.open(src) as img:
            img = img.convert("RGB")
            if max(img.size) > MAX_SIZE:
                img.thumbnail((MAX_SIZE, MAX_SIZE), Image.LANCZOS)
            img.save(dst, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        built += 1

    stale = [p for p in DST.iterdir() if p.name not in wanted]
    for p in stale:
        p.unlink()

    total = sum(p.stat().st_size for p in DST.iterdir())
    print(f"built {built}, reused {skipped}, removed {len(stale)} stale")
    print(f"{len(list(DST.iterdir()))} covers, {total / 1e6:.0f} MB in {DST.name}/")


if __name__ == "__main__":
    main()
