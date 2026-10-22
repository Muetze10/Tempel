const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeDb, makeBrowserClient, lobbyRoom, playingRoom } = require('./helpers');

const room = (db) => db.data.rooms.ABCD;
const H = (e, g, t) => ({ empty: e, gold: g, trap: t });

test('Registrierter Spieler kann während "starting" wieder beitreten, Spielzustand bleibt unberührt', async () => {
  const db = new FakeDb(lobbyRoom(4));
  Object.assign(room(db), { status: 'starting', startingAt: Date.now() });
  const before = JSON.stringify({ s: room(db).status, g: room(db).game, gp: room(db).gamePlayers, a: room(db).startingAt });
  const c = makeBrowserClient(db, 'p2', { name: 'Neuer Name' });
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, ['ABCD']);
  assert.deepEqual(c.errors, []);
  assert.equal(room(db).players.p2.name, 'Neuer Name');
  assert.equal(JSON.stringify({ s: room(db).status, g: room(db).game, gp: room(db).gamePlayers, a: room(db).startingAt }), before);
});

test('Unbekannte Person wird während "starting" abgewiesen', async () => {
  const db = new FakeDb(lobbyRoom(3));
  Object.assign(room(db), { status: 'starting', startingAt: Date.now() });
  const c = makeBrowserClient(db, 'fremd');
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, []);
  assert.match(c.errors[0], /gestartet/);
  assert.equal(room(db).players.fremd, undefined);
});

test('Leerer Raum in "starting": der entstehende Spielzustand wird NICHT zurückgesetzt', async () => {
  const db = new FakeDb(lobbyRoom(3));
  Object.assign(room(db), { status: 'starting', startingAt: Date.now(), players: {}, game: { gameNumber: 1 } });
  const c = makeBrowserClient(db, 'p1');
  await c.run('handleJoinRoom()');
  assert.deepEqual(room(db).game, { gameNumber: 1 });
  assert.equal(room(db).status, 'starting');
});

test('Wiederbeitritt mitten im Spiel (nach Reload): gleiche Identität, Spiel bleibt unverändert', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) }));
  delete room(db).players.p2; // p2 wurde als "weg" entfernt
  const gpBefore = JSON.stringify(room(db).gamePlayers), gBefore = JSON.stringify(room(db).game);
  const c = makeBrowserClient(db, 'p2');
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, ['ABCD']);
  assert.ok(room(db).players.p2);
  assert.equal(JSON.stringify(room(db).gamePlayers), gpBefore);
  assert.equal(JSON.stringify(room(db).game), gBefore);
});

test('Fremder kann in ein laufendes Spiel einsteigen – landet im Warteraum und wartet', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) }));
  const c = makeBrowserClient(db, 'fremd');
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, ['ABCD']);
  assert.deepEqual(c.errors, []);
  // Er ist im Warteraum dabei (players), aber NICHT im laufenden Spiel.
  assert.ok(room(db).players.fremd);
  assert.equal(room(db).gamePlayers.fremd, undefined);
  assert.equal(room(db).status, 'playing');
});

test('Raum mit 10 Spielern ist voll; ein bereits registrierter Spieler kommt trotzdem wieder rein', async () => {
  const db = new FakeDb(lobbyRoom(10));
  const neu = makeBrowserClient(db, 'neu');
  await neu.run('handleJoinRoom()');
  assert.match(neu.errors[0], /voll/);
  const alt = makeBrowserClient(db, 'p5');
  await alt.run('handleJoinRoom()');
  assert.deepEqual(alt.entered, ['ABCD']);
});

test('Beitritt aktualisiert lastActivityAt; Neuer Spieler wird mit joinedAt angelegt', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeBrowserClient(db, 'neu', { name: 'Neu' });
  await c.run('handleJoinRoom()');
  await new Promise((r) => setTimeout(r, 10)); // lastActivityAt wird ohne await geschrieben
  assert.ok(room(db).lastActivityAt > 0);
  assert.ok(room(db).players.neu.joinedAt > 0);
});

test('Raum erstellen: Code ist frei, lastActivityAt gesetzt, bestehende Räume bleiben', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeBrowserClient(db, 'host', { name: 'Host' });
  await c.run('handleCreateRoom()');
  const codes = Object.keys(db.data.rooms);
  assert.equal(codes.length, 2);
  const created = codes.find((k) => k !== 'ABCD');
  assert.ok(db.data.rooms[created].lastActivityAt > 0);
  assert.equal(db.data.rooms[created].hostId, 'host');
  assert.ok(db.data.rooms.ABCD.players.p1);
});

// ---------- Cookies & Auth-Persistenz ----------
test('Auth: Persistenz wird VOR der anonymen Anmeldung auf LOCAL gesetzt', async () => {
  const c = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'p1');
  await c.run('authReady');
  assert.deepEqual(c.authLog, ['persist:local', 'signin']);
  assert.equal(c.run('playerId'), 'p1');
});

test('Auth: scheitert die Persistenz, wird trotzdem angemeldet', async () => {
  const c = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'p1', { persistenceFails: true });
  await c.run('authReady');
  assert.deepEqual(c.authLog, ['persist:local', 'signin']);
  assert.equal(c.run('playerId'), 'p1');
});

test('Beitritt merkt Name und Raum-Code als Cookie; loadProfileCookies liefert sie zurück', async () => {
  const c = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'neu', { name: 'Lukas Ö', code: 'abcd' });
  await c.run('handleJoinRoom()');
  assert.equal(c.jar.tds_name, encodeURIComponent('Lukas Ö'));
  assert.equal(c.jar.tds_room, 'ABCD');
  assert.deepEqual(JSON.parse(c.run('JSON.stringify(loadProfileCookies())')), { name: 'Lukas Ö', room: 'ABCD' });
});

test('Raum erstellen merkt Name und den NEUEN Raum-Code', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeBrowserClient(db, 'host', { name: 'Host' });
  await c.run('handleCreateRoom()');
  const created = Object.keys(db.data.rooms).find((k) => k !== 'ABCD');
  assert.equal(c.jar.tds_room, created);
  assert.equal(c.jar.tds_name, 'Host');
});

test('Cookie-Eigenschaften: ein Jahr, SameSite=Lax, KEINE Spieler-ID/uid im Cookie', async () => {
  const c = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'geheime-uid-123', { name: 'Max' });
  await c.run('handleJoinRoom()');
  Object.values(c.rawCookies).forEach((raw) => {
    assert.match(raw, /max-age=31536000/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /path=\//);
  });
  assert.ok(!Object.values(c.jar).concat(Object.keys(c.jar)).some((x) => String(x).includes('geheime-uid-123')));
});

test('Fehlgeschlagener Beitritt merkt nichts', async () => {
  const c = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'neu', { code: 'ZZZZ' });
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.jar, {});
});

test('Gemerkte Werte werden bereinigt (Name max. 20, Code nur A-Z/0-9, max. 6)', () => {
  const c = makeBrowserClient(new FakeDb(), 'p1', { cookies: {
    tds_name: encodeURIComponent('x'.repeat(50)), tds_room: encodeURIComponent('ab-c<d>12!x9') } });
  const p = JSON.parse(c.run('JSON.stringify(loadProfileCookies())'));
  assert.equal(p.name.length, 20);
  assert.equal(p.room, 'ABCD12');
});

test('Ohne Cookies/kaputte Cookies funktioniert alles weiter', async () => {
  const blocked = makeBrowserClient(new FakeDb(lobbyRoom(3)), 'neu', { cookieBlocked: true });
  await blocked.run('handleJoinRoom()');
  assert.deepEqual(blocked.entered, ['ABCD']);
  assert.deepEqual(blocked.errors, []);
  const broken = makeBrowserClient(new FakeDb(), 'p1', { cookies: { tds_name: '%E0%A4%A' } }); // ungültiges Encoding
  assert.deepEqual(JSON.parse(broken.run('JSON.stringify(loadProfileCookies())')), { name: '', room: '' });
});

test('Raum bewusst verlassen: Raum-Code-Cookie wird gelöscht, Name bleibt', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeBrowserClient(db, 'p2', { name: 'Anna' });
  await c.run('handleJoinRoom()');
  c.run("currentRoomCode = 'ABCD'");
  await c.run('leaveRoom()');
  assert.equal(c.jar.tds_room, undefined);
  assert.equal(c.jar.tds_name, 'Anna');
});

test('Toter Raum wird beim Beitreten wiederbelebt (auch mit Stale-Einträgen in players)', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) }));
  // Alle "player"-Einträge existieren noch (wie nach Abstürzen), aber die
  // lastSeen-Werte sind uralt -> niemand ist wirklich da.
  Object.values(room(db).players).forEach((p) => { p.lastSeen = Date.now() - 120000; });
  const c = makeBrowserClient(db, 'fremd');
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, ['ABCD']);
  assert.deepEqual(c.errors, []);
  assert.equal(room(db).status, 'lobby');
  assert.ok(!room(db).game);
  assert.ok(!room(db).gamePlayers);
});

test('Frisch anwesender Spieler verhindert die Wiederbelebung (Beitritt wartet normal)', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) }));
  Object.values(room(db).players).forEach((p, i) => {
    p.lastSeen = i === 0 ? Date.now() : Date.now() - 120000; // p1 noch da
  });
  const c = makeBrowserClient(db, 'fremd');
  await c.run('handleJoinRoom()');
  assert.deepEqual(c.entered, ['ABCD']);
  assert.equal(room(db).status, 'playing'); // Spiel läuft und bleibt
});

test('Neue Raum-Codes sind 6-stellig und ohne verwechselbare Zeichen', async () => {
  const db = new FakeDb();
  const c = makeBrowserClient(db, 'host', { name: 'Host' });
  await c.run('handleCreateRoom()');
  const code = Object.keys(db.data.rooms)[0];
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/); // ohne I, O, 0, 1
});
