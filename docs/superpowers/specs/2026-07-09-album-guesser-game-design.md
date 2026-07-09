# Album Guesser — Live Clue Game (Design)

Date: 2026-07-09
Status: Approved

## Overview

A fully static browser game for GitHub Pages. A clue master (the user) screen-shares
one page to a live audience and progressively reveals clues about an album from
`album_data.json` (163 albums, ranks 1–219, unique). The clue master looks up answers
privately on a second page.

## Files

```
index.html          # player-facing game screen
answer.html         # clue-master private lookup
app.js              # shared logic (data load, initials, pixelation)
style.css           # dark game-show styling
album_data.json     # existing data, loaded via fetch
album_art_web/      # ~1000px JPEG copies, committed & served
resize_images.py    # one-time: album_art/ -> album_art_web/
```

Full-res `album_art/` stays gitignored; only web copies are deployed.

## Game screen — `index.html?id=<rank>`

- Dark background, large centered square artwork (~70vmin), big clue text below.
- 8 clue stages advanced by a **Next clue** button (also `→`/`Space`):
  1. Pixelated 3×3
  2. Pixelated 10×10
  3. Pixelated 30×30
  4. Pixelated 60×60 (fine detail, printed text unreadable)
  5. Album initials + word shape (e.g. `T___ C___`)
  6. Artist initials + word shape (e.g. `P___ M_____`)
  7. Genre
  8. Year
- Text clues stack under the image as labeled lines and stay visible.
- **Reveal** button (also `R`), always available for early correct guesses:
  swaps in the full web-res cover and shows artist, album, year in large text.
- Corner controls: rank number input + Go, stage indicator (`Clue 3/8`).
- Pixelation: draw image to an offscreen N×N canvas (downscale averages each
  cell), upscale to display canvas with `imageSmoothingEnabled = false`.
  Only the canvas is in the DOM pre-reveal; the full image is never shown early.

### Initials + word shape rule

Split the name on whitespace. Per word: show the first character; every later
alphanumeric becomes `_`; punctuation/symbols stay visible.
Examples: `Views` → `V____`; `21` → `2_`; `AT.LONG.LAST.A$AP` → `A_._____.__ ...`
(dots and `$` remain); `$uicideboy$` → `$_________$`.

## Answer screen — `answer.html?id=<rank>`

Full cover, artist, album, year, genre, plus the exact initials strings the game
screen will show. Rank input + prev/next rank links (in rank order, skipping gaps).

## Data & edge cases

- Both pages `fetch('album_data.json')`, index albums by `rank`.
- Web image path derived from `image_file` (`album_art/X.jpg` → `album_art_web/X.jpg`),
  with each path segment `encodeURIComponent`-ed (filenames contain `&`, `$`, `'`, parens).
- Invalid/missing rank → friendly "No album for id N" message.
- `resize_images.py` (Pillow): longest side → 1000px, JPEG quality 85, RGB convert.

## Non-goals

No scoring, no timer, no backend, no build step, no framework.

## Testing

Manual smoke test via `python3 -m http.server`: several ranks including awkward
names (`$uicideboy$`, `AT.LONG.LAST.A$AP`, `21`), every clue stage, reveal,
early reveal, invalid ids.
