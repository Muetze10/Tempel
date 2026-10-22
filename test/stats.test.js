const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeDb, makeClient, playingRoom } = require('./helpers');

const H = (e, g, t) => ({ empty: e, gold: g, trap: t });
const room = (db) => db.data.rooms.ABCD;
const files = ['config.js', 'game.js', 'stats.js'];

// Spiel, das mit dem nächsten Zug endet (Abenteurer finden das letzte Gold)
async function finishedGame() {
  const db = new FakeDb(playingRoom({ p1: H(0, 0, 0), p2: H(0, 1, 0), p3: H(2, 0, 0) }, { totalGoldInGame: 1 }));
  const c = makeClient(db, 'p1', { files }); c.sync();
  await c.run('revealCard("p2")');
  return db;
}

test('Spielende und Statistik-Vormerkung entstehen im selben atomaren Schritt', async () => {
  const db = await finishedGame();
  assert.equal(room(db).status, 'ended');
  const pend = room(db).statsPending.g1;
  assert.equal(pend.winner, 'adventurer');
  assert.equal(Object.keys(pend.players).length, 3);
  assert.equal(pend.players.p2.gold, 1);
  assert.equal(room(db).stats, undefined, 'verbucht wird erst danach (wiederaufnehmbar)');
});

test('Alle Clients verbuchen gleichzeitig: jedes Spiel zählt genau einmal, Vormerkung verschwindet', async () => {
  const db = await finishedGame();
  await Promise.all(['p1', 'p2', 'p3'].map((u) => makeClient(db, u, { files }).run('processPendingStats()')));
  const s = room(db).stats;
  assert.deepEqual(Object.values(s).map((x) => x.games), [1, 1, 1]);
  assert.equal(s.p2.gold, 1);
  assert.equal(Object.values(s).reduce((a, x) => a + x.wins, 0), 2); // p1 + p3 sind Abenteurer
  assert.equal(room(db).statsPending, undefined);
});

test('Verbindungsabbruch mitten in der Verbuchung: Wiederaufnahme zählt weder doppelt noch gar nicht', async () => {
  const db = await finishedGame();
  db.failTransaction = (path) => path.endsWith('stats/p2'); // genau dieser Spieler scheitert
  const c = makeClient(db, 'p1', { files });
  await assert.rejects(c.run('processPendingStats()'));
  assert.ok(room(db).statsPending.g1, 'Vormerkung bleibt, weil nicht alles verbucht wurde');
  assert.equal(room(db).stats.p1.games, 1, 'bereits Verbuchte sind drin');
  assert.equal(room(db).stats.p2, undefined);

  db.failTransaction = null;
  // "nach Reload": ein frischer Client im neuen Scope macht weiter
  await makeClient(db, 'p3', { files }).run('processPendingStats()');
  await makeClient(db, 'p2', { files }).run('processPendingStats()'); // und nochmal: darf nichts ändern
  assert.deepEqual(['p1', 'p2', 'p3'].map((u) => room(db).stats[u].games), [1, 1, 1]);
  assert.equal(room(db).statsPending, undefined);
});

test('Abbruch NACH Verbuchung, VOR dem Löschen der Vormerkung: erneuter Lauf zählt nichts doppelt', async () => {
  const db = await finishedGame();
  const c = makeClient(db, 'p1', { files });
  const realRef = db.ref.bind(db);
  db.ref = (p) => { const r = realRef(p); if (p.includes('statsPending/')) r.remove = async () => { throw new Error('weg'); }; return r; };
  await assert.rejects(c.run('processPendingStats()'));
  db.ref = realRef;
  assert.ok(room(db).statsPending.g1);
  await makeClient(db, 'p2', { files }).run('processPendingStats()');
  assert.deepEqual(['p1', 'p2', 'p3'].map((u) => room(db).stats[u].games), [1, 1, 1]);
  assert.equal(room(db).statsPending, undefined);
});

test('Mehrere Spiele nacheinander: jedes wird einmal gezählt, auch bei Nachholen in anderer Reihenfolge', async () => {
  const db = new FakeDb(playingRoom({ p1: H(1, 0, 0) }));
  room(db).statsPending = {
    g2: { winner: 'guardian', players: { p1: { name: 'Anna', role: 'adventurer', traps: 1, gold: 0 } } },
    g1: { winner: 'adventurer', players: { p1: { name: 'anna', role: 'adventurer', traps: 0, gold: 2 } } }
  };
  const c = makeClient(db, 'p1', { files });
  await c.run('processPendingStats()'); await c.run('processPendingStats()');
  const s = room(db).stats.anna;
  assert.equal(s.games, 2); assert.equal(s.wins, 1); assert.equal(s.losses, 1);
  assert.equal(s.gold, 2); assert.equal(s.traps, 1);
});

test('Gleicher Name bei zwei Spielern desselben Spiels: beide werden gezählt', async () => {
  const db = new FakeDb(playingRoom({ p1: H(1, 0, 0) }));
  room(db).statsPending = { g1: { winner: 'guardian', players: {
    a: { name: 'Max', role: 'guardian', traps: 0, gold: 0 }, b: { name: 'max', role: 'adventurer', traps: 0, gold: 0 } } } };
  await makeClient(db, 'p1', { files }).run('processPendingStats()');
  assert.equal(room(db).stats.max.games, 2);
  assert.equal(room(db).stats.max.wins, 1);
});

test('Nichts vorgemerkt: nichts passiert', async () => {
  const db = new FakeDb(playingRoom({ p1: H(1, 0, 0) }));
  await makeClient(db, 'p1', { files }).run('processPendingStats()');
  assert.equal(room(db).stats, undefined);
});
