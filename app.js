const PIXEL_LEVELS = [3, 10, 30, 60];
const DEFAULT_CLUE_SECONDS = 10;
const MAX_WRONG_GUESSES = 3;
const PLAYED_KEY = "albumGuesserPlayed";

const SPOTIFY_ICON =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

async function loadAlbums() {
  const res = await fetch("album_data.json");
  if (!res.ok) throw new Error(`failed to load album_data.json: ${res.status}`);
  const data = await res.json();
  const byRank = new Map();
  for (const album of data.albums) byRank.set(album.rank, album);
  return byRank;
}

function currentId() {
  const raw = new URLSearchParams(location.search).get("id");
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

// "Take Care" -> "T___ C___"; digits blank too ("21" -> "2_");
// punctuation stays visible ("AT.LONG.LAST.A$AP" -> "A_.____.____._$__").
function wordShape(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      [...word]
        .map((ch, i) => (i === 0 ? ch : /[\p{L}\p{N}]/u.test(ch) ? "_" : ch))
        .join("")
    )
    .join(" ");
}

// Case-, accent-, dash- and whitespace-insensitive comparison key.
// Applied to both the options and the typed guess, so plain ASCII can
// match fancy names: "jack u" → Jack Ü, "asap" → A$AP, "divide" → ÷,
// "ones" → One’s.
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/÷/g, "divide")
    .replace(/\$/g, "s")
    .replace(/['’‘]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatStreams(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return Math.round(n / 1e6) + "M";
  return Number(n).toLocaleString();
}

function getPlayed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PLAYED_KEY)) || []);
  } catch {
    return new Set();
  }
}

function markPlayed(rank) {
  const played = getPlayed();
  played.add(rank);
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify([...played]));
  } catch {
    /* storage unavailable — no-repeat Random just degrades gracefully */
  }
}

function webImagePath(imageFile) {
  const name = imageFile.split("/").pop();
  return "album_art_web/" + encodeURIComponent(name);
}

function spotifyLink(kind, id, label) {
  const a = document.createElement("a");
  a.className = "spotify-btn";
  a.href = `https://open.spotify.com/${kind}/${id}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.innerHTML = SPOTIFY_ICON;
  a.append(label);
  return a;
}

// Blank the current round, let the blank frame actually paint (the
// browser keeps showing the last painted frame during navigation, and
// it must not contain the answer), then leave.
function blankAndGo(action) {
  document.body.classList.add("leaving");
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(action, 0)));
}

function navigate(query) {
  blankAndGo(() => (location.search = query));
}

// Keyboard refresh goes through the same blank-first path.
document.addEventListener("keydown", (e) => {
  if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    blankAndGo(() => location.reload());
  }
});

// Last resort for reloads we can't intercept (toolbar button).
window.addEventListener("beforeunload", () => {
  document.body.classList.add("leaving");
});

function ready() {
  document.body.classList.remove("booting");
}

function setupJump() {
  const input = document.getElementById("jump-input");
  const go = () => {
    const id = Number.parseInt(input.value, 10);
    if (Number.isFinite(id)) navigate("?id=" + id);
  };
  document.getElementById("jump-go").addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
    e.stopPropagation();
  });
}

function showMessage(text) {
  const main = document.querySelector("main");
  const nav = main.querySelector(".nav-bar");
  main.replaceChildren(...(nav ? [nav] : []));
  const p = document.createElement("p");
  p.className = "message";
  p.textContent = text;
  main.append(p);
  ready();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // Deliberately vague: this can appear on the shared screen, and the
    // image URL contains the artist and album name.
    img.onerror = () =>
      reject(new Error("couldn't load the cover image (run resize_images.py and redeploy?)"));
    img.src = src;
  });
}

/* ---------- game page ---------- */

async function initGame() {
  setupJump();
  const id = currentId();
  const albums = await loadAlbums();

  // Random avoids albums already revealed on this device; once every
  // album has been played, the history resets and the cycle starts over.
  document.getElementById("random").addEventListener("click", () => {
    const ranks = [...albums.keys()];
    const played = getPlayed();
    let pool = ranks.filter((r) => r !== id && !played.has(r));
    if (pool.length === 0) {
      localStorage.removeItem(PLAYED_KEY);
      pool = ranks.filter((r) => r !== id);
    }
    if (pool.length === 0) return;
    navigate("?id=" + pool[Math.floor(Math.random() * pool.length)]);
  });

  if (id === null) {
    // No id: play the album of the day. Hash of the local date, so
    // everyone visiting the bare URL gets the same album (Wordle-style).
    const d = new Date();
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let h = 2166136261;
    for (const ch of key) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    const ranks = [...albums.keys()].sort((a, b) => a - b);
    document.body.classList.add("leaving");
    location.replace("?id=" + ranks[(h >>> 0) % ranks.length]);
    return;
  }
  const album = albums.get(id);
  if (!album) {
    showMessage(`No album for id ${id}.`);
    return;
  }

  const stages = [
    ...PIXEL_LEVELS.map((n) => ({ kind: "pixel", n })),
    { kind: "text", label: "Streams", value: formatStreams(album.streams) },
    { kind: "text", label: "Year", value: album.year },
    { kind: "text", label: "Genre", value: album.genre },
    { kind: "text", label: "Album", value: wordShape(album.album) },
    { kind: "text", label: "Artist", value: wordShape(album.artist) },
  ];

  const canvas = document.getElementById("art");
  const clues = document.getElementById("clues");
  const stageLabel = document.getElementById("stage-label");
  const nextBtn = document.getElementById("next");
  const revealBtn = document.getElementById("reveal");
  const controlsRow = document.querySelector(".controls");
  const revealRow = document.querySelector(".reveal-row");
  const frame = document.querySelector(".art-frame");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // One cell per clue, mirroring the emoji share grid.
  const progressEl = document.getElementById("progress");
  const cells = stages.map(() => {
    const c = document.createElement("span");
    c.className = "cell";
    progressEl.append(c);
    return c;
  });

  const img = await loadImage(webImagePath(album.image_file));
  document.getElementById("loading").remove();
  canvas.hidden = false;

  const SIZE = 960;
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  function drawPixelated(n) {
    const off = document.createElement("canvas");
    off.width = n;
    off.height = n;
    // Downscaling to n x n averages each cell's colour.
    off.getContext("2d").drawImage(img, 0, 0, n, n);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(off, 0, 0, SIZE, SIZE);
  }

  let stage = 0; // index of the latest visible stage
  let revealed = false;

  /* Per-clue countdown. When it hits zero it advances to the next clue
     and restarts; on the final clue it just stops. The seconds-per-clue
     box beside it applies immediately. */
  const timerEl = document.getElementById("timer");
  const timerInput = document.getElementById("timer-secs");
  const pauseBtn = document.getElementById("timer-pause");
  let clueSeconds = DEFAULT_CLUE_SECONDS;
  let deadline = 0;
  let timerId = null;
  let paused = false;
  let remainingMs = 0; // frozen time while paused

  function renderTime(left) {
    timerEl.textContent = `0:${String(left).padStart(2, "0")}`;
    timerEl.classList.toggle("low", left > 0 && left <= 5);
    timerEl.classList.toggle("expired", left === 0);
  }

  function tickTimer() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    renderTime(left);
    if (left === 0) {
      if (stage < stages.length - 1) {
        next(); // applyStage restarts the countdown
      } else {
        clearInterval(timerId);
        timerId = null;
      }
    }
  }

  function resetTimer() {
    if (paused) {
      remainingMs = clueSeconds * 1000;
      renderTime(clueSeconds);
      return;
    }
    deadline = Date.now() + clueSeconds * 1000;
    if (timerId === null) timerId = setInterval(tickTimer, 200);
    tickTimer();
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
    timerEl.remove();
    timerInput.remove();
    pauseBtn.remove();
  }

  timerInput.addEventListener("input", () => {
    const v = Number.parseInt(timerInput.value, 10);
    if (Number.isFinite(v) && v >= 3) {
      clueSeconds = v;
      resetTimer();
    }
  });

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "▶" : "⏸";
    pauseBtn.title = paused ? "Resume auto-advance" : "Pause auto-advance";
    timerEl.classList.toggle("paused", paused);
    if (paused) {
      remainingMs = Math.max(0, deadline - Date.now());
      clearInterval(timerId);
      timerId = null;
    } else {
      deadline = Date.now() + remainingMs;
      timerId = setInterval(tickTimer, 200);
      tickTimer();
    }
  });

  function applyStage() {
    const s = stages[stage];
    if (s.kind === "pixel") {
      drawPixelated(s.n);
    } else {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = s.label;
      li.append(label, String(s.value));
      clues.append(li);
    }
    stageLabel.textContent = `Clue ${stage + 1}/${stages.length}`;
    nextBtn.disabled = stage >= stages.length - 1;
    cells.forEach((c, i) => c.classList.toggle("seen", i <= stage));
    resetTimer();
  }

  function next() {
    if (revealed || stage >= stages.length - 1) return;
    stage += 1;
    applyStage();
  }

  // Sharpen the cover in place: blend the full image over the current
  // pixelated frame instead of swapping DOM nodes.
  function sharpenCover(duration) {
    ctx.imageSmoothingEnabled = true;
    if (duration <= 0) {
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      return;
    }
    const start = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - start) / duration);
      ctx.globalAlpha = p;
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      ctx.globalAlpha = 1;
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }

  function reveal(outcome) {
    if (revealed) return;
    revealed = true;
    stopTimer();
    markPlayed(id);
    if (outcome) {
      const banner = document.querySelector(".result-banner");
      banner.textContent = outcome === "won" ? "🎉 Correct!" : "❌ Out of guesses";
      banner.classList.toggle("lost", outcome === "lost");
      banner.style.display = "block";
      cells[stage].classList.add(outcome === "won" ? "won" : "lost");
    }
    document.querySelector(".album-name").textContent = album.album;
    document.querySelector(".artist-name").textContent = album.artist;
    document.querySelector("#answer .meta").textContent =
      `${album.year} · ${album.genre}`;
    const spotifyRow = document.querySelector(".spotify-row");
    if (album.spotify_album_id)
      spotifyRow.append(spotifyLink("album", album.spotify_album_id, "Album"));
    if (album.spotify_artist_id)
      spotifyRow.append(spotifyLink("artist", album.spotify_artist_id, "Artist"));
    if (outcome) addShareButton(outcome);
    stageLabel.textContent = "Revealed";

    const answerEl = document.getElementById("answer");
    const leaving = [clues, controlsRow, revealRow];

    // Swap guessing UI for the answer, FLIP-animating the art so the
    // relayout glides instead of jumping.
    const finish = () => {
      const before = frame.getBoundingClientRect();
      leaving.forEach((el) => el.remove());
      answerEl.style.display = "block";
      if (reduceMotion) return;
      const after = frame.getBoundingClientRect();
      if (Math.abs(before.width - after.width) > 1 || Math.abs(before.top - after.top) > 1) {
        frame.style.transformOrigin = "center top";
        frame.style.transform =
          `translateY(${before.top - after.top}px) scale(${before.width / after.width})`;
        requestAnimationFrame(() => {
          frame.style.transition = "transform 0.35s ease";
          frame.style.transform = "";
          setTimeout(() => (frame.style.transition = ""), 420);
        });
      }
      answerEl.classList.add("enter");
      requestAnimationFrame(() => answerEl.classList.add("in"));
    };

    sharpenCover(reduceMotion ? 0 : 500);
    if (reduceMotion) {
      finish();
    } else {
      leaving.forEach((el) => el.classList.add("fade-out"));
      setTimeout(finish, 250);
    }
  }

  /* Wordle-style shareable summary: one square per clue (🟨 seen,
     🟩/🟥 the clue it ended on, ⬜ never needed) plus hearts. */
  function shareText(outcome) {
    const grid = stages
      .map((_, i) => {
        if (i === stage) return outcome === "won" ? "🟩" : "🟥";
        return i < stage ? "🟨" : "⬜";
      })
      .join("");
    const hearts =
      "❤️".repeat(livesLeft) + "🖤".repeat(MAX_WRONG_GUESSES - livesLeft);
    const url = location.origin + location.pathname + "?id=" + id;
    return [
      `Album Guesser #${id} — clue ${stage + 1}/${stages.length}`,
      grid,
      hearts,
      url,
    ].join("\n");
  }

  function addShareButton(outcome) {
    const btn = document.createElement("button");
    btn.id = "share";
    btn.textContent = "Share result";
    btn.addEventListener("click", async () => {
      const text = shareText(outcome);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Share result"), 1500);
    });
    document.querySelector(".share-row").append(btn);
  }

  /* Guess bar with autocomplete over "Artist – Album". */
  const options = [...albums.values()]
    .map((a) => `${a.artist} – ${a.album}`)
    .sort((a, b) => a.localeCompare(b));
  const answerKey = normalize(`${album.artist} – ${album.album}`);
  const guessInput = document.getElementById("guess-input");
  const guessBtn = document.getElementById("guess-go");
  const suggestions = document.getElementById("suggestions");
  const livesEl = document.getElementById("lives");
  let activeIndex = -1;
  let livesLeft = MAX_WRONG_GUESSES;

  function renderLives() {
    livesEl.textContent =
      "♥".repeat(livesLeft) + "♡".repeat(MAX_WRONG_GUESSES - livesLeft);
  }
  renderLives();

  function closeSuggestions() {
    suggestions.hidden = true;
    suggestions.replaceChildren();
    activeIndex = -1;
  }

  function renderSuggestions() {
    const q = normalize(guessInput.value);
    if (!q) return closeSuggestions();
    const matches = options.filter((o) => normalize(o).includes(q)).slice(0, 8);
    if (matches.length === 0) return closeSuggestions();
    suggestions.replaceChildren(
      ...matches.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault(); // keep focus in the input
          guessInput.value = text;
          submitGuess();
        });
        return li;
      })
    );
    suggestions.hidden = false;
    activeIndex = -1;
  }

  function setActive(delta) {
    const items = [...suggestions.children];
    if (items.length === 0) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === activeIndex));
    items[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function shakeInput() {
    guessInput.classList.remove("wrong");
    void guessInput.offsetWidth; // restart the shake animation
    guessInput.classList.add("wrong");
  }

  function submitGuess() {
    if (revealed || !guessInput.value.trim()) return;
    const key = normalize(guessInput.value);
    // A guess must be one of the real options. Exact text counts, and a
    // query narrowed down to a single match auto-completes — no need to
    // click the dropdown.
    let choice = options.find((o) => normalize(o) === key);
    if (!choice) {
      const matches = options.filter((o) => normalize(o).includes(key));
      if (matches.length === 1) choice = matches[0];
    }
    closeSuggestions();
    if (!choice) {
      shakeInput(); // not an album — nudge, never costs a heart
      return;
    }
    guessInput.value = choice;
    if (normalize(choice) === answerKey) {
      reveal("won");
      return;
    }
    // Wrong: lose a life and pay for it with a free clue.
    livesLeft -= 1;
    renderLives();
    if (livesLeft <= 0) {
      reveal("lost");
      return;
    }
    shakeInput();
    guessInput.select();
    next();
  }

  guessInput.addEventListener("input", () => {
    guessInput.classList.remove("wrong");
    renderSuggestions();
  });
  guessInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing must never trigger game shortcuts
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(-1);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) guessInput.value = suggestions.children[activeIndex].textContent;
      submitGuess();
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });
  guessInput.addEventListener("blur", () => setTimeout(closeSuggestions, 150));
  guessBtn.addEventListener("click", submitGuess);

  nextBtn.addEventListener("click", next);
  // No event argument may leak into reveal(outcome) — a MouseEvent is
  // truthy and would show the "Correct!" banner on a manual reveal.
  revealBtn.addEventListener("click", () => reveal());
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.matches("input")) return;
    // Modifier combos are browser chords — Ctrl+R must reload, not reveal.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      next();
    } else if (e.key.toLowerCase() === "r") {
      reveal();
    }
  });

  applyStage();

  // ?clue=N restores progress after an accidental refresh mid-round.
  const clueParam = Number.parseInt(
    new URLSearchParams(location.search).get("clue"),
    10
  );
  if (Number.isFinite(clueParam)) {
    while (stage < Math.min(clueParam, stages.length) - 1) next();
  }

  ready(); // first paint happens only now, with the round fully staged
}

/* ---------- answer page ---------- */

async function initAnswer() {
  setupJump();
  const id = currentId();
  if (id === null) {
    showMessage("Add ?id=<rank> to the URL or use the box above.");
    return;
  }
  const albums = await loadAlbums();
  const album = albums.get(id);
  if (!album) {
    showMessage(`No album for id ${id}.`);
    return;
  }

  document.getElementById("cover").src = webImagePath(album.image_file);
  document.getElementById("album").textContent = `${album.album} (${album.year})`;
  document.getElementById("artist").textContent = album.artist;
  const cells = {
    rank: album.rank,
    genre: album.genre,
    "album clue": wordShape(album.album),
    "artist clue": wordShape(album.artist),
    streams: Number(album.streams).toLocaleString(),
  };
  const table = document.getElementById("details");
  for (const [key, value] of Object.entries(cells)) {
    const row = table.insertRow();
    row.insertCell().textContent = key;
    const cell = row.insertCell();
    cell.textContent = value;
    if (key.endsWith("clue")) cell.className = "mono";
  }

  const spotifyRow = document.querySelector(".spotify-row");
  if (album.spotify_album_id)
    spotifyRow.append(spotifyLink("album", album.spotify_album_id, "Album"));
  if (album.spotify_artist_id)
    spotifyRow.append(spotifyLink("artist", album.spotify_artist_id, "Artist"));

  const ranks = [...albums.keys()].sort((a, b) => a - b);
  const i = ranks.indexOf(id);
  const prev = document.getElementById("prev");
  const next = document.getElementById("next-link");
  if (i > 0) prev.href = "?id=" + ranks[i - 1];
  else prev.remove();
  if (i < ranks.length - 1) next.href = "?id=" + ranks[i + 1];
  else next.remove();
  ready();
}

const page = document.body.dataset.page;
(page === "answer" ? initAnswer() : initGame()).catch((err) => {
  showMessage("Error: " + err.message);
});
