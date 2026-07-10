const PIXEL_LEVELS = [3, 10, 30, 60];
const CLUE_SECONDS = 30;
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
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
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

function setupJump() {
  const input = document.getElementById("jump-input");
  const go = () => {
    const id = Number.parseInt(input.value, 10);
    if (Number.isFinite(id)) location.search = "?id=" + id;
  };
  document.getElementById("jump-go").addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
    e.stopPropagation();
  });
}

function showMessage(text) {
  document.querySelector("main").innerHTML = `<p class="message"></p>`;
  document.querySelector(".message").textContent = text;
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
    location.search = "?id=" + pool[Math.floor(Math.random() * pool.length)];
  });

  if (id === null) {
    showMessage(
      "Hit Random, or add ?id=<rank> to the URL / use the box above to pick an album."
    );
    return;
  }
  const album = albums.get(id);
  if (!album) {
    showMessage(`No album for id ${id}.`);
    return;
  }

  const stages = [
    ...PIXEL_LEVELS.map((n) => ({ kind: "pixel", n })),
    { kind: "text", label: "Album", value: wordShape(album.album) },
    { kind: "text", label: "Artist", value: wordShape(album.artist) },
    { kind: "text", label: "Streams", value: formatStreams(album.streams) },
    { kind: "text", label: "Genre", value: album.genre },
    { kind: "text", label: "Year", value: album.year },
  ];

  const canvas = document.getElementById("art");
  const clues = document.getElementById("clues");
  const stageLabel = document.getElementById("stage-label");
  const nextBtn = document.getElementById("next");
  const revealBtn = document.getElementById("reveal");
  const guessWrap = document.querySelector(".guess-wrap");

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

  /* Per-clue countdown. Purely informational pressure: it never
     advances or reveals anything on its own. */
  const timerEl = document.getElementById("timer");
  let deadline = 0;
  let timerId = null;

  function tickTimer() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    timerEl.textContent = `0:${String(left).padStart(2, "0")}`;
    timerEl.classList.toggle("low", left > 0 && left <= 5);
    timerEl.classList.toggle("expired", left === 0);
  }

  function resetTimer() {
    deadline = Date.now() + CLUE_SECONDS * 1000;
    if (timerId === null) timerId = setInterval(tickTimer, 200);
    tickTimer();
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
    timerEl.remove();
  }

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
    resetTimer();
  }

  function next() {
    if (revealed || stage >= stages.length - 1) return;
    stage += 1;
    applyStage();
  }

  function reveal(outcome) {
    if (revealed) return;
    revealed = true;
    stopTimer();
    markPlayed(id);
    canvas.replaceWith(img);
    if (outcome) {
      const banner = document.querySelector(".result-banner");
      banner.textContent = outcome === "won" ? "🎉 Correct!" : "❌ Out of guesses";
      banner.classList.toggle("lost", outcome === "lost");
      banner.style.display = "block";
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
    document.getElementById("answer").style.display = "block";
    clues.remove();
    guessWrap.remove();
    nextBtn.remove();
    revealBtn.remove();
    stageLabel.textContent = "Revealed";
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

  function submitGuess() {
    if (revealed || !guessInput.value.trim()) return;
    if (normalize(guessInput.value) === answerKey) {
      closeSuggestions();
      reveal(true);
      return;
    }
    closeSuggestions();
    guessInput.classList.remove("wrong");
    void guessInput.offsetWidth; // restart the shake animation
    guessInput.classList.add("wrong");
    guessInput.select();
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
  revealBtn.addEventListener("click", reveal);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
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
}

const page = document.body.dataset.page;
(page === "answer" ? initAnswer() : initGame()).catch((err) => {
  showMessage("Error: " + err.message);
});
