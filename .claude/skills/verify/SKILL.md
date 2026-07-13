---
name: verify
description: Build/launch/drive recipe for verifying Album Guesser changes in a real browser.
---

# Verifying Album Guesser

Fully static site — no build step.

## Launch

```bash
python3 -m http.server 8631 &   # serve repo root
```

Game: `http://localhost:8631/index.html?id=1` (rank 1 exists; ranks are 1–219 with gaps).
Answer page: `http://localhost:8631/answer.html?id=1`.

## Drive (headless Chromium)

Use `playwright-core` (npm i in a scratch dir) with the pre-installed browser:

```js
chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] })
```

(The version suffix may change — `ls /opt/pw-browsers/`.)

Wait for `#art:not([hidden])` before interacting; the page keeps `body.booting`
(everything invisible) until the round is fully staged.

## Flows worth driving

- Advance clues: Space / ArrowRight / #next; text clues append to #clues after 4 pixel stages.
- Reveal: `r` key or #reveal; answer swaps in with a FLIP animation (~800ms settle).
- Guess bar: #guess-input + autocomplete #suggestions; wrong real guess costs a heart.
- Live mode: #live-toggle or `l` key; persists in localStorage (`albumGuesserLive`), so it
  survives reload and Random navigation. Hides .site-head + .guess-wrap, art fills height,
  controls in a side rail (≥720px wide viewports).

## Gotchas

- Google Fonts request fails in the sandbox (ERR_CONNECTION_RESET) — pre-existing, ignore.
- Typing in inputs must NOT trigger game shortcuts (r/l/space) — good probe.
- Bare URL (no ?id=) redirects to the album-of-the-day.
