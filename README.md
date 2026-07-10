# album-guesser

A static browser game for live play: the audience guesses the album/artist from
progressively revealed clues. Host it on GitHub Pages — no build step, no backend.

## Playing (clue master)

- **Game screen** (share/project this): `index.html?id=<rank>`
  - **Next clue** (or `→`/`Space`) advances through 9 clues:
    pixelated 3×3 → 10×10 → 30×30 → 60×60 → album initials → artist initials → streams → genre → year
  - **Reveal** (top-right, or `R`) shows the full cover, answer, and Spotify links
  - A 30s countdown per clue adds pressure; it never advances anything by itself
  - **Random** jumps to an album not yet played on this device (tracked in
    localStorage; resets automatically once every album has been played)
  - `&clue=N` in the URL restores progress after an accidental refresh
- **Solo play**: type in the guess bar — it autocompletes "Artist – Album".
  A wrong guess costs one of 3 hearts and auto-advances a clue; correct
  guesses reveal with a win banner, 3 wrong guesses end the round.
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
