# Recall — flashcards

A tiny Anki-style spaced-repetition flashcard PWA. Vanilla JS, no build step, no backend.
Decks, cards, media, and review history are stored in your browser's IndexedDB
(on this device). Supports `.apkg` import, cloze deletion, images/audio, and stats.

## Run locally

It must be served over HTTP (service workers don't run from `file://`):

```bash
cd flashcards
python3 -m http.server 8000
```

Then open http://localhost:8000

## Host it

Upload the whole `flashcards/` folder to your site (any static host works).
Visit it once on your phone, then **Add to Home Screen** — it installs as an app
and works offline after the first load.

> PWA install requires HTTPS (most hosts give you that automatically).

## Adding to your phone
- **iOS Safari:** Share → Add to Home Screen
- **Android Chrome:** menu → Install app / Add to Home screen

## How review works
SM-2-ish scheduling. When reviewing, grade each card:
- **Again** — forgot; shows again in under a minute
- **Hard / Good / Easy** — pushes the next review further out

Each button shows how long until you'll see the card again.

## Studying (Anki-style engine)
- **Learning steps** — new cards step through 1m → 10m before graduating; Again
  resets, Hard repeats, Good advances, Easy graduates to 4 days. Review cards
  grow by their ease factor; a lapse drops them back into relearning.
- **Daily new-card limit** — default 20/deck, editable on the deck screen. The
  deck and study screens show live **new / learning / due** counts.
- **Undo** the last answer, **Suspend** a card, or **Edit** it mid-review.
- **Cram** — when nothing's due, "cram all" reviews the whole deck.
- **Browse** — search across every card in every deck; tap to edit.
- **Keyboard** (desktop): Space/Enter flips; 1–4 grade; U undoes.

## Anki features
- **Import `.apkg`** — Import view → pick an Anki deck file. Reads the SQLite
  collection + media. Cards come in as new (Anki's own scheduling isn't imported).
  If a deck won't load, re-export it from Anki with "Support older Anki versions".
- **Cloze deletion** — type `{{c1::hidden}}` (or `{{c1::hidden::hint}}`) in the
  Front box. Each cloze number becomes its own card automatically.
- **Images / audio** — "Attach image" in the editor, or imported media. Anki
  `[sound:x]` and `<img src="x">` references resolve from stored media.
- **Stats** — reviews today, streak, totals, and a 14-day activity chart.

## Files
- `index.html` / `styles.css` / `app.js` — the app
- `db.js` — IndexedDB storage (decks, review log, media)
- `apkg.js` — Anki `.apkg` importer
- `vendor/` — `fflate` (unzip) + `sql.js` (SQLite WASM) for `.apkg`
- `manifest.json` / `sw.js` — PWA install + offline
- `icons/` — app icon (SVG + generated PNGs)

## Notes / iterate later
- Data is per-device (IndexedDB). No cloud sync yet — use Export/Import backup
  to move between devices.
- The first `.apkg` import loads the ~650 KB SQLite WASM engine; it's cached after.
