/* Recall — an Anki-style spaced-repetition flashcard app.
   Data lives in IndexedDB (see db.js): the decks array + a review log,
   plus media blobs. No backend. */

const DAY = 86400000;
const LEARN_STEPS = [60000, 600000]; // learning/relearning: 1m, 10m
const GRAD_INTERVAL = 1; // days when a card graduates on "Good"
const EASY_INTERVAL = 4; // days when a card graduates on "Easy"
const DEFAULT_NEW_PER_DAY = 20;
const DEFAULT_REV_PER_DAY = 200;

/* ---------- data ----------
   deck: { id, name, cards:[card], newPerDay?, revPerDay?, progress? }
     progress: { date:'YYYY-MM-DD', newDone, revDone }  (daily limit counters)
   card: { id, front, back, ease, interval, due, reps, lapses,
           state:'new'|'learning'|'review', step, suspended?, cloze?, clozeNum? }
     ease: SM-2 ease factor (start 2.5)
     interval: days until next review (for review-state cards)
     due: epoch ms when next due
     step: index into LEARN_STEPS while learning */

let decks = [];
let reviewLog = []; // [{ t, g, deckId, was }]  was: 'new'|'learning'|'review'

function save() {
  Store.saveDecks(decks); // fire-and-forget; IDB serializes writes
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function deckById(id) {
  return decks.find((d) => d.id === id);
}

// State of a card, tolerant of older/imported cards that lack the field.
function stateOf(c) {
  return c.state || (c.reps > 0 || c.interval > 0 ? "review" : "new");
}
function todayKey() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}
function deckProgress(deck) {
  if (!deck.progress || deck.progress.date !== todayKey())
    deck.progress = { date: todayKey(), newDone: 0, revDone: 0 };
  return deck.progress;
}
function newLimit(deck) {
  return deck.newPerDay ?? DEFAULT_NEW_PER_DAY;
}
function revLimit(deck) {
  return deck.revPerDay ?? DEFAULT_REV_PER_DAY;
}

// Cards available to study right now, respecting daily limits.
function buildQueue(deck) {
  const now = Date.now();
  const p = deckProgress(deck);
  const live = deck.cards.filter((c) => !c.suspended);
  const learning = live
    .filter((c) => stateOf(c) === "learning" && c.due <= now)
    .sort((a, b) => a.due - b.due);
  const reviews = live
    .filter((c) => stateOf(c) === "review" && c.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, Math.max(0, revLimit(deck) - p.revDone));
  const news = live
    .filter((c) => stateOf(c) === "new")
    .slice(0, Math.max(0, newLimit(deck) - p.newDone));
  return { learning, reviews, news };
}
function dueCount(deck) {
  const q = buildQueue(deck);
  return q.learning.length + q.reviews.length + q.news.length;
}

/* ---------- scheduling ----------
   grade: 0 again, 1 hard, 2 good, 3 easy */
function schedule(card, grade) {
  const now = Date.now();
  const st = stateOf(card);

  if (st === "review") {
    if (grade === 0) {
      card.lapses = (card.lapses || 0) + 1;
      card.ease = Math.max(1.3, card.ease - 0.2);
      card.state = "learning";
      card.step = 0;
      card.interval = Math.max(1, Math.round(card.interval * 0.4)); // kept for re-graduation
      card.due = now + LEARN_STEPS[0];
      return;
    }
    let mult;
    if (grade === 1) {
      mult = 1.2;
      card.ease = Math.max(1.3, card.ease - 0.15);
    } else if (grade === 2) {
      mult = card.ease;
    } else {
      mult = card.ease * 1.3;
      card.ease += 0.15;
    }
    card.interval = Math.max(1, Math.round(card.interval * mult));
    card.due = now + card.interval * DAY;
    return;
  }

  // new or learning (relearning included)
  card.reps = (card.reps || 0) + 1;
  if (grade === 0) {
    card.state = "learning";
    card.step = 0;
    card.due = now + LEARN_STEPS[0];
    return;
  }
  if (grade === 3) {
    // Easy graduates immediately
    card.state = "review";
    card.step = 0;
    card.interval = Math.max(EASY_INTERVAL, card.interval || 0);
    card.due = now + card.interval * DAY;
    return;
  }
  if (grade === 1) {
    // Hard repeats the current step
    card.state = "learning";
    card.due = now + LEARN_STEPS[Math.min(card.step || 0, LEARN_STEPS.length - 1)];
    return;
  }
  // Good advances one step, graduating after the last
  card.state = "learning";
  card.step = (card.step || 0) + 1;
  if (card.step >= LEARN_STEPS.length) {
    card.state = "review";
    card.step = 0;
    card.interval = Math.max(GRAD_INTERVAL, card.interval || 0);
    card.due = now + card.interval * DAY;
  } else {
    card.due = now + LEARN_STEPS[card.step];
  }
}

function newCard(front, back, extra = {}) {
  return Object.assign(
    {
      id: uid(),
      front: front.trim(),
      back: back.trim(),
      ease: 2.5,
      interval: 0,
      due: Date.now(),
      reps: 0,
      lapses: 0,
      state: "new",
      step: 0,
    },
    extra
  );
}

/* ---------- cloze ---------- */
const CLOZE_RE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g;

function clozeNumbers(src) {
  const set = new Set();
  let m;
  CLOZE_RE.lastIndex = 0;
  while ((m = CLOZE_RE.exec(src))) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}
function renderCloze(src, targetNum, reveal) {
  return cardHTML(src).replace(CLOZE_RE, (_m, n, ans, hint) => {
    if (Number(n) === targetNum) {
      return reveal
        ? `<span class="cloze-ans">${ans}</span>`
        : `<span class="cloze-blank">[${hint || "..."}]</span>`;
    }
    return ans;
  });
}
function stripCloze(src) {
  return String(src).replace(CLOZE_RE, (_m, _n, ans) => ans);
}

/* ---------- content rendering (text / html / media) ---------- */
function escapeHTML(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}
function looksRich(s) {
  return /<\w|<\/|\[sound:/.test(s);
}
function cardHTML(raw) {
  let s = String(raw || "").replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(
    /\[sound:([^\]]+)\]/g,
    (_m, n) =>
      `<audio controls preload="none" data-snd="${escapeHTML(n)}"></audio>`
  );
  return s;
}
function setContent(el, raw) {
  el.innerHTML = looksRich(raw)
    ? cardHTML(raw)
    : escapeHTML(raw).replace(/\n/g, "<br>");
  resolveMedia(el);
}
async function resolveMedia(container) {
  for (const img of container.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    const blob = await Store.getMedia(decodeURIComponent(src));
    if (blob) img.src = URL.createObjectURL(blob);
  }
  for (const a of container.querySelectorAll("audio[data-snd]")) {
    const blob = await Store.getMedia(a.dataset.snd);
    if (blob) a.src = URL.createObjectURL(blob);
  }
}
function cardLabel(c) {
  const raw = c.cloze ? stripCloze(c.cloze) : c.front || c.back;
  return String(raw).replace(/<[^>]+>/g, "").replace(/\[sound:[^\]]+\]/g, "🔊");
}

/* ---------- view router ---------- */
const app = document.getElementById("app");
const titleEl = document.getElementById("title");
const backBtn = document.getElementById("backBtn");
const addBtn = document.getElementById("addBtn");

let view = { name: "decks" };

function go(v) {
  view = v;
  render();
}

backBtn.onclick = () => {
  if (view.name === "deck") go({ name: "decks" });
  else if (view.name === "review") go({ name: "deck", id: view.id });
  else if (view.name === "edit")
    go(view.from || { name: "deck", id: view.deckId });
  else go({ name: "decks" });
};

addBtn.onclick = () => {
  if (view.name === "decks") addDeck();
  else if (view.name === "deck") go({ name: "edit", deckId: view.id });
};

function render() {
  document.onkeydown = null; // review installs its own; clear on every nav
  const isRoot = view.name === "decks";
  backBtn.hidden = isRoot;
  addBtn.hidden = !(view.name === "decks" || view.name === "deck");

  if (view.name === "decks") return renderDecks();
  if (view.name === "deck") return renderDeck(deckById(view.id));
  if (view.name === "review") return renderReview(deckById(view.id), view.cram);
  if (view.name === "edit")
    return renderEdit(view.deckId, view.cardId, view.from);
  if (view.name === "import") return renderImport();
  if (view.name === "stats") return renderStats();
  if (view.name === "browse") return renderBrowse();
}

/* ---------- decks list ---------- */
function renderDecks() {
  titleEl.textContent = "Recall";
  app.innerHTML = "";

  if (decks.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "No decks yet.<br>Tap + to create one,<br>or import below.";
    app.appendChild(e);
    appendLibraryActions();
    return;
  }

  decks.forEach((d) => {
    const due = dueCount(d);
    const el = document.createElement("div");
    el.className = "deck";
    el.innerHTML = `
      <div class="deck-info">
        <div class="deck-name"></div>
        <div class="deck-sub">${d.cards.length} card${d.cards.length === 1 ? "" : "s"}</div>
      </div>
      <div class="due-badge ${due ? "" : "zero"}">${due}</div>`;
    el.querySelector(".deck-name").textContent = d.name;
    el.onclick = () => go({ name: "deck", id: d.id });
    app.appendChild(el);
  });

  appendLibraryActions();
}

function appendLibraryActions() {
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.className = "btn secondary";
    b.textContent = label;
    b.onclick = fn;
    app.appendChild(b);
  };
  if (decks.length) mk("Browse all cards", () => go({ name: "browse" }));
  mk("Stats", () => go({ name: "stats" }));
  mk("Import", () => go({ name: "import" }));
  if (decks.length) mk("Export backup", exportBackup);
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(decks, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `recall-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function addDeck() {
  const name = prompt("Deck name:");
  if (!name || !name.trim()) return;
  decks.push({ id: uid(), name: name.trim(), cards: [] });
  save();
  render();
}

/* ---------- single deck ---------- */
function renderDeck(deck) {
  if (!deck) return go({ name: "decks" });
  titleEl.textContent = deck.name;
  app.innerHTML = "";

  const q = buildQueue(deck);
  const due = q.learning.length + q.reviews.length + q.news.length;

  const counts = document.createElement("div");
  counts.className = "queue-counts";
  counts.innerHTML = `
    <span class="qc new">${q.news.length}<small>new</small></span>
    <span class="qc learn">${q.learning.length}<small>learn</small></span>
    <span class="qc review">${q.reviews.length}<small>due</small></span>`;
  app.appendChild(counts);

  const studyBtn = document.createElement("button");
  studyBtn.className = "btn";
  studyBtn.textContent = due ? `Study (${due})` : "Nothing due — cram all";
  studyBtn.onclick = () => go({ name: "review", id: deck.id, cram: due === 0 });
  app.appendChild(studyBtn);

  // deck options: new-cards-per-day limit
  const opt = document.createElement("button");
  opt.className = "btn secondary";
  opt.textContent = `New cards/day: ${newLimit(deck)}`;
  opt.onclick = () => {
    const v = prompt("New cards per day for this deck:", newLimit(deck));
    if (v === null) return;
    const n = Math.max(0, parseInt(v, 10) || 0);
    deck.newPerDay = n;
    save();
    render();
  };
  app.appendChild(opt);

  if (deck.cards.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "No cards yet.<br>Tap + to add one.";
    app.appendChild(e);
  }

  deck.cards.forEach((c) => {
    const row = document.createElement("div");
    row.className = "card-row" + (c.suspended ? " suspended" : "");
    row.innerHTML = `<div class="front"></div><div class="back"></div>
      <div class="card-row-actions">
        <button class="edit">Edit</button>
        <button class="del">Delete</button>
      </div>`;
    row.querySelector(".front").textContent =
      cardLabel(c) + (c.cloze ? ` · cloze ${c.clozeNum}` : "");
    row.querySelector(".back").textContent = c.cloze
      ? c.back
        ? "+ " + c.back.replace(/<[^>]+>/g, "")
        : ""
      : cardLabel({ front: c.back });
    row.querySelector(".edit").onclick = () =>
      go({ name: "edit", deckId: deck.id, cardId: c.id });
    row.querySelector(".del").onclick = () => {
      if (confirm("Delete this card?")) {
        deck.cards = deck.cards.filter((x) => x.id !== c.id);
        save();
        render();
      }
    };
    app.appendChild(row);
  });

  const delDeck = document.createElement("button");
  delDeck.className = "btn danger";
  delDeck.textContent = "Delete deck";
  delDeck.onclick = () => {
    if (confirm(`Delete deck "${deck.name}" and all its cards?`)) {
      decks = decks.filter((d) => d.id !== deck.id);
      save();
      go({ name: "decks" });
    }
  };
  app.appendChild(delDeck);
}

/* ---------- add / edit card ---------- */
function renderEdit(deckId, cardId, from) {
  const deck = deckById(deckId);
  const card = cardId ? deck.cards.find((c) => c.id === cardId) : null;
  titleEl.textContent = card ? "Edit card" : "New card";
  app.innerHTML = `
    <div class="field">
      <label>Front <span class="hint">— or cloze: {{c1::hidden}}</span></label>
      <textarea id="front" placeholder="Question / prompt"></textarea>
    </div>
    <div class="field">
      <label>Back <span class="hint">— extra info for cloze cards</span></label>
      <textarea id="back" placeholder="Answer"></textarea>
    </div>
    <button class="btn secondary" id="addImg">📷 Attach image</button>
    <input id="imgFile" type="file" accept="image/*" hidden />
    <button class="btn" id="saveCard">Save</button>
    <button class="btn secondary" id="saveAdd" ${card ? "hidden" : ""}>Save &amp; add another</button>`;

  const frontEl = document.getElementById("front");
  const backEl = document.getElementById("back");
  if (card) {
    frontEl.value = card.cloze || card.front;
    backEl.value = card.back;
  }
  frontEl.focus();

  let lastFocused = frontEl;
  frontEl.addEventListener("focus", () => (lastFocused = frontEl));
  backEl.addEventListener("focus", () => (lastFocused = backEl));
  document.getElementById("addImg").onclick = () =>
    document.getElementById("imgFile").click();
  document.getElementById("imgFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = `img-${uid()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    await Store.putMedia(name, file);
    insertAtCursor(lastFocused, `<img src="${name}">`);
  };

  function commit() {
    const f = frontEl.value.trim();
    const b = backEl.value.trim();
    const nums = clozeNumbers(f);

    if (card) {
      if (card.cloze || nums.length) {
        card.cloze = f;
        card.front = "";
        card.back = b;
        if (nums.length && !nums.includes(card.clozeNum))
          card.clozeNum = nums[0];
      } else {
        if (!f || !b) return alert("Both sides are required."), false;
        card.front = f;
        card.back = b;
      }
      save();
      return true;
    }

    if (nums.length) {
      nums.forEach((n) =>
        deck.cards.push(newCard("", b, { cloze: f, clozeNum: n }))
      );
    } else {
      if (!f || !b) return alert("Both sides are required."), false;
      deck.cards.push(newCard(f, b));
    }
    save();
    return true;
  }

  document.getElementById("saveCard").onclick = () => {
    if (commit()) go(from || { name: "deck", id: deckId });
  };
  document.getElementById("saveAdd").onclick = () => {
    if (commit()) {
      frontEl.value = "";
      backEl.value = "";
      frontEl.focus();
    }
  };
}

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(start);
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
}

/* ---------- browse / search ---------- */
function renderBrowse() {
  titleEl.textContent = "Browse";
  app.innerHTML = `
    <div class="field">
      <input id="q" placeholder="Search all cards…" autocomplete="off" />
    </div>
    <div id="results"></div>`;
  const q = document.getElementById("q");
  const results = document.getElementById("results");

  function run() {
    const term = q.value.trim().toLowerCase();
    results.innerHTML = "";
    let shown = 0;
    for (const deck of decks) {
      for (const c of deck.cards) {
        const hay = (cardLabel(c) + " " + (c.back || "")).toLowerCase();
        if (term && !hay.includes(term)) continue;
        if (++shown > 300) break;
        const row = document.createElement("div");
        row.className = "card-row" + (c.suspended ? " suspended" : "");
        row.innerHTML = `<div class="front"></div><div class="back"></div>`;
        row.querySelector(".front").textContent = cardLabel(c);
        row.querySelector(".back").textContent = deck.name;
        row.onclick = () =>
          go({
            name: "edit",
            deckId: deck.id,
            cardId: c.id,
            from: { name: "browse" },
          });
        results.appendChild(row);
      }
    }
    if (!shown)
      results.innerHTML = `<div class="empty">No matching cards.</div>`;
  }
  q.oninput = run;
  run();
  q.focus();
}

/* ---------- import ---------- */
function renderImport() {
  titleEl.textContent = "Import";
  app.innerHTML = `
    <div class="field">
      <label>Import an Anki deck (.apkg)</label>
      <input id="apkgFile" type="file" accept=".apkg" />
      <div id="apkgStatus" class="hint"></div>
    </div>

    <div style="height:20px"></div>
    <div class="field">
      <label>Deck name</label>
      <input id="impName" placeholder="e.g. Spanish 101" />
    </div>
    <div class="field">
      <label>Cards — one per line, front and back split by a Tab or comma</label>
      <textarea id="impText" placeholder="hola\thello
gato\tcat"></textarea>
    </div>
    <button class="btn" id="impGo">Import cards</button>

    <div style="height:24px"></div>
    <div class="field">
      <label>Restore a JSON backup (replaces matching decks)</label>
      <input id="impFile" type="file" accept=".json,application/json" />
    </div>`;

  document.getElementById("apkgFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById("apkgStatus");
    status.textContent = "Reading deck… (first time loads the SQLite engine)";
    try {
      const buf = await file.arrayBuffer();
      const imported = await importApkg(buf);
      let total = 0;
      imported.forEach((d) => {
        if (!d.cards.length) return;
        d.cards.forEach((c) => {
          // imported cards lack these scheduling fields; fill without clobbering
          if (c.state == null) c.state = stateOf(c);
          if (c.step == null) c.step = 0;
          if (c.lapses == null) c.lapses = 0;
        });
        decks.push({ id: uid(), name: d.name, cards: d.cards });
        total += d.cards.length;
      });
      save();
      alert(
        `Imported ${imported.length} deck${imported.length === 1 ? "" : "s"}, ${total} cards.`
      );
      go({ name: "decks" });
    } catch (err) {
      status.textContent = "";
      alert("Couldn't import that .apkg:\n" + err.message);
    }
  };

  document.getElementById("impGo").onclick = () => {
    const name = document.getElementById("impName").value.trim();
    const text = document.getElementById("impText").value;
    if (!name) return alert("Give the deck a name.");
    const cards = parseTextCards(text);
    if (!cards.length) return alert("No valid cards found.");
    decks.push({ id: uid(), name, cards });
    save();
    alert(`Imported ${cards.length} card${cards.length === 1 ? "" : "s"}.`);
    go({ name: "decks" });
  };

  document.getElementById("impFile").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        restoreBackup(reader.result);
        go({ name: "decks" });
      } catch (err) {
        alert("Couldn't read that backup: " + err.message);
      }
    };
    reader.readAsText(file);
  };
}

function parseTextCards(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.includes("\t") ? "\t" : ",";
    const i = line.indexOf(sep);
    if (i < 0) continue;
    const front = line.slice(0, i).trim();
    const back = line.slice(i + 1).trim();
    if (front && back) out.push(newCard(front, back));
  }
  return out;
}

function restoreBackup(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (!Array.isArray(data)) throw new Error("not a Recall backup");
  let added = 0;
  for (const d of data) {
    if (!d || !d.name || !Array.isArray(d.cards)) continue;
    const cards = d.cards.map((c) =>
      Object.assign(newCard(String(c.front || ""), String(c.back || "")), c)
    );
    const deck = {
      id: d.id || uid(),
      name: String(d.name),
      cards,
      ...(d.newPerDay != null ? { newPerDay: d.newPerDay } : {}),
    };
    const existing = decks.findIndex((x) => x.id === deck.id);
    if (existing >= 0) decks[existing] = deck;
    else decks.push(deck);
    added++;
  }
  save();
  alert(`Restored ${added} deck${added === 1 ? "" : "s"}.`);
}

/* ---------- review session ---------- */
function renderReview(deck, cram) {
  if (!deck) return go({ name: "decks" });
  titleEl.textContent = cram ? "Cram" : "Study";
  const p = deckProgress(deck);
  let lastAnswer = null; // one-level undo

  function pickNext() {
    if (cram) {
      const pool = deck.cards.filter((c) => !c.suspended);
      return pool[Math.floor(Math.random() * pool.length)] || null;
    }
    const q = buildQueue(deck);
    return q.learning[0] || q.reviews[0] || q.news[0] || null;
  }

  function counts() {
    if (cram) return { news: "—", learn: "—", reviews: "—" };
    const q = buildQueue(deck);
    return {
      news: q.news.length,
      learn: q.learning.length,
      reviews: q.reviews.length,
    };
  }

  function nextCard() {
    const card = pickNext();
    if (!card) return showDone();
    showCard(card);
  }

  function showDone() {
    document.onkeydown = null;
    app.innerHTML = `<div class="done"><div class="big">✅</div>All done for now!</div>`;
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "Back to deck";
    b.onclick = () => go({ name: "deck", id: deck.id });
    app.appendChild(b);
  }

  function header() {
    const c = counts();
    return `<div class="study-bar">
      <div class="queue-counts mini">
        <span class="qc new">${c.news}</span>
        <span class="qc learn">${c.learn}</span>
        <span class="qc review">${c.reviews}</span>
      </div>
      <div class="study-tools">
        <button id="undoBtn" class="tool" ${lastAnswer ? "" : "disabled"}>↶ Undo</button>
        <button id="suspendBtn" class="tool">⏸ Suspend</button>
        <button id="editBtn" class="tool">✏️ Edit</button>
      </div>
    </div>`;
  }

  function showCard(card) {
    app.innerHTML =
      header() +
      `<div class="review-wrap">
        <div class="flashcard" id="fc">
          <div class="front-text"></div>
          <div class="tap-hint">tap to reveal</div>
        </div>
      </div>`;
    wireTools(card);
    const ft = document.querySelector("#fc .front-text");
    if (card.cloze) ft.innerHTML = renderCloze(card.cloze, card.clozeNum, false);
    else setContent(ft, card.front);
    resolveMedia(ft);
    document.getElementById("fc").onclick = () => reveal(card);
    document.onkeydown = (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        reveal(card);
      } else if (e.key.toLowerCase() === "u" && lastAnswer) undo();
    };
  }

  function reveal(card) {
    const fc = document.getElementById("fc");
    if (!fc) return;
    fc.onclick = null;
    fc.innerHTML = `<div class="front-text"></div>
      <div class="divider"></div>
      <div class="back-text"></div>`;
    const ft = fc.querySelector(".front-text");
    const bt = fc.querySelector(".back-text");
    if (card.cloze) {
      ft.innerHTML = renderCloze(card.cloze, card.clozeNum, true);
      if (card.back) setContent(bt, card.back);
    } else {
      setContent(ft, card.front);
      setContent(bt, card.back);
    }
    resolveMedia(fc);

    const grades = document.createElement("div");
    grades.className = "grade-row";
    grades.innerHTML = `
      <button class="grade again" data-g="0">Again</button>
      <button class="grade hard" data-g="1">Hard</button>
      <button class="grade good" data-g="2">Good</button>
      <button class="grade easy" data-g="3">Easy</button>`;
    grades.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => answer(card, Number(btn.dataset.g));
    });
    document.querySelector(".review-wrap").appendChild(grades);
    annotateGrades(card, grades);

    document.onkeydown = (e) => {
      if ("0123".includes(e.key)) answer(card, Number(e.key));
      else if ("1234".includes(e.key)) answer(card, Number(e.key) - 1);
      else if (e.key.toLowerCase() === "u" && lastAnswer) undo();
    };
  }

  function answer(card, grade) {
    const was = stateOf(card);
    lastAnswer = { card, snapshot: JSON.parse(JSON.stringify(card)), was };
    schedule(card, grade);
    if (!cram) {
      if (was === "new") p.newDone++;
      else if (was === "review") p.revDone++;
    }
    reviewLog.push({ t: Date.now(), g: grade, deckId: deck.id, was });
    Store.saveLog(reviewLog);
    save();
    nextCard();
  }

  function undo() {
    if (!lastAnswer) return;
    Object.assign(lastAnswer.card, lastAnswer.snapshot);
    if (!cram) {
      if (lastAnswer.was === "new") p.newDone = Math.max(0, p.newDone - 1);
      else if (lastAnswer.was === "review")
        p.revDone = Math.max(0, p.revDone - 1);
    }
    reviewLog.pop();
    Store.saveLog(reviewLog);
    const restored = lastAnswer.card;
    lastAnswer = null;
    save();
    showCard(restored);
  }

  function wireTools(card) {
    document.getElementById("undoBtn").onclick = undo;
    document.getElementById("suspendBtn").onclick = () => {
      card.suspended = true;
      save();
      nextCard();
    };
    document.getElementById("editBtn").onclick = () =>
      go({
        name: "edit",
        deckId: deck.id,
        cardId: card.id,
        from: { name: "review", id: deck.id, cram },
      });
  }

  nextCard();
}

function fmtInterval(card, grade) {
  const c = JSON.parse(JSON.stringify(card));
  schedule(c, grade);
  const ms = c.due - Date.now();
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + "m";
  if (ms < DAY) return Math.round(ms / 3600000) + "h";
  if (ms < 30 * DAY) return Math.round(ms / DAY) + "d";
  return Math.round(ms / (30 * DAY)) + "mo";
}
function annotateGrades(card, grades) {
  [0, 1, 2, 3].forEach((g) => {
    const btn = grades.querySelector(`[data-g="${g}"]`);
    const label = btn.childNodes[0].textContent;
    btn.innerHTML = `${label}<small>${fmtInterval(card, g)}</small>`;
  });
}

/* ---------- stats ---------- */
function renderStats() {
  titleEl.textContent = "Stats";
  app.innerHTML = "";

  const totalCards = decks.reduce((n, d) => n + d.cards.length, 0);
  const dueNow = decks.reduce((n, d) => n + dueCount(d), 0);

  const byDay = new Map();
  for (const r of reviewLog) {
    const key = new Date(r.t).toLocaleDateString("en-CA");
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const today = todayKey();
  const reviewedToday = byDay.get(today) || 0;

  let streak = 0;
  const d = new Date();
  while (byDay.get(d.toLocaleDateString("en-CA"))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }

  const cards = [
    ["Reviews today", reviewedToday],
    ["Streak", streak + (streak === 1 ? " day" : " days")],
    ["Total reviews", reviewLog.length],
    ["Cards", totalCards],
    ["Due now", dueNow],
    ["Decks", decks.length],
  ];
  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.innerHTML = cards
    .map(
      ([k, v]) =>
        `<div class="stat"><div class="stat-num">${v}</div><div class="stat-lbl">${k}</div></div>`
    )
    .join("");
  app.appendChild(grid);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dt.toLocaleDateString("en-CA");
    days.push({ n: byDay.get(key) || 0, label: dt.getDate() });
  }
  const max = Math.max(1, ...days.map((x) => x.n));
  const chart = document.createElement("div");
  chart.className = "chart-wrap";
  chart.innerHTML =
    `<div class="chart-title">Last 14 days</div><div class="chart">` +
    days
      .map(
        (x) =>
          `<div class="bar-col"><div class="bar" style="height:${
            (x.n / max) * 100
          }%" title="${x.n}"></div><div class="bar-lbl">${x.label}</div></div>`
      )
      .join("") +
    `</div>`;
  app.appendChild(chart);

  if (reviewLog.length) {
    const clr = document.createElement("button");
    clr.className = "btn secondary";
    clr.textContent = "Clear review history";
    clr.onclick = () => {
      if (confirm("Clear all review history? (cards are not affected)")) {
        reviewLog = [];
        Store.saveLog(reviewLog);
        render();
      }
    };
    app.appendChild(clr);
  }
}

/* ---------- boot ---------- */
async function boot() {
  decks = await Store.loadDecks();
  reviewLog = await Store.loadLog();
  render();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();
