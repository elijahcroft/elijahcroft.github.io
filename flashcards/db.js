/* Recall storage — IndexedDB.
   Two stores:
     kv    : small JSON blobs (the decks array, the review log) by key
     media : binary Blobs (images/audio) keyed by filename
   We keep the decks array in one kv record so the rest of the app can stay
   mostly synchronous: load once at boot, mutate in memory, save() writes back. */

const DB_NAME = "recall";
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function idbGet(store, key) {
  return tx(store, "readonly", (s) => req2promise(s.get(key)));
}
function idbPut(store, key, val) {
  return tx(store, "readwrite", (s) => s.put(val, key));
}
function idbDelete(store, key) {
  return tx(store, "readwrite", (s) => s.delete(key));
}
function req2promise(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/* ---- public API used by app.js ---- */

// One-time migration from the old localStorage store.
async function migrateFromLocalStorage() {
  const OLD = "recall.decks.v1";
  const raw = localStorage.getItem(OLD);
  if (!raw) return null;
  try {
    const decks = JSON.parse(raw);
    if (Array.isArray(decks) && decks.length) {
      await idbPut("kv", "decks", decks);
      localStorage.removeItem(OLD);
      return decks;
    }
  } catch {}
  localStorage.removeItem(OLD);
  return null;
}

const Store = {
  async loadDecks() {
    let decks = await idbGet("kv", "decks");
    if (decks === undefined) {
      decks = (await migrateFromLocalStorage()) || [];
      await idbPut("kv", "decks", decks);
    }
    return decks;
  },
  saveDecks(decks) {
    return idbPut("kv", "decks", decks);
  },
  loadLog() {
    return idbGet("kv", "reviewlog").then((v) => v || []);
  },
  saveLog(log) {
    return idbPut("kv", "reviewlog", log);
  },
  putMedia(name, blob) {
    return idbPut("media", name, blob);
  },
  getMedia(name) {
    return idbGet("media", name);
  },
  deleteMedia(name) {
    return idbDelete("media", name);
  },
};
