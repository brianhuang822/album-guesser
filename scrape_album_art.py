#!/usr/bin/env python3
"""
Scrape the top N artists from kworb.net/spotify/artists.html, find each artist's
most-streamed studio album, and download high-resolution cover art.

Outputs:
  album_art/<artist>_<album>_<year>.jpg   cover images
  album_data.json                         game data + excluded/failed entries

Data flow:
  1. kworb artists page   -> artist name + spotify artist id
  2. kworb artist albums  -> top album by streams (compilations and live albums skipped)
  3. iTunes Search API    -> artist genre, album catalog, artwork (3000x3000), year

Filtering, for an English-language guessing game:
  * compilations     - kworb marks them with a leading '^'
  * live albums      - title matches LIVE_PATTERNS; falls through to the next album
  * non-English      - artist genre, non-Latin script, or non-English album title

Nothing is silently dropped: excluded albums land in the "excluded" array of
album_data.json with the reason, and misses land in "failures" with a
covers.musichoarders.xyz URL so you can pick a cover by hand.

Re-running is cheap: artists already resolved in album_data.json whose image file
still exists are skipped with no network calls. Use --force to redo everything.

Usage:
    python scrape_album_art.py                 # scan top 300 artists
    python scrape_album_art.py --limit 25      # quick test run
    python scrape_album_art.py --keep-all      # no language/live filtering
    python scrape_album_art.py --force         # ignore cache, re-download
"""

import argparse
import datetime as dt
import difflib
import json
import re
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

# Progress should stream even when stdout is redirected to a file.
sys.stdout.reconfigure(line_buffering=True)

KWORB_ARTISTS = "https://kworb.net/spotify/artists.html"
KWORB_ALBUMS = "https://kworb.net/spotify/artist/{artist_id}_albums.html"
ITUNES_SEARCH = "https://itunes.apple.com/search"
ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
MUSICHOARDERS = "https://covers.musichoarders.xyz/?artist={artist}&album={album}"

# Apple renders on demand; asking beyond the native size returns the native file,
# so 3000x3000 effectively means "the biggest you have".
ART_SIZE = "3000x3000bb"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "album_art"
DATA_JSON = ROOT / "album_data.json"

ARTIST_ID_RE = re.compile(r"/spotify/artist/([A-Za-z0-9]+)_songs\.html")
ALBUM_ID_RE = re.compile(r"open\.spotify\.com/album/([A-Za-z0-9]+)")

EDITION_WORDS = re.compile(
    r"\b(deluxe|expanded|edition|version|remaster(ed)?|explicit|bonus|"
    r"anniversary|special|reissue|remix(es)?)\b"
)

# Applied to the accent-folded title. '\blive\b' also matches an album genuinely
# named e.g. "Live Your Life" -- add such titles to ALWAYS_KEEP_ALBUMS.
LIVE_PATTERNS = re.compile(
    r"(?i)(\blive\b|\bunplugged\b|\bin concert\b|\bconcert\b|\btour\b|\bturne\b|"
    r"\bsetlist\b|\bacoustic session|\bbbc session)"
)

# iTunes primaryGenreName substrings (accent-folded, lowercased) that imply the
# artist records in a language other than English.
NON_ENGLISH_GENRES = {
    "latino", "latin", "k-pop", "j-pop", "c-pop", "mandopop", "cantopop",
    "bollywood", "indian", "mexicana", "regional mexicano", "reggaeton",
    "salsa", "bachata", "merengue", "cumbia", "tango", "flamenco",
    "brazilian", "sertanejo", "mpb", "samba", "bossa", "fado", "chanson",
    "turkish", "arabic", "anime", "world", "worldwide", "french pop", "german pop",
    # added after auditing a full run: Aventura was 'Musica tropical',
    # A.R. Rahman was 'Tamil' -- neither was caught by the original list.
    "tropical", "tamil", "telugu", "hindi", "punjabi", "kannada", "malayalam",
    "marathi", "bhangra", "spanish",
}

# Albums confirmed non-English by MusicBrainz release language and/or a web check.
# Genre and title heuristics cannot catch these: Rammstein is tagged 'Metal',
# ROSALIA and Enrique Iglesias are 'Pop', Marshmello is a US artist whose 'Sugar
# Papi' is a Spanish-language Latin album.
VERIFIED_NON_ENGLISH = {
    ("Bad Bunny", "Un Verano Sin Ti"),
    ("Marshmello", "Sugar Papi"),
    ("Bizarrap", "en dormir sin Madrid - EP"),
    ("A.R. Rahman", "Raanjhanaa"),
    ("ROSALÍA", "MOTOMAMI"),
    ("Becky G", "MALA SANTA"),
    ("Enrique Iglesias", "FINAL (Vol.1)"),
    ("Rammstein", "Mutter"),
    ("Aventura", "The Last"),
    ("Rels B", "Flakk Daniel's Lp"),
    ("Ninho", "Destin"),
    ("Anitta", "Versions of Me"),  # trilingual; majority Spanish/Portuguese
}

# Not the artist's own studio album: soundtracks, scores, greatest-hits sets, EPs.
NON_ALBUM_PATTERNS = re.compile(
    r"(?i)(\bgreatest hits\b|\bplatinum hits\b|\bhits\b|\bvery best\b|\bthe best\b|"
    r"\bessential\b|\banthology\b|\bchronicles\b|\bcollection\b|\bcompilation\b|"
    r"\b-\s*EP\b|\bEP\b|\bsoundtrack\b|original motion picture|original score|"
    r"\bthe musical\b|\bmixtape\b|past, present|"
    # Box sets. Narrow on purpose: a bare '\bcomplete\b' would also strike
    # Justin Bieber's 'Justice (The Complete Edition)', which is a real album.
    r"\bbox set\b|\bcomplete\b[^,]{0,30}\brecordings\b)"
)
NON_ALBUM_GENRES = {"soundtrack"}
MIN_TRACKS = 7  # below this it's an EP, not an album

# Seasonal records. Excluded from the game even though they are real studio albums:
# for Elvis and Sinatra a Christmas side-release out-streams their actual catalog.
# 'holiday' and 'santa' are only safe as genres -- an album could be named either.
SEASONAL_TITLE = re.compile(r"(?i)\b(christmas|xmas|noel|yuletide)\b")
SEASONAL_GENRE = re.compile(r"(?i)\b(christmas|holiday)\b")

# Function words. Two or more in one title is a strong non-English signal, and
# they're rare enough in English titles to be safe. (Shakira's "Las Mujeres Ya No
# Lloran" is genre-tagged Pop, so genre alone would miss it.)
NON_ENGLISH_WORDS = {
    "el", "la", "los", "las", "un", "una", "unos", "sin", "ti", "de", "del", "y",
    "que", "no", "mi", "mas", "por", "para", "con", "como", "yo", "tu", "su", "se",
    "es", "son", "ya", "al", "lo", "le", "les", "nos", "muy", "en",
    "eu", "um", "uma", "nao", "meu", "mais",
    "je", "suis", "des", "une", "et", "est",
    "der", "die", "das", "und", "ich",
    "il", "gli", "che", "di",
}

# Escape hatches for the heuristics above. Artist names, exact as kworb spells them.
ALWAYS_EXCLUDE_ARTISTS = set()

# Verified English-language despite tripping a heuristic:
#   Skrillex  - 'Jack Ü' trips the diacritic rule; he records in English
#   Sean Paul - MusicBrainz tags one release of 'Mad Love' as Spanish; it is English
#   Zedd      - German artist, English albums (country is not language)
ALWAYS_KEEP_ARTISTS = {"Skrillex", "Sean Paul", "Zedd"}
ALWAYS_KEEP_ALBUMS = set()  # album titles wrongly caught by LIVE_PATTERNS

# Minimum title similarity before an iTunes album is accepted. Below this we report
# a miss rather than silently saving the wrong cover under the right name.
MATCH_FLOOR = 0.75


class Throttled(Exception):
    """iTunes returned an empty body -- its rate limiter, not a real 'no result'."""


def fold(text):
    """Strip accents: 'MAÑANA SERÁ' -> 'MANANA SERA'."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def normalize(text):
    """
    Fold case, accents, bracketed suffixes and edition words for title comparison.

    Titles made entirely of symbols or non-Latin script (Ed Sheeran's '÷', '×', '+')
    survive accent-folding as an empty string, which would score 0.0 against every
    candidate. When that happens, keep the symbols and compare those instead.
    """
    stripped = re.sub(r"[\(\[].*?[\)\]]", " ", text.lower())
    stripped = EDITION_WORDS.sub(" ", stripped)

    ascii_key = " ".join(re.sub(r"[^a-z0-9]+", " ", fold(stripped).lower()).split())
    if ascii_key:
        return ascii_key
    return " ".join(stripped.split())


def sanitize(name):
    """Make a string safe as a filename on Windows and POSIX."""
    name = re.sub(r'[<>:"/\\|?*]', "", name.strip())
    name = re.sub(r"[\s_]+", "_", name)
    return name.strip("._")[:80] or "unknown"


def is_live(title):
    return bool(LIVE_PATTERNS.search(fold(title))) and title not in ALWAYS_KEEP_ALBUMS


def non_latin_script(text):
    """Return the script name of the first non-Latin letter, else None."""
    for char in text:
        if char.isalpha():
            name = unicodedata.name(char, "")
            if not name.startswith("LATIN"):
                return name.split()[0].title()
    return None


def has_diacritic(text):
    return any(unicodedata.combining(c) for c in unicodedata.normalize("NFD", text))


def non_english_reason(artist, album, genre):
    """
    Return a reason string if this looks non-English, else None.

    Checked against the real top 60: catches all 15 non-English artists (11 Urbano
    latino, K-Pop, Bollywood, Musica Mexicana, plus Shakira via title words) with no
    false positives. Note the diacritic check reads the *album* title only -- the
    artist 'Beyoncé' must survive.
    """
    if artist in ALWAYS_KEEP_ARTISTS:
        return None
    if artist in ALWAYS_EXCLUDE_ARTISTS:
        return "manual"

    album_key = normalize(album)
    for known_artist, known_album in VERIFIED_NON_ENGLISH:
        if artist == known_artist and normalize(known_album) == album_key:
            return "verified non-English"

    folded_genre = fold(genre or "").lower()
    for token in NON_ENGLISH_GENRES:
        if token in folded_genre:
            return f"genre: {genre}"

    script = non_latin_script(artist) or non_latin_script(album)
    if script:
        return f"script: {script}"

    words = re.findall(r"[a-z]+", fold(album).lower())
    hits = [w for w in words if w in NON_ENGLISH_WORDS]
    if len(hits) >= 2:
        return f"title words: {', '.join(hits[:3])}"

    if has_diacritic(album):
        return "title diacritics"
    return None


def non_album_reason(title, genre, track_count):
    """
    Reject soundtracks, scores, greatest-hits sets, EPs and Christmas albums.

    Checked against a full run: catches Queen's 'Bohemian Rhapsody' soundtrack,
    Jason Derulo's 'Platinum Hits', Michael Jackson's 'HIStory', The Chainsmokers'
    'Collage - EP', and Beyonce's 3-track 'Sasha Fierce (The Bonus Tracks) - EP'.
    """
    if title in ALWAYS_KEEP_ALBUMS:
        return None
    if fold(genre or "").lower() in NON_ALBUM_GENRES:
        return f"genre: {genre}"
    if SEASONAL_TITLE.search(title) or SEASONAL_GENRE.search(genre or ""):
        return "christmas album"
    match = NON_ALBUM_PATTERNS.search(fold(title))
    if match:
        return f"title: {match.group(0)}"
    if track_count is not None and track_count < MIN_TRACKS:
        return f"only {track_count} tracks"
    return None


def fetch_html(session, url):
    """kworb serves 'text/html' with no charset, so requests guesses ISO-8859-1 and
    mangles every accented name. Force UTF-8, which is what the page actually is."""
    resp = session.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    return BeautifulSoup(resp.text, "html.parser")


# --------------------------------------------------------------------------
# kworb
# --------------------------------------------------------------------------

def kworb_top_artists(session, limit):
    """Return [(rank, artist_name, spotify_artist_id), ...] for the top `limit`."""
    table = fetch_html(session, KWORB_ARTISTS).find("table", class_="sortable")
    if table is None:
        raise RuntimeError("kworb artists table not found -- page layout changed?")

    artists = []
    for row in table.tbody.find_all("tr"):
        link = row.find("td", class_="text").find("a")
        match = ARTIST_ID_RE.search(link["href"])
        if not match:
            continue
        artists.append((len(artists) + 1, link.get_text(strip=True), match.group(1)))
        if len(artists) >= limit:
            break
    return artists


def kworb_albums(session, artist_id, skip_live=True):
    """
    Return [(title, spotify_album_id, streams), ...] highest-streamed first.

    kworb prefixes compilations and 'appears on' releases with a bare '^' text node
    in the title cell -- Justin Bieber's top row is the compilation 'The Best'.
    Live releases aren't marked at all, so they're matched by title; both Ed Sheeran
    and Dua Lipa have a live album on top. The caller walks this list so a rejected
    album falls through to the next one instead of dropping the artist.
    """
    table = fetch_html(session, KWORB_ALBUMS.format(artist_id=artist_id)).find(
        "table", class_="sortable")
    if table is None or table.tbody is None:
        return []

    candidates = []
    for row in table.tbody.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        div = cells[0].find("div")
        link = div.find("a") if div else None
        if not link:
            continue
        album_id = ALBUM_ID_RE.search(link.get("href", ""))
        if not album_id:
            continue
        if div.get_text(" ", strip=True).startswith("^"):  # compilation
            continue
        title = link.get_text(strip=True)
        if skip_live and is_live(title):
            continue
        try:
            streams = float(cells[1].get_text(strip=True).replace(",", ""))
        except ValueError:
            continue
        candidates.append((title, album_id.group(1), streams))

    return sorted(candidates, key=lambda c: -c[2])


# --------------------------------------------------------------------------
# iTunes
# --------------------------------------------------------------------------

def itunes_get(session, url, params, delay, attempts=5):
    """
    GET with retry. iTunes rate-limits (~20 req/min) by returning HTTP 200 with an
    empty body, so an empty body must be retried, not parsed as JSON or read as
    'no results'.
    """
    for attempt in range(attempts):
        resp = session.get(url, headers=HEADERS, params=params, timeout=30)
        if resp.status_code == 200 and resp.text.strip():
            return resp.json()
        time.sleep(delay * (attempt + 1))
    raise Throttled(f"no response after {attempts} attempts")


def itunes_artist(session, artist, delay):
    """Return (artist_id, primary_genre). The genre drives the language filter."""
    data = itunes_get(session, ITUNES_SEARCH,
                      {"term": artist, "entity": "musicArtist", "limit": 5}, delay)
    results = data.get("results", [])
    target = normalize(artist)
    for result in results:
        if normalize(result.get("artistName", "")) == target:
            return result["artistId"], result.get("primaryGenreName")
    if results:
        return results[0]["artistId"], results[0].get("primaryGenreName")
    return None, None


def itunes_catalog(session, artist_id, delay):
    """
    The artist's whole album catalog, fetched once so candidates can be matched
    locally. Searching iTunes by album title is unreliable -- 'Un Verano Sin Ti'
    returns only cover-song singles by unrelated artists.
    """
    data = itunes_get(session, ITUNES_LOOKUP,
                      {"id": artist_id, "entity": "album", "limit": 200}, delay)
    return [i for i in data.get("results", []) if i.get("wrapperType") == "collection"]


def match_album(catalog, album):
    """Closest catalog entry to `album`, or (None, best_score) below MATCH_FLOOR."""
    target = normalize(album)
    best = None
    for item in catalog:
        title = normalize(item.get("collectionName", ""))
        if not title:
            continue
        score = difflib.SequenceMatcher(None, target, title).ratio()
        if title == target:
            score += 1.0  # exact normalized match beats any fuzzy one
        # Ties go to the release with more tracks, so the real album wins over a
        # bonus-track EP that normalizes to the same title (Beyonce's Sasha Fierce).
        key = (score, item.get("trackCount") or 0)
        if best is None or key > best[0]:
            best = (key, item)

    if best is None or best[0][0] < MATCH_FLOOR:
        return None, (best[0][0] if best else 0.0)
    return best[1], best[0][0]


def artwork_url(item):
    url = item.get("artworkUrl100") or item.get("artworkUrl60")
    return url.replace("100x100bb", ART_SIZE).replace("60x60bb", ART_SIZE) if url else None


# --------------------------------------------------------------------------
# persistence
# --------------------------------------------------------------------------

def load_cache():
    """Map spotify artist id -> previous record, so reruns skip network calls."""
    if not DATA_JSON.exists():
        return {}, {}
    try:
        data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}, {}
    albums = {a["spotify_artist_id"]: a for a in data.get("albums", [])}
    excluded = {e["spotify_artist_id"]: e for e in data.get("excluded", [])}
    return albums, excluded


def write_json(albums, excluded, failures):
    albums.sort(key=lambda a: a["rank"])
    DATA_JSON.write_text(json.dumps({
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "kworb.net (rankings) + iTunes Search API (artwork)",
        "count": len(albums),
        "albums": albums,
        "excluded": sorted(excluded, key=lambda e: e["rank"]),
        "failures": failures,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=300,
                        help="how many artists to scan (default 300; fewer survive filtering)")
    parser.add_argument("--delay", type=float, default=3.0,
                        help="seconds between iTunes calls; below ~3 you get throttled")
    parser.add_argument("--force", action="store_true", help="ignore cache, re-download art")
    parser.add_argument("--keep-all", action="store_true",
                        help="disable the live-album and non-English filters")
    args = parser.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    session = requests.Session()
    cached_albums, cached_excluded = ({}, {}) if args.force else load_cache()

    print(f"Scanning top {args.limit} artists from kworb...")
    artists = kworb_top_artists(session, args.limit)
    print(f"Found {len(artists)} artists "
          f"({len(cached_albums)} cached, {len(cached_excluded)} previously excluded).\n")

    albums, excluded, failures = [], [], []

    for rank, artist, spotify_artist_id in artists:
        # A cached record must still satisfy the current filters. Reusing it blindly
        # means a filter added later never applies to anyone already cached -- which
        # is how a pre-filter album_data.json kept Bad Bunny and Rammstein in the game.
        previous = cached_albums.get(spotify_artist_id)
        if previous and (OUT_DIR / Path(previous["image_file"]).name).exists():
            stale = None
            if not args.keep_all:
                stale = (non_english_reason(artist, previous["album"],
                                            previous.get("artist_genre"))
                         or non_album_reason(previous["album"], previous["genre"],
                                             previous.get("track_count"))
                         or (is_live(previous["album"]) and "live album" or None))
            if not stale:
                previous["rank"] = rank  # rankings shift between runs
                albums.append(previous)
                print(f"[{rank:3}] cached {previous['image_file']}")
                continue
            print(f"[{rank:3}] drop   {artist} - cached entry now fails filter ({stale})")

        skipped = cached_excluded.get(spotify_artist_id)
        if skipped and not args.keep_all:
            skipped["rank"] = rank
            excluded.append(skipped)
            print(f"[{rank:3}] skip   {artist} ({skipped['reason']})")
            continue

        album_title = ""
        try:
            candidates = kworb_albums(session, spotify_artist_id, skip_live=not args.keep_all)
            if not candidates:
                raise ValueError("no eligible albums on kworb")
            time.sleep(0.5)

            artist_id, genre = itunes_artist(session, artist, args.delay)
            if not artist_id:
                raise ValueError("artist not found on iTunes")
            time.sleep(args.delay)

            catalog = itunes_catalog(session, artist_id, args.delay)

            # Walk the artist's albums by streams until one survives every filter.
            item = score = None
            album_title = spotify_album_id = streams = None
            reject = "no eligible albums"
            # Michael Buble's seven highest-streamed albums are all Christmas
            # records, so the window has to be deep enough to reach a real one.
            for cand_title, cand_id, cand_streams in candidates[:15]:
                if not args.keep_all:
                    reason = non_english_reason(artist, cand_title, genre)
                    if reason:
                        reject = reason
                        break  # language is a property of the artist: stop trying
                found, found_score = match_album(catalog, cand_title)
                if found is None:
                    reject = f"no album match (best score {found_score:.2f})"
                    continue
                if not args.keep_all:
                    reason = non_album_reason(found["collectionName"],
                                              found.get("primaryGenreName"),
                                              found.get("trackCount"))
                    if reason:
                        reject = f"not an album ({reason})"
                        continue
                item, score = found, found_score
                album_title, spotify_album_id, streams = cand_title, cand_id, cand_streams
                break

            if item is None:
                if not args.keep_all and reject and not reject.startswith(
                        ("no album match", "not an album", "no eligible")):
                    excluded.append({"rank": rank, "artist": artist,
                                     "album": candidates[0][0],
                                     "spotify_artist_id": spotify_artist_id,
                                     "genre": genre, "reason": reject})
                    print(f"[{rank:3}] skip   {artist} - {candidates[0][0]} ({reject})")
                    time.sleep(args.delay)
                    continue
                raise ValueError(reject)

            image_url = artwork_url(item)
            if not image_url:
                raise ValueError("no artwork url")

            title = item["collectionName"]
            year = (item.get("releaseDate") or "")[:4] or "unknown"
            filename = f"{sanitize(artist)}_{sanitize(title)}_{year}.jpg"
            dest = OUT_DIR / filename

            if not dest.exists() or args.force:
                img = session.get(image_url, headers=HEADERS, timeout=60)
                img.raise_for_status()
                dest.write_bytes(img.content)
                print(f"[{rank:3}] saved  {filename} ({len(img.content) // 1024} KB)")
            else:
                print(f"[{rank:3}] have   {filename}")

            albums.append({
                "rank": rank,
                "artist": artist,
                "album": title,
                "kworb_album": album_title,
                "year": year,
                "release_date": item.get("releaseDate", "")[:10],
                "streams": int(streams),
                "track_count": item.get("trackCount"),
                "genre": item.get("primaryGenreName") or genre,
                # The artist's genre drives the language filter, and the album's
                # genre differs from it -- keep both so a cached record can be
                # re-validated offline.
                "artist_genre": genre,
                "spotify_artist_id": spotify_artist_id,
                "spotify_album_id": spotify_album_id,
                "itunes_collection_id": item.get("collectionId"),
                "image_url": image_url,
                "image_file": f"album_art/{filename}",
                "match_score": round(score, 3),
            })

        except (Throttled, ValueError, requests.RequestException) as exc:
            # album_title is None when no candidate ever matched.
            album_title = album_title or ""
            manual = MUSICHOARDERS.format(artist=quote(artist), album=quote(album_title))
            failures.append({"rank": rank, "artist": artist, "album": album_title,
                             "error": str(exc), "manual_url": manual})
            print(f"[{rank:3}] MISS   {artist} - {exc}", file=sys.stderr)

        # Checkpoint after every artist: a 40-minute run shouldn't lose its work to
        # one exception, and this file doubles as the resume cache.
        write_json(albums, excluded, failures)
        time.sleep(args.delay)

    write_json(albums, excluded, failures)

    print(f"\nDone. {len(albums)} playable albums -> {DATA_JSON.name}, art in {OUT_DIR}/")
    print(f"      {len(excluded)} excluded, {len(failures)} failed")
    if failures:
        print(f"\n{len(failures)} need a manual cover -- open these and pick one:")
        for f in failures:
            print(f"  {f['artist']} - {f['album'] or '?'} ({f['error']})\n    {f['manual_url']}")


if __name__ == "__main__":
    main()
