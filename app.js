const PIXEL_LEVELS = [3, 10, 30, 60];

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
// punctuation stays visible ("AT.LONG.LAST.A$AP" -> "A_._____.____._$__").
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

function webImagePath(imageFile) {
  const name = imageFile.split("/").pop();
  return "album_art_web/" + encodeURIComponent(name);
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

  document.getElementById("random").addEventListener("click", () => {
    const ranks = [...albums.keys()];
    let pick;
    do {
      pick = ranks[Math.floor(Math.random() * ranks.length)];
    } while (ranks.length > 1 && pick === id);
    location.search = "?id=" + pick;
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
    { kind: "text", label: "Genre", value: album.genre },
    { kind: "text", label: "Year", value: album.year },
  ];

  const canvas = document.getElementById("art");
  const clues = document.getElementById("clues");
  const stageLabel = document.getElementById("stage-label");
  const nextBtn = document.getElementById("next");
  const revealBtn = document.getElementById("reveal");

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
  }

  function next() {
    if (revealed || stage >= stages.length - 1) return;
    stage += 1;
    applyStage();
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    canvas.replaceWith(img);
    document.querySelector(".album-name").textContent = album.album;
    document.querySelector(".artist-name").textContent = album.artist;
    document.querySelector("#answer .meta").textContent =
      `${album.year} · ${album.genre}`;
    document.getElementById("answer").style.display = "block";
    clues.remove();
    nextBtn.remove();
    revealBtn.remove();
    stageLabel.textContent = "Revealed";
  }

  nextBtn.addEventListener("click", next);
  revealBtn.addEventListener("click", reveal);
  document.addEventListener("keydown", (e) => {
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
