/* Recall — an Anki-style spaced-repetition flashcard app.
   Data lives in IndexedDB (see db.js): the decks array + a review log,
   plus media blobs. No backend. */

const DAY = 86400000;

/* ---------- data ----------
   deck: { id, name, cards: [card] }
   card: { id, front, back, ease, interval, due, reps, cloze?, clozeNum? }
     ease: SM-2 ease factor (start 2.5)
     interval: days until next review
     due: epoch ms when card is next due
     cloze/clozeNum: present on cloze cards (front/back hold extra text) */

let decks = [];
let reviewLog = []; // [{ t: epochMs, g: grade }]

function save() {
  Store.saveDecks(decks); // fire-and-forget; ordering preserved by IDB txns
}
function logReview(grade) {
  reviewLog.push({ t: Date.now(), g: grade });
  Store.saveLog(reviewLog);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function deckById(id) {
  return decks.find((d) => d.id === id);
}
function dueCards(deck) {
  const now = Date.now();
  return deck.cards.filter((c) => c.due <= now);
}

/* ---------- SM-2 scheduling ----------
   grade: 0 again, 1 hard, 2 good, 3 easy */
function schedule(card, grade) {
  const now = Date.now();
  if (grade === 0) {
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.interval = 0;
    card.due = now + 60000;
    card.reps = 0;
    return;
  }
  card.reps += 1;
  if (card.reps === 1) {
    card.interval = grade === 3 ? 4 : 1;
  } else if (card.reps === 2) {
    card.interval = grade === 3 ? 6 : grade === 1 ? 3 : 4;
  } else {
    const mult = grade === 1 ? 1.2 : grade === 3 ? card.ease * 1.3 : card.ease;
    card.interval = Math.round(card.interval * mult);
  }
  if (grade === 1) card.ease = Math.max(1.3, card.ease - 0.15);
  if (grade === 3) card.ease = card.ease + 0.15;
  card.due = now + card.interval * DAY;
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
    },
    extra
  );
}

/* ---------- cloze ----------
   {{c1::answer}} or {{c1::answer::hint}}. Each distinct cloze number becomes
   its own card; on a card we hide its own number and reveal the others. */
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
    return ans; // other clozes shown filled in
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
// Prepare an HTML string: drop scripts, turn [sound:x] into an audio element.
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
// Swap media filenames for object URLs pulled from IndexedDB.
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
// A short plain-text label for list rows.
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
  else if (view.name === "edit") go({ name: "deck", id: view.deckId });
  else go({ name: "decks" });
};

addBtn.onclick = () => {
  if (view.name === "decks") addDeck();
  else if (view.name === "deck") go({ name: "edit", deckId: view.id });
};

function render() {
  const isRoot = view.name === "decks";
  backBtn.hidden = isRoot;
  addBtn.hidden = !(view.name === "decks" || view.name === "deck");

  if (view.name === "decks") return renderDecks();
  if (view.name === "deck") return renderDeck(deckById(view.id));
  if (view.name === "review") return renderReview(deckById(view.id));
  if (view.name === "edit") return renderEdit(view.deckId, view.cardId);
  if (view.name === "import") return renderImport();
  if (view.name === "stats") return renderStats();
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
    const due = dueCards(d).length;
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
  const statsBtn = document.createElement("button");
  statsBtn.className = "btn secondary";
  statsBtn.textContent = "Stats";
  statsBtn.onclick = () => go({ name: "stats" });
  app.appendChild(statsBtn);

  const importBtn = document.createElement("button");
  importBtn.className = "btn secondary";
  importBtn.textContent = "Import";
  importBtn.onclick = () => go({ name: "import" });
  app.appendChild(importBtn);

  if (decks.length) {
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn secondary";
    exportBtn.textContent = "Export backup";
    exportBtn.onclick = exportBackup;
    app.appendChild(exportBtn);
  }
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

  const due = dueCards(deck).length;

  const studyBtn = document.createElement("button");
  studyBtn.className = "btn";
  studyBtn.textContent = due ? `Study (${due} due)` : "Nothing due — study anyway";
  studyBtn.onclick = () => go({ name: "review", id: deck.id });
  app.appendChild(studyBtn);

  if (deck.cards.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.innerHTML = "No cards yet.<br>Tap + to add one.";
    app.appendChild(e);
  }

  deck.cards.forEach((c) => {
    const row = document.createElement("div");
    row.className = "card-row";
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
function renderEdit(deckId, cardId) {
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

  // Attach an image: store the blob, insert <img src="filename"> at the cursor.
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
    if (commit()) go({ name: "deck", id: deckId });
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
    const cards = d.cards.map((c) => ({
      id: c.id || uid(),
      front: String(c.front || ""),
      back: String(c.back || ""),
      ease: c.ease ?? 2.5,
      interval: c.interval ?? 0,
      due: c.due ?? Date.now(),
      reps: c.reps ?? 0,
      ...(c.cloze ? { cloze: c.cloze, clozeNum: c.clozeNum } : {}),
    }));
    const deck = { id: d.id || uid(), name: String(d.name), cards };
    const existing = decks.findIndex((x) => x.id === deck.id);
    if (existing >= 0) decks[existing] = deck;
    else decks.push(deck);
    added++;
  }
  save();
  alert(`Restored ${added} deck${added === 1 ? "" : "s"}.`);
}

/* ---------- review session ---------- */
function renderReview(deck) {
  if (!deck) return go({ name: "decks" });
  titleEl.textContent = "Study";

  let queue = dueCards(deck);
  if (queue.length === 0) queue = [...deck.cards];

  if (queue.length === 0) {
    app.innerHTML = `<div class="done"><div class="big">🎉</div>This deck has no cards.</div>`;
    return;
  }

  function nextCard() {
    const now = Date.now();
    const remaining = queue.filter((c) => c.due <= now);
    if (remaining.length === 0) {
      app.innerHTML = `<div class="done"><div class="big">✅</div>All done for now!</div>`;
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "Back to deck";
      b.onclick = () => go({ name: "deck", id: deck.id });
      app.appendChild(b);
      return;
    }
    showCard(remaining[0]);
  }

  function showCard(card) {
    app.innerHTML = `
      <div class="review-wrap">
        <div class="flashcard" id="fc">
          <div class="front-text"></div>
          <div class="tap-hint">tap to reveal</div>
        </div>
      </div>`;
    const ft = document.querySelector("#fc .front-text");
    if (card.cloze) ft.innerHTML = renderCloze(card.cloze, card.clozeNum, false);
    else setContent(ft, card.front);
    resolveMedia(ft);
    document.getElementById("fc").onclick = () => reveal(card);
  }

  function reveal(card) {
    const fc = document.getElementById("fc");
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

    const wrap = document.querySelector(".review-wrap");
    const grades = document.createElement("div");
    grades.className = "grade-row";
    grades.innerHTML = `
      <button class="grade again" data-g="0">Again<small>&lt;1m</small></button>
      <button class="grade hard" data-g="1">Hard</button>
      <button class="grade good" data-g="2">Good</button>
      <button class="grade easy" data-g="3">Easy</button>`;
    grades.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        const g = Number(btn.dataset.g);
        schedule(card, g);
        logReview(g);
        save();
        nextCard();
      };
    });
    wrap.appendChild(grades);
    annotateGrades(card, grades);
  }

  nextCard();
}

function fmtInterval(card, grade) {
  const clone = JSON.parse(JSON.stringify(card));
  schedule(clone, grade);
  if (clone.interval === 0) return "<1m";
  if (clone.interval < 1) return "<1d";
  return clone.interval + "d";
}
function annotateGrades(card, grades) {
  [1, 2, 3].forEach((g) => {
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
  const dueNow = decks.reduce((n, d) => n + dueCards(d).length, 0);

  // bucket reviews by local day
  const byDay = new Map();
  for (const r of reviewLog) {
    const key = new Date(r.t).toLocaleDateString("en-CA"); // YYYY-MM-DD
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const today = new Date().toLocaleDateString("en-CA");
  const reviewedToday = byDay.get(today) || 0;

  // streak: consecutive days up to today with ≥1 review
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

  // last 14 days bar chart
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dt.toLocaleDateString("en-CA");
    days.push({ key, n: byDay.get(key) || 0, label: dt.getDate() });
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
