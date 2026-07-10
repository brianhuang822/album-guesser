# album-guesser

**Play it now: https://brianhuang822.github.io/album-guesser**

A static browser game for live play: the audience guesses the album/artist from
progressively revealed clues. Host it on GitHub Pages — no build step, no backend.

## Playing (clue master)

- **Album of the day**: opening the bare URL (no `?id=`) deterministically
  picks the same album for everyone that day, Wordle-style
- **Game screen** (share/project this): `index.html?id=<rank>`
  - **Next clue** (or `→`/`Space`) advances through 9 clues:
    pixelated 3×3 → 10×10 → 30×30 → 60×60 → album initials → artist initials → streams → genre → year
  - **Reveal** (top-right, or `R`) shows the full cover, answer, and Spotify links
  - A countdown per clue (default 10s, adjustable in the top-left box)
    auto-advances to the next clue when it reaches zero
  - **Random** jumps to an album not yet played on this device (tracked in
    localStorage; resets automatically once every album has been played)
  - `&clue=N` in the URL restores progress after an accidental refresh
- **Solo play**: type in the guess bar — it autocompletes "Artist – Album".
  A wrong guess costs one of 3 hearts and auto-advances a clue; correct
  guesses reveal with a win banner, 3 wrong guesses end the round.
  **Share result** copies a Wordle-style emoji summary to the clipboard.
- **Answer screen** (private, e.g. on your phone): `answer.html?id=<rank>`
  shows the full answer, cover, and the exact clue strings for that rank

The rank input in the top-right corner of either page jumps to any album.

## Data pipeline

- `scrape_album_art.py` builds `album_data.json` and downloads full-res covers
  into `album_art/` (gitignored)
- `resize_images.py` creates the web-sized copies in `album_art_web/` that the
  site serves — re-run it whenever `album_data.json` gains new albums:

```bash
pip install -r requirements.txt
python resize_images.py
```
