/* Anki .apkg import.
   An .apkg is a ZIP containing:
     - collection.anki2 / collection.anki21  (a SQLite database)
     - media                                  (JSON: "0" -> "real_name.jpg")
     - 0, 1, 2, ...                            (the media files, numbered)
   We unzip with fflate, read the SQLite with sql.js, and turn Anki notes
   into Recall cards. Media blobs are stored in IndexedDB under their real
   names so the renderer can resolve <img src="name"> and [sound:name].

   Scheduling state is NOT imported — cards come in as new. */

const FSEP = String.fromCharCode(0x1f); // Anki joins note fields with 0x1f

let _SQL = null;
function loadSQL() {
  if (_SQL) return Promise.resolve(_SQL);
  return initSqlJs({ locateFile: (f) => "vendor/" + f }).then((s) => {
    _SQL = s;
    return s;
  });
}

async function importApkg(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const files = fflate.unzipSync(bytes);

  // Newest Anki uses a zstd-compressed collection we can't read here.
  if (files["collection.anki21b"] && !files["collection.anki2"]) {
    throw new Error(
      "This deck uses Anki's newest compressed format. In Anki, export it again with “Support older Anki versions” checked."
    );
  }

  const dbBytes =
    files["collection.anki21"] || files["collection.anki2"];
  if (!dbBytes) throw new Error("No Anki collection found in that file.");

  // Store media under real filenames.
  if (files["media"]) {
    let map = {};
    try {
      map = JSON.parse(new TextDecoder().decode(files["media"]));
    } catch {}
    for (const [num, realName] of Object.entries(map)) {
      const data = files[num];
      if (data) await Store.putMedia(realName, new Blob([data]));
    }
  }

  const SQL = await loadSQL();
  const db = new SQL.Database(dbBytes);

  // col holds the models (note types) and deck names as JSON.
  const colRow = db.exec("SELECT models, decks FROM col LIMIT 1")[0];
  const models = JSON.parse(colRow.values[0][0]);
  const deckNames = JSON.parse(colRow.values[0][1]);

  // Pull every card joined to its note.
  const res = db.exec(
    "SELECT c.ord, c.did, n.mid, n.flds FROM cards c JOIN notes n ON n.id = c.nid"
  );
  db.close();

  const byDeck = new Map(); // deckName -> [card]
  if (res.length) {
    const [{ values }] = res;
    for (const [ord, did, mid, flds] of values) {
      const model = models[mid] || models[String(mid)];
      if (!model) continue;
      const fields = String(flds).split(FSEP);
      const card = buildCard(model, fields, ord);
      if (!card) continue;
      const dname =
        (deckNames[did] || deckNames[String(did)] || {}).name || "Imported";
      if (!byDeck.has(dname)) byDeck.set(dname, []);
      byDeck.get(dname).push(card);
    }
  }

  return [...byDeck.entries()].map(([name, cards]) => ({
    name: cleanDeckName(name),
    cards,
  }));
}

// Turn one Anki note (+ its card ordinal) into a Recall card.
function buildCard(model, fields, ord) {
  if (model.type === 1) {
    // Cloze: every card shares the same source text; ord = cloze number - 1.
    const src = fields[0] || "";
    const num = (ord | 0) + 1;
    if (!hasClozeNum(src, num)) return null;
    return makeImportedCard("", "", { cloze: src, clozeNum: num });
  }
  // Standard: front = first field, back = the rest.
  const front = (fields[0] || "").trim();
  const back = fields.slice(1).filter((f) => f.trim()).join("<hr>").trim();
  if (!front && !back) return null;
  return makeImportedCard(front, back);
}

function hasClozeNum(text, num) {
  return new RegExp("{{c" + num + "::", "i").test(text);
}

// Build a fresh card object (mirrors newCard in app.js but used pre-boot-safe).
function makeImportedCard(front, back, extra = {}) {
  return Object.assign(
    {
      id:
        Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      front,
      back,
      ease: 2.5,
      interval: 0,
      due: Date.now(),
      reps: 0,
    },
    extra
  );
}

// Anki nests decks with "::"; keep the leaf name.
function cleanDeckName(name) {
  const leaf = String(name).split("::").pop().trim();
  return leaf || "Imported";
}
