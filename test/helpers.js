// Test-Hilfen: In-Memory-Ersatz für Firebase + Lader für die Browser-Skripte.
// Keine Abhängigkeiten - läuft mit "node --test test/" (Node >= 18).
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Entfernt null/undefined und leere Objekte (so verhält sich auch Firebase)
function prune(v) {
  if (v === null || typeof v !== 'object') return v;
  Object.keys(v).forEach((k) => {
    v[k] = prune(v[k]);
    if (v[k] === null || v[k] === undefined || (typeof v[k] === 'object' && !Object.keys(v[k]).length)) delete v[k];
  });
  return v;
}

// Firebase ersetzt {'.sv':'timestamp'} beim Schreiben durch die Serverzeit
function resolveServerValues(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    Object.keys(v).forEach((k) => { v[k] = resolveServerValues(v[k]); });
  }
  return v;
}

class FakeDb {
  constructor(initial = {}) {
    this.data = prune(clone(initial)); // wie Firebase: null/leere Objekte gibt es nicht
    this.failGet = false;
    this.failTransaction = null; // (pfad) => true  -> Transaktion wirft (Verbindungsabbruch)
    this.afterQuery = null;      // Hook: läuft direkt nach einer orderByChild-Abfrage
  }
  _get(p) { return p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), this.data); }
  _set(p, value) {
    const keys = p.split('/').filter(Boolean);
    if (!keys.length) { this.data = prune(resolveServerValues(clone(value))) || {}; return; }
    let o = this.data;
    keys.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; });
    const v = value === undefined ? null : resolveServerValues(clone(value));
    if (v === null) delete o[keys[keys.length - 1]]; else o[keys[keys.length - 1]] = v;
    prune(this.data);
  }
  ref(p = '') {
    const db = this;
    const tick = () => Promise.resolve(); // echte Asynchronität -> Interleaving möglich
    const snap = (val) => ({ val: () => clone(val), exists: () => val != null });
    return {
      child: (c) => db.ref(p + '/' + c),
      get: async () => { await tick(); if (db.failGet) throw new Error('netzwerk weg'); return snap(db._get(p)); },
      once: async () => { await tick(); if (db.failGet) throw new Error('netzwerk weg'); return snap(db._get(p)); },
      set: async (v) => { await tick(); db._set(p, v); },
      remove: async () => { await tick(); db._set(p, null); },
      update: async (obj) => { await tick(); Object.entries(obj).forEach(([k, v]) => db._set(p + '/' + k, v)); },
      transaction: async (fn) => {
        await tick();
        if (db.failTransaction && db.failTransaction(p)) throw new Error('Verbindung abgebrochen: ' + p);
        const res = fn(clone(db._get(p)));
        if (res === undefined) return { committed: false, snapshot: snap(db._get(p)) };
        db._set(p, res);
        return { committed: true, snapshot: snap(db._get(p)) };
      },
      // Nur das, was die Bereinigung braucht: orderByChild(c).endAt(v).limitToFirst(n).get()
      // Fehlende Werte sortieren in Firebase VOR allen anderen -> sie sind enthalten.
      orderByChild: (c) => ({ endAt: (v) => ({ limitToFirst: (n) => ({ get: async () => {
        await tick();
        const all = db._get(p) || {};
        const hit = {};
        Object.keys(all).filter((k) => { const x = all[k] && all[k][c]; return x == null || x <= v; })
          .slice(0, n).forEach((k) => { hit[k] = all[k]; });
        if (db.afterQuery) await db.afterQuery();
        return snap(hit);
      } }) }) }),
      onDisconnect: () => ({ remove() {}, cancel() {} }),
      on() {}, off() {}
    };
  }
}

const SRC = path.join(__dirname, '..', 'js');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// Ein "Browser-Client": eigener Scope (wie eine eigene Seite), gemeinsame DB.
// hooks[ms] läuft, wenn der Client setTimeout(.., ms) aufruft; hooks[ms] = 'crash'
// lässt den Client an dieser Stelle "sterben" (Fortsetzung nie ausgeführt).
function makeClient(db, uid, { files = ['config.js', 'game.js'], room = 'ABCD' } = {}) {
  const hooks = {};
  const alerts = {
    list: [],
    push(m) { this.list.push(m); }
  };
  const sandbox = {
    __db: db, console, alerts, hooks,
    alert: (...m) => alerts.push(m.join(' ')),
    setTimeout: (fn, ms) => {
      const h = hooks[ms];
      if (h === 'crash') return 0;
      Promise.resolve(typeof h === 'function' ? h() : null).then(fn);
      return 0;
    },
    clearTimeout() {},
    document: { getElementById: () => ({ innerHTML: '' }) },
    escapeHtml: (s) => s
  };
  const ctx = vm.createContext(sandbox);
  // Variablen, die im Browser aus firebase.js/ui.js kommen
  vm.runInContext(`
    const db = __db; let playerId = ${JSON.stringify(uid)}; let currentRoomCode = ${JSON.stringify(room)};
    let isHost = false; let latestPlayers = {}; let latestVotes = {};
    let isConnected = () => true; // kommt im Browser aus firebase.js
    let roomSynced = Promise.resolve(true); // kommt im Browser aus firebase.js
    const viewGame = { hidden: true }; function renderGame() {}`, ctx);
  files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  const set = (name, value) => vm.runInContext(`${name} = ${JSON.stringify(value === undefined ? null : value)}`, ctx);
  return {
    ctx, hooks, alerts, set,
    run: (code) => vm.runInContext(code, ctx),
    // wie die Live-Listener: lokalen Stand aus der DB übernehmen
    sync: () => {
      const r = db.data.rooms[room] || {};
      set('latestGame', r.game || null);
      set('latestGamePlayers', r.gamePlayers || {});
      set('latestPlayers', r.players || {});
      set('latestVotes', r.replayVotes || {});
    }
  };
}

// Client mit ECHTEM firebase.js (Beitritt, Raum erstellen ...). Firebase-SDK und
// DOM sind Attrappen; enterRoom() wird ersetzt und protokolliert nur den Raum.
function makeBrowserClient(db, uid, { name = 'Max', code = 'ABCD', persistenceFails = false, cookieBlocked = false, cookies = {} } = {}) {
  const errors = [], entered = [], authLog = [], jar = { ...cookies }, rawCookies = {};
  const sandbox = {
    console, errors, entered,
    firebaseConfig: {},
    firebase: {
      initializeApp() {},
      database: Object.assign(() => db, { ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } } }),
      auth: Object.assign(() => ({
        setPersistence: async (mode) => { authLog.push('persist:' + mode); if (persistenceFails) throw new Error('nicht möglich'); },
        signInAnonymously: async () => { authLog.push('signin'); return { user: { uid } }; }
      }), { Auth: { Persistence: { LOCAL: 'local' } } })
    },
    document: {
      addEventListener() {}, getElementById: () => ({ innerHTML: '' }),
      body: { classList: { add() {}, remove() {} } },
      // Mini-Cookie-Speicher: wie ein Browser (Name=Wert, max-age=0 löscht)
      get cookie() { return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '); },
      set cookie(str) {
        if (cookieBlocked) throw new Error('Cookies gesperrt');
        const [kv, ...attrs] = str.split('; ');
        const i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1);
        if (attrs.includes('max-age=0')) { delete jar[k]; delete rawCookies[k]; } else { jar[k] = v; rawCookies[k] = str; }
      }
    },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`
    const nameInput = { value: ${JSON.stringify(name)} }, roomCodeInput = { value: ${JSON.stringify(code)} };
    const viewGame = { hidden: true }, viewLobby = {}, viewRoom = {}, roomCodeDisplay = {}, btnStartGame = {};
    const connBannerEl = {};
    function showError(m) { errors.push(m); } function clearError() {}
    function hideAllViews() {}
    function renderGame() {} function watchStats() {} function unwatchStats() {}
    function showRunningGameHint() {}
    function updateRunningGameHint(){}
    // isConnected/roomSynced liefert firebase.js selbst (Transaktions-Voraussetzungen)
`, ctx);
  ['config.js', 'firebase.js', 'game.js'].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  vm.runInContext('enterRoom = (c) => { entered.push(c); roomSynced = Promise.resolve(true); }', ctx);
  return { ctx, errors, entered, authLog, jar, rawCookies, run: (code) => vm.runInContext(code, ctx) };
}

// Legt einen Raum mit n Spielern (p1..pn) in der Lobby an
function lobbyRoom(n) {
  const players = {};
  for (let i = 1; i <= n; i++) players['p' + i] = { name: 'Spieler' + i };
  return { rooms: { ABCD: { hostId: 'p1', status: 'lobby', players } } };
}

// Laufendes Spiel mit festen Händen: hands = { p1: {empty,gold,trap}, ... }
function playingRoom(hands, game = {}) {
  const uids = Object.keys(hands);
  const players = {}, gamePlayers = {};
  uids.forEach((u, i) => {
    players[u] = { name: u };
    gamePlayers[u] = { name: u, role: i % 2 ? 'guardian' : 'adventurer', hand: hands[u], dealId: '1-1' };
  });
  return { rooms: { ABCD: {
    hostId: uids[0], status: 'playing', gamesPlayed: 1, players, gamePlayers,
    game: Object.assign({
      round: 1, gameNumber: 1, cardsPerPlayerThisRound: 5, openedThisRound: 0, turnPlayerId: uids[0],
      totalGoldFound: 0, totalTrapsFound: 0, totalGoldInGame: 99, totalTrapsInGame: 99, winner: null
    }, game)
  } } };
}

module.exports = { FakeDb, makeClient, makeBrowserClient, lobbyRoom, playingRoom };
