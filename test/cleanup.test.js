const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeDb } = require('./helpers');
const { parseConfig, runCleanup, isDeletable } = require('../functions/cleanup');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const H = 3600 * 1000;
const CFG = { enabled: true, inactiveAfterMs: 24 * H, intervalMs: 10 * 60 * 1000 };

function world(rooms, config = CFG) {
  return new FakeDb({ config: config ? { roomCleanup: { ...config } } : {}, rooms });
}
const codes = (db) => Object.keys(db.data.rooms || {}).sort();
const old = NOW - 48 * H, fresh = NOW - 1 * H;

test('parseConfig: nur eine vollständige, gültige und eingeschaltete Konfiguration ist aktiv', () => {
  assert.deepEqual(parseConfig(CFG), { inactiveAfterMs: 24 * H, intervalMs: 600000 });
  [null, undefined, {}, { ...CFG, enabled: false }, { ...CFG, enabled: 'true' }, { ...CFG, enabled: 1 },
    { ...CFG, inactiveAfterMs: undefined }, { ...CFG, intervalMs: undefined },
    { ...CFG, inactiveAfterMs: 0 }, { ...CFG, inactiveAfterMs: -5 }, { ...CFG, inactiveAfterMs: '86400000' },
    { ...CFG, intervalMs: NaN }, { ...CFG, intervalMs: Infinity }, { enabled: true }
  ].forEach((bad) => assert.equal(parseConfig(bad), null, JSON.stringify(bad)));
});

test('Deaktiviert oder Konfiguration fehlt/unvollständig: es wird NICHTS gelöscht', async () => {
  for (const cfg of [{ ...CFG, enabled: false }, null, { enabled: true }, { enabled: true, inactiveAfterMs: 1 }]) {
    const db = world({ A: { lastActivityAt: old }, B: { lastActivityAt: old } }, cfg);
    const r = await runCleanup(db, NOW);
    assert.equal(r.ran, false);
    assert.deepEqual(codes(db), ['A', 'B']);
  }
});

test('Alte Räume werden gelöscht, aktive und neue bleiben', async () => {
  const db = world({ ALT: { lastActivityAt: old, status: 'lobby' }, NEU: { lastActivityAt: fresh } });
  const r = await runCleanup(db, NOW);
  assert.deepEqual(r.deleted, ['ALT']);
  assert.deepEqual(codes(db), ['NEU']);
});

test('Geschützte Räume werden NIE gelöscht, egal wie alt', async () => {
  const db = world({ VIP: { lastActivityAt: 1, createdAt: 1, protected: true }, ALT: { lastActivityAt: old } });
  await runCleanup(db, NOW);
  assert.deepEqual(codes(db), ['VIP']);
  assert.equal(db.data.rooms.VIP.protected, true);
  assert.equal(isDeletable({ protected: true, lastActivityAt: 1 }, NOW, 1), false);
  assert.equal(isDeletable({ protected: 'true', lastActivityAt: 1 }, NOW, 1), true, 'nur echtes true schützt - deshalb in der Console als Boolean setzen');
});

test('Raum mit anwesendem Spieler (aktueller Herzschlag) wird nicht gelöscht, auch wenn lastActivityAt alt ist', async () => {
  const db = world({ LIVE: { lastActivityAt: old, players: { p1: { name: 'A', lastSeen: NOW - 5000 } } } });
  await runCleanup(db, NOW);
  assert.deepEqual(codes(db), ['LIVE']);
});

test('Laufende Partie mit kürzlicher Aktivität bleibt; verlassene Partie wird irgendwann gelöscht', async () => {
  const db = world({
    LAUFT: { status: 'playing', lastActivityAt: NOW - 2 * H, game: { round: 2 }, players: { p1: { name: 'A' } } },
    VERLASSEN: { status: 'playing', lastActivityAt: old, game: { round: 2 } }
  });
  await runCleanup(db, NOW);
  assert.deepEqual(codes(db), ['LAUFT']);
});

test('Altbestand ohne lastActivityAt wird nicht sofort gelöscht, sondern bekommt eine Uhr', async () => {
  const db = world({ LEGACY: { createdAt: old, stats: { a: { games: 5 } } } });
  const r = await runCleanup(db, NOW);
  assert.equal(r.stamped, 1);
  assert.deepEqual(codes(db), ['LEGACY']);
  assert.equal(db.data.rooms.LEGACY.lastActivityAt, NOW);
  assert.ok(db.data.rooms.LEGACY.stats, 'Statistik bleibt erhalten');
  // erst nach Ablauf der Inaktivität wird er wirklich gelöscht
  db.data.config.roomCleanup.lastRunAt = 0;
  await runCleanup(db, NOW + 25 * H);
  assert.deepEqual(codes(db), []);
});

test('Intervall: ein zweiter Lauf innerhalb von intervalMs tut nichts', async () => {
  const db = world({ A: { lastActivityAt: old } });
  assert.equal((await runCleanup(db, NOW)).ran, true);
  db._set('rooms/B', { lastActivityAt: old });
  const second = await runCleanup(db, NOW + 60000);
  assert.equal(second.ran, false);
  assert.deepEqual(codes(db), ['B']);
  assert.equal((await runCleanup(db, NOW + CFG.intervalMs + 1)).ran, true);
  assert.deepEqual(codes(db), []);
});

test('Parallele Instanzen: pro Intervall läuft genau eine Bereinigung', async () => {
  const db = world({ A: { lastActivityAt: old }, B: { lastActivityAt: old } });
  const results = await Promise.all([runCleanup(db, NOW), runCleanup(db, NOW), runCleanup(db, NOW)]);
  assert.equal(results.filter((r) => r.ran).length, 1);
  assert.deepEqual(codes(db), []);
});

test('Raum wird zwischen Abfrage und Löschen wieder aktiv: bleibt erhalten', async () => {
  const db = world({ RACE: { lastActivityAt: old } });
  db.afterQuery = async () => { db._set('rooms/RACE/lastActivityAt', NOW - 1000); }; // jemand spielt plötzlich
  const r = await runCleanup(db, NOW);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(codes(db), ['RACE']);
});

test('Raum wird zwischen Abfrage und Löschen geschützt: bleibt erhalten', async () => {
  const db = world({ RACE: { lastActivityAt: old } });
  db.afterQuery = async () => { db._set('rooms/RACE/protected', true); };
  await runCleanup(db, NOW);
  assert.deepEqual(codes(db), ['RACE']);
});

test('Fehler bei einem Raum (Verbindungsabbruch) stoppt die übrigen nicht', async () => {
  const db = world({ A: { lastActivityAt: old }, B: { lastActivityAt: old } });
  db.failTransaction = (p) => p === 'rooms/A';
  const log = console.error; console.error = () => {};
  const r = await runCleanup(db, NOW);
  console.error = log;
  assert.deepEqual(r.deleted, ['B']);
  assert.deepEqual(codes(db), ['A']);
});

test('Zeitzonenunabhängig: nur Unix-Millisekunden zählen', async () => {
  const db = world({ A: { lastActivityAt: NOW - 24 * H - 1 }, B: { lastActivityAt: NOW - 24 * H + 1000 } });
  await runCleanup(db, NOW);
  assert.deepEqual(codes(db), ['B']);
});

test('Keine Räume vorhanden: Lauf ist harmlos', async () => {
  const db = new FakeDb({ config: { roomCleanup: { ...CFG } } });
  assert.equal((await runCleanup(db, NOW)).ran, true);
});
