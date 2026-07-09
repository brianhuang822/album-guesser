"""Create web-sized copies of album art for the game site.

Reads image paths from album_data.json, resizes each to at most MAX_SIDE px
on the longest side, and writes JPEGs to album_art_web/ with the same
basename. Run once (and again whenever album_data.json gains new albums).
"""

import json
from pathlib import Path

from PIL import Image

MAX_SIDE = 1000
QUALITY = 85

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "album_art_web"


def main():
    data = json.loads((ROOT / "album_data.json").read_text())
    files = sorted({a["image_file"] for a in data["albums"]})
    OUT_DIR.mkdir(exist_ok=True)

    done = skipped = 0
    for rel in files:
        src = ROOT / rel
        dst = OUT_DIR / Path(rel).name
        if not src.exists():
            print(f"MISSING: {rel}")
            continue
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            continue
        img = Image.open(src).convert("RGB")
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        img.save(dst, "JPEG", quality=QUALITY, optimize=True)
        done += 1

    print(f"resized {done}, up-to-date {skipped}, total {len(files)}")


if __name__ == "__main__":
    main()
