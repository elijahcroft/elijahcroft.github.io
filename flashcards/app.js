/* Recall — a tiny Anki-style spaced-repetition flashcard app.
   Data lives in localStorage. No backend. */

const STORE_KEY = "recall.decks.v1";
const DAY = 86400000;

/* ---------- data ---------- */
// deck: { id, name, cards: [card] }
// card: { id, front, back, ease, interval, due, reps }
//   ease: SM-2 ease factor (start 2.5)
//   interval: days until next review
//   due: epoch ms when card is next due

let decks = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(decks));
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
    // lapse: reset interval, see again in ~1 min within this session
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
  // adjust ease
  if (grade === 1) card.ease = Math.max(1.3, card.ease - 0.15);
  if (grade === 3) card.ease = card.ease + 0.15;
  card.due = now + card.interval * DAY;
}

function newCard(front, back) {
  return {
    id: uid(),
    front: front.trim(),
    back: back.trim(),
    ease: 2.5,
    interval: 0,
    due: Date.now(),
    reps: 0,
  };
}

/* ---------- view router ---------- */
const app = document.getElementById("app");
const titleEl = document.getElementById("title");
const backBtn = document.getElementById("backBtn");
const addBtn = document.getElementById("addBtn");

let view = { name: "decks" }; // {name:'decks'} | {name:'deck',id} | {name:'review',id} | {name:'edit',deckId,cardId?}

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
  addBtn.hidden = view.name === "review" || view.name === "edit";

  if (view.name === "decks") return renderDecks();
  if (view.name === "deck") return renderDeck(deckById(view.id));
  if (view.name === "review") return renderReview(deckById(view.id));
  if (view.name === "edit") return renderEdit(view.deckId, view.cardId);
}

/* ---------- decks list ---------- */
function renderDecks() {
  titleEl.textContent = "Recall";
  app.innerHTML = "";

  if (decks.length === 0) {
    app.innerHTML = `<div class="empty">No decks yet.<br>Tap + to create one.</div>`;
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
    row.querySelector(".front").textContent = c.front;
    row.querySelector(".back").textContent = c.back;
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
      <label>Front</label>
      <textarea id="front" placeholder="Question / prompt"></textarea>
    </div>
    <div class="field">
      <label>Back</label>
      <textarea id="back" placeholder="Answer"></textarea>
    </div>
    <button class="btn" id="saveCard">Save</button>
    <button class="btn secondary" id="saveAdd" ${card ? "hidden" : ""}>Save &amp; add another</button>`;

  const frontEl = document.getElementById("front");
  const backEl = document.getElementById("back");
  if (card) {
    frontEl.value = card.front;
    backEl.value = card.back;
  }
  frontEl.focus();

  function commit() {
    const f = frontEl.value.trim();
    const b = backEl.value.trim();
    if (!f || !b) {
      alert("Both sides are required.");
      return false;
    }
    if (card) {
      card.front = f;
      card.back = b;
    } else {
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

/* ---------- review session ---------- */
function renderReview(deck) {
  if (!deck) return go({ name: "decks" });
  titleEl.textContent = "Study";

  // build queue: due first, else all (for "study anyway")
  let queue = dueCards(deck);
  if (queue.length === 0) queue = [...deck.cards];

  if (queue.length === 0) {
    app.innerHTML = `<div class="done"><div class="big">🎉</div>This deck has no cards.</div>`;
    return;
  }

  function nextCard() {
    // re-pull from current due set so lapsed cards loop back
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
    const fc = document.getElementById("fc");
    fc.querySelector(".front-text").textContent = card.front;

    fc.onclick = () => reveal(card);
  }

  function reveal(card) {
    const fc = document.getElementById("fc");
    fc.onclick = null;
    fc.innerHTML = `<div class="front-text"></div>
      <div class="divider"></div>
      <div class="back-text"></div>`;
    fc.querySelector(".front-text").textContent = card.front;
    fc.querySelector(".back-text").textContent = card.back;

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
        schedule(card, Number(btn.dataset.g));
        save();
        nextCard();
      };
    });
    // show interval previews on hard/good/easy
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

/* ---------- boot ---------- */
render();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
