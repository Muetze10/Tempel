const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeDb, makeClient, lobbyRoom, playingRoom } = require('./helpers');

const room = (db) => db.data.rooms.ABCD;
const sum = (h) => h.empty + h.gold + h.trap;
const H = (empty, gold, trap) => ({ empty, gold, trap });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const roleCount = (r, role) => Object.values(r.gamePlayers).filter((p) => p.role === role).length;
const cards = (r) => Object.values(r.gamePlayers).reduce((s, p) => s + sum(p.hand), 0);

// ---------- Konfiguration / Rollenverteilung ----------
// Der Rollenpool ist BEWUSST bei manchen Spielerzahlen um eine Rolle größer als n:
// n Rollen werden gezogen, eine bleibt unbenutzt (verschleiert die echte Verteilung).
test('ROLE_TABLE: Pool deckt jede Spielerzahl 3-10 ab (n bis n+1 Rollen), Kartenpool = 5 pro Spieler', () => {
  const c = makeClient(new FakeDb(), 'p1');
  for (let n = 3; n <= 10; n++) {
    const r = JSON.parse(c.run(`JSON.stringify(ROLE_TABLE[${n}])`));
    const pool = r.adventurer + r.guardian;
    assert.ok(pool >= n && pool <= n + 1, `Spielerzahl ${n}: Pool ${pool}`);
    const k = JSON.parse(c.run(`JSON.stringify(ROOM_TABLE[${n}])`));
    assert.equal(k.empty + k.gold + k.trap, n * 5, `Kartenpool ${n}`);
  }
});

// ---------- Spielstart ----------
for (let n = 3; n <= 10; n++) {
  test(`Start mit ${n} Spielern: jeder hat genau eine Rolle aus dem Pool, Anzeige = Pool-Verteilung`, async () => {
    for (let run = 0; run < (n === 3 || n === 10 ? 25 : 3); run++) {
      const db = new FakeDb(lobbyRoom(n));
      const c = makeClient(db, 'p1');
      await c.run('startGameInternal()');
      const r = room(db);
      assert.equal(r.status, 'playing');
      assert.equal(Object.keys(r.gamePlayers).length, n);
      Object.values(r.gamePlayers).forEach((p) => {
        assert.ok(p.role === 'adventurer' || p.role === 'guardian', 'jede Person hat eine Rolle');
        assert.equal(sum(p.hand), 5);
      });
      const pool = JSON.parse(c.run(`JSON.stringify(ROLE_TABLE[${n}])`));
      const adv = roleCount(r, 'adventurer'), gua = roleCount(r, 'guardian');
      assert.equal(adv + gua, n);
      // gezogen aus dem Pool: nie mehr als im Pool, höchstens eine Rolle bleibt übrig
      assert.ok(adv <= pool.adventurer && gua <= pool.guardian);
      assert.ok(pool.adventurer - adv + (pool.guardian - gua) <= 1);
      // angezeigt wird (gewollt) die Pool-Verteilung, nicht die echte
      assert.equal(r.game.totalAdventurers, pool.adventurer);
      assert.equal(r.game.totalGuardians, pool.guardian);
      const total = { empty: 0, gold: 0, trap: 0 };
      Object.values(r.gamePlayers).forEach((p) => ['empty', 'gold', 'trap'].forEach((k) => (total[k] += p.hand[k])));
      assert.deepEqual(total, JSON.parse(c.run(`JSON.stringify(ROOM_TABLE[${n}])`)));
      assert.ok(r.gamePlayers[r.game.turnPlayerId]);
      assert.equal(r.game.moveSeq, 0);
      assert.equal(r.startingAt, undefined, 'Start-Lock ist wieder frei');
    }
  });
}

test('Mit 3 Spielern kommen beide Rollen-Ergebnisse vor (Pool 2+2 wird wirklich gezogen)', async () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const db = new FakeDb(lobbyRoom(3));
    await makeClient(db, 'p1').run('startGameInternal()');
    seen.add(roleCount(room(db), 'guardian'));
  }
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test('Zu kleiner Rollenpool: Start bricht ab, niemand bekommt "undefined" als Rolle', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeClient(db, 'p1');
  c.run('ROLE_TABLE[3] = { adventurer: 1, guardian: 1 }');
  const log = console.error; console.error = () => {};
  await c.run('startGameInternal()');
  console.error = log;
  assert.equal(room(db).status, 'lobby');
  assert.equal(room(db).gamePlayers, undefined);
});

test('Zwei Clients starten gleichzeitig: nur EIN Spiel entsteht', async () => {
  const db = new FakeDb(lobbyRoom(4));
  await Promise.all([makeClient(db, 'p1').run('startGameInternal()'), makeClient(db, 'p2').run('startGameInternal()')]);
  assert.equal(room(db).gamesPlayed, 1);
  assert.equal(room(db).game.gameNumber, 1);
});

test('Start mit nur 2 Spielern: Lobby-Status wird wieder freigegeben', async () => {
  const db = new FakeDb(lobbyRoom(2));
  const c = makeClient(db, 'p1');
  await c.run('startGameInternal()');
  assert.equal(room(db).status, 'lobby');
  assert.equal(room(db).startingAt, undefined);
  assert.equal(c.alerts.list.join(' ').includes('3 bis 10 Spieler'), true);
});

test('Start scheitert (Netzwerkfehler): Raum bleibt NICHT in "starting" hängen', async () => {
  const db = new FakeDb(lobbyRoom(4));
  const c = makeClient(db, 'p1');
  db.failGet = true;
  await c.run('startGameInternal()').catch(() => {});
  db.failGet = false;
  assert.equal(room(db).status, 'lobby');
});

test('Starter stürzt nach dem Lock ab: recoverStuckStart gibt den Raum erst nach Wartezeit frei', async () => {
  const db = new FakeDb(lobbyRoom(4));
  Object.assign(room(db), { status: 'starting', startingAt: Date.now() }); // Start läuft gerade
  const c = makeClient(db, 'p2');
  assert.equal(await c.run('recoverStuckStart()'), false, 'laufender Start wird nicht gestört');
  assert.equal(room(db).status, 'starting');
  room(db).startingAt = Date.now() - 60000; // Starter ist seit 60 s weg
  assert.equal(await c.run('recoverStuckStart()'), true);
  assert.equal(room(db).status, 'lobby');
  delete room(db).game; Object.assign(room(db), { status: 'starting' }); // Altlast ohne Zeitstempel
  assert.equal(await c.run('recoverStuckStart()'), true);
});

// ---------- Kartenaufdeckung / parallele Züge ----------
test('Nur der Schlüsselinhaber darf aufdecken', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const c = makeClient(db, 'p2'); c.sync();
  await c.run('revealCard("p3")');
  assert.equal(room(db).game.openedThisRound, 0);
  assert.equal(room(db).game.turnPlayerId, 'p1');
});

test('Eigene Karten und leere Hände sind keine gültigen Ziele', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(0, 0, 0), p3: H(5, 0, 0) }));
  const c = makeClient(db, 'p1'); c.sync();
  await c.run('revealCard("p1")');
  await c.run('revealCard("p2")');
  assert.equal(room(db).game.moveSeq || 0, 0);
  assert.equal(room(db).game.turnPlayerId, 'p1');
});

test('Doppelklick: es wird genau eine Karte aufgedeckt', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const c = makeClient(db, 'p1'); c.sync();
  await Promise.all([c.run('revealCard("p2")'), c.run('revealCard("p2")')]);
  assert.equal(room(db).game.openedThisRound, 1);
  assert.equal(sum(room(db).gamePlayers.p2.hand), 4);
  assert.equal(room(db).game.turnPlayerId, 'p2');
});

test('Parallel: zwei Tabs DERSELBEN Person decken gleichzeitig verschiedene Ziele auf -> nur ein Zug', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const tabA = makeClient(db, 'p1'), tabB = makeClient(db, 'p1'); // getrennte Scopes: lokale Sperre hilft nicht
  tabA.sync(); tabB.sync();
  await Promise.all([tabA.run('revealCard("p2")'), tabB.run('revealCard("p3")')]);
  assert.equal(room(db).game.openedThisRound, 1);
  assert.equal(cards(room(db)), 15 - 1);
  assert.equal(room(db).game.moveSeq, 1);
});

test('Veraltete Ansicht (Zugnummer): Klick wird abgelehnt, auch wenn der Schlüssel wieder bei mir ist', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const stale = makeClient(db, 'p1'); stale.sync(); // sieht moveSeq 0
  room(db).game.moveSeq = 4; // inzwischen ist viel passiert ... und p1 hat den Schlüssel wieder
  await stale.run('revealCard("p2")');
  assert.equal(room(db).game.openedThisRound, 0);
  assert.equal(room(db).game.moveSeq, 4);
  assert.equal(sum(room(db).gamePlayers.p2.hand), 5);
});

test('Nach dem letzten Zug einer Runde ist bis zur Folgeaktion KEIN weiterer Zug möglich', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) },
    { openedThisRound: 2, totalGoldInGame: 9, totalTrapsInGame: 3 }));
  const a = makeClient(db, 'p1'); a.sync();
  const b = makeClient(db, 'p2'); // neuer Schlüsselinhaber
  let snapshotBefore, snapshotAfter;
  a.hooks[1800] = async () => { // Pause nach dem Aufdecken, Folgeaktion noch offen
    b.sync(); snapshotBefore = JSON.stringify(room(db).gamePlayers);
    await b.run('revealCard("p3")');
    snapshotAfter = JSON.stringify(room(db).gamePlayers);
  };
  await a.run('revealCard("p2")');
  assert.equal(snapshotBefore, snapshotAfter, 'während die Folgeaktion offen ist, ändert sich nichts');
  assert.equal(room(db).game.round, 2);
});

// ---------- Siegbedingungen / Rundenwechsel ----------
async function lastMove(handsOrDb, game, target = 'p2') {
  const db = new FakeDb(playingRoom(handsOrDb, game));
  const c = makeClient(db, 'p1'); c.sync();
  await c.run(`revealCard("${target}")`);
  return db;
}

test('Letztes Gold gefunden: Abenteurer gewinnen', async () => {
  const db = await lastMove({ p1: H(0, 0, 0), p2: H(0, 1, 0), p3: H(2, 0, 0) }, { totalGoldInGame: 1, totalTrapsInGame: 2 });
  assert.equal(room(db).game.winner, 'adventurer');
  assert.equal(room(db).status, 'ended');
});

test('Letzte Falle gefunden: Wächterinnen gewinnen', async () => {
  const db = await lastMove({ p1: H(1, 0, 0), p2: H(0, 0, 1), p3: H(2, 0, 0) }, { totalGoldInGame: 5, totalTrapsInGame: 1 });
  assert.equal(room(db).game.winner, 'guardian');
});

test('Runde 4: letzte Karte ist zugleich letztes Gold -> Abenteurer siegen', async () => {
  const db = await lastMove({ p1: H(1, 0, 0), p2: H(0, 1, 0), p3: H(1, 0, 0) },
    { round: 4, cardsPerPlayerThisRound: 2, openedThisRound: 2, totalGoldInGame: 1 });
  assert.equal(room(db).game.winner, 'adventurer');
});

test('Runde 4 ohne Gold-/Fallen-Sieg: Wächterinnen siegen', async () => {
  const db = await lastMove({ p1: H(1, 0, 0), p2: H(1, 0, 0), p3: H(1, 0, 0) },
    { round: 4, cardsPerPlayerThisRound: 2, openedThisRound: 2, totalGoldInGame: 5, totalTrapsInGame: 2 });
  assert.equal(room(db).game.winner, 'guardian');
});

test('Rundenwechsel: keine Karte geht verloren, eine weniger pro Spieler, Schlüssel beim Ziel', async () => {
  const db = await lastMove({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) }, { openedThisRound: 2, totalGoldInGame: 9, totalTrapsInGame: 3 });
  const r = room(db);
  assert.equal(r.game.round, 2);
  assert.equal(r.game.openedThisRound, 0);
  assert.equal(r.game.turnPlayerId, 'p2');
  assert.deepEqual(Object.values(r.gamePlayers).map((p) => sum(p.hand)), [3, 3, 3]);
  assert.equal(cards(r), 9);
  assert.equal(r.game.followUp, undefined);
  assert.equal(r.game.revealPending, undefined);
});

test('Wer vor dem Rundenwechsel ging, scheidet aus; seine Karten bleiben im Umlauf', async () => {
  const hands = { p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1), p4: H(3, 1, 0) };
  const db = new FakeDb(playingRoom(hands, { openedThisRound: 3, totalGoldInGame: 9, totalTrapsInGame: 3 }));
  delete room(db).players.p4; // p4 hat den Raum verlassen
  const c = makeClient(db, 'p1'); c.sync();
  await c.run('revealCard("p2")');
  assert.equal(room(db).gamePlayers.p4, undefined);
  assert.equal(cards(room(db)), 16 - 1);
});

test('Nur noch ein Spieler anwesend beim Rundenwechsel: Spiel endet geordnet (mit Statistik-Vormerkung)', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) },
    { openedThisRound: 2, totalGoldInGame: 9, totalTrapsInGame: 3 }));
  delete room(db).players.p2; delete room(db).players.p3;
  const c = makeClient(db, 'p1'); c.sync();
  await c.run('revealCard("p2")');
  assert.equal(room(db).status, 'ended');
  assert.ok(room(db).statsPending.g1);
});

// ---------- Übersprungene Züge / Verbindungsabbrüche ----------
test('Ein Zug ist EIN Schritt: Karte liegt offen und der Schlüssel ist beim Ziel, ohne Zwischenzustand', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const c = makeClient(db, 'p1'); c.sync();
  let seenMidway = null;
  c.hooks[1800] = () => { seenMidway = JSON.parse(JSON.stringify(room(db).game)); }; // Stand direkt nach dem Zug
  await c.run('revealCard("p2")');
  assert.equal(seenMidway.turnPlayerId, 'p2');
  assert.equal(Object.keys(seenMidway.revealLog).length, 1);
  assert.equal(seenMidway.revealPending, undefined);
  assert.equal(seenMidway.moveSeq, 1);
  assert.equal(sum(room(db).gamePlayers.p2.hand), 4);
});

test('Übersprungener Zug: ein Klick auf die alte Ansicht ändert weder Karten noch Zähler', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const stale = makeClient(db, 'p1'); stale.sync(); // sieht noch Zug 0 mit sich als Schlüsselinhaber
  delete room(db).players.p1; // p1 galt als weg ...
  const host = makeClient(db, 'p3'); host.sync();
  assert.equal(await host.run('skipAbsentTurn()'), true); // ... der Host hat übersprungen (Zug 1)
  const before = JSON.stringify(room(db).gamePlayers);
  await stale.run('revealCard("p3")'); // verspäteter Klick
  const r = room(db);
  assert.equal(JSON.stringify(r.gamePlayers), before);
  assert.equal(r.game.openedThisRound, 0);
  assert.equal(r.game.totalGoldFound + r.game.totalTrapsFound, 0);
  assert.equal(Object.keys(r.game.revealLog || {}).length, 0);
  assert.equal(r.game.moveSeq, 1);
});

test('Skip ist nur erlaubt, wenn der Schlüsselinhaber weg ist', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  const host = makeClient(db, 'p3'); host.sync();
  assert.equal(await host.run('skipAbsentTurn()'), false);
  assert.equal(room(db).game.turnPlayerId, 'p1');
  delete room(db).players.p1; host.sync(); // Schlüsselinhaber geht
  assert.equal(await host.run('skipAbsentTurn()'), true);
  assert.ok(['p2', 'p3'].includes(room(db).game.turnPlayerId));
  assert.equal(room(db).game.moveSeq, 1);
});

test('Skip mit veralteter Zugnummer wird abgelehnt', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  delete room(db).players.p1;
  const host = makeClient(db, 'p3'); host.sync();
  room(db).game.moveSeq = 7; // inzwischen hat jemand anderes schon gehandelt
  assert.equal(await host.run('skipAbsentTurn()'), false);
});

test('Aufdecker stirbt VOR der Folgeaktion: applyFollowUp macht weiter, auch bei gleichzeitigem Aufruf nur einmal', async () => {
  const db = new FakeDb(playingRoom({ p1: H(3, 1, 0), p2: H(3, 1, 0), p3: H(3, 0, 1) },
    { openedThisRound: 2, totalGoldInGame: 9, totalTrapsInGame: 3 }));
  const dead = makeClient(db, 'p1'); dead.sync();
  dead.hooks[1800] = 'crash';
  dead.run('revealCard("p2")');
  await wait();
  assert.equal(room(db).game.round, 1, 'ohne Eingreifen blockiert');
  assert.ok(room(db).game.followUp);
  await Promise.all(['p2', 'p3'].map((u) => makeClient(db, u).run('applyFollowUp()')));
  assert.equal(room(db).game.round, 2);
  await makeClient(db, 'p3').run('applyFollowUp()');
  assert.equal(room(db).game.round, 2);
  assert.equal(cards(room(db)), 9);
});

test('Spielende wird bei Ausfall des Aufdeckers ebenfalls vom Host abgeschlossen', async () => {
  const db = new FakeDb(playingRoom({ p1: H(0, 0, 0), p2: H(0, 1, 0), p3: H(2, 0, 0) }, { totalGoldInGame: 1 }));
  const dead = makeClient(db, 'p1'); dead.sync();
  dead.hooks[1800] = 'crash';
  dead.run('revealCard("p2")');
  await wait();
  assert.equal(room(db).status, 'playing');
  await makeClient(db, 'p3').run('applyFollowUp()');
  assert.equal(room(db).status, 'ended');
  assert.equal(room(db).game.winner, 'adventurer');
});

// ---------- Abstimmung ----------
test('Stimmen abwesender Spieler zählen nicht (Geister-Stimmen)', async () => {
  const c = makeClient(new FakeDb(lobbyRoom(4)), 'p1');
  c.set('latestPlayers', { p1: {}, p2: {}, p3: {} });
  c.set('latestVotes', { p1: true, p2: true, ghost: true });
  assert.equal(c.run('countReadyVotes()'), 2);
});

test('Aktivität: Start, Zug und Stimme aktualisieren lastActivityAt', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeClient(db, 'p1'); c.sync();
  await c.run('handleToggleReady()');
  assert.ok(room(db).lastActivityAt > 0);
  delete room(db).lastActivityAt;
  await c.run('startGameInternal()');
  assert.ok(room(db).lastActivityAt > 0);
  delete room(db).lastActivityAt;
  const holder = makeClient(db, room(db).game.turnPlayerId); holder.sync();
  await holder.run(`revealCard("${Object.keys(room(db).gamePlayers).find((u) => u !== room(db).game.turnPlayerId)}")`);
  assert.ok(room(db).lastActivityAt > 0);
});

// ---------- Geister: Auto-Skip, Unterbesetzung, tote Räume ----------
test('Auto-Skip (ohne Zugnummer) überspringt auch, wenn der Spielstand längst weiter ist', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  delete room(db).players.p1; // Schlüsselinhaber weg
  room(db).game.moveSeq = 7; // inzwischen ist der Stand weiter (u. a. durch andere Clients)
  const c = makeClient(db, 'p2'); c.sync(); // Client sieht noch moveSeq 0
  assert.equal(await c.run('skipGhostTurn(false)'), true); // Auto-Skip: darf trotzdem
  assert.ok(['p2', 'p3'].includes(room(db).game.turnPlayerId));
  assert.equal(room(db).game.moveSeq, 8); // ein neuer gültiger Zug
});

test('Frühe Handys mit frischem lastSeen gelten als noch da - kein Skip', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  room(db).players.p1.lastSeen = Date.now() - 10000; // erst 10 s nichts gemeldet
  const c = makeClient(db, 'p2'); c.sync();
  assert.equal(await c.run('skipGhostTurn(false)'), false);
  assert.equal(room(db).game.turnPlayerId, 'p1');
});

test('Nur noch einer anwesend: endIfUnderstaffed endet als Wächter-Sieg, ein anderer Spieler verhindert es', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  delete room(db).players.p2; delete room(db).players.p3; // nur p1 ist noch da
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('endIfUnderstaffed()'), true);
  assert.equal(room(db).status, 'ended');
  assert.equal(room(db).game.winner, 'guardian');
  assert.equal(room(db).statsPending.g1.winner, 'guardian');
});

test('Zwei anwesende Spieler: endIfUnderstaffed greift nicht ein', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(5, 0, 0) }));
  delete room(db).players.p3; // p1 + p2 da
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('endIfUnderstaffed()'), false);
  assert.equal(room(db).status, 'playing');
});

test('Toter Raum (alle lastSeen veraltet) wird von resetOrphanedRoom zurückgesetzt', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(3, 0, 1) }));
  Object.values(room(db).players).forEach((p) => { p.lastSeen = Date.now() - 90000; });
  const c = makeClient(db, 'p1'); c.sync(); // selbst ohne eigene, frische Anwesenheit
  assert.equal(await c.run('resetOrphanedRoom()'), true);
  assert.equal(room(db).status, 'lobby');
  assert.ok(!room(db).game);
  assert.ok(!room(db).gamePlayers);
});

test('Einer ist frisch da: resetOrphanedRoom setzt NICHT zurück (Game senkt sich)', async () => {
  const db = new FakeDb(playingRoom({ p1: H(5, 0, 0), p2: H(5, 0, 0), p3: H(3, 0, 1) }));
  Object.values(room(db).players).forEach((p, i) => { p.lastSeen = i === 1 ? Date.now() : Date.now() - 90000; });
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('resetOrphanedRoom()'), false);
  assert.equal(room(db).status, 'playing');
});

test('Lobby/starting-Räume rührt resetOrphanedRoom nie an', async () => {
  const db = new FakeDb(lobbyRoom(3));
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('resetOrphanedRoom()'), false);
  assert.equal(room(db).status, 'lobby');
});

// ---------- Festsitzende Runde mit nur 2 Anwesenden ----------
test('Runde mit 2 Anwesenden und vollen Geisterhänden: Auto-Skip deckt Geisterkarten auf, bis die Runde endet', async () => {
  // n0=5 (Schwelle 5 Aufdeckungen), runde 3 mit 2 Karten pro Kopf. p1+p2 sind
  // leer und allein anwesend - klassische Festsitzstelle: Schlüssel bei einem
  // Geist, niemand kann mehr auflegen. Der Skip deckt jetzt selbst auf.
  const hands = { p1: H(0, 0, 0), p2: H(0, 0, 0), p3: H(2, 0, 0), p4: H(2, 0, 0), p5: H(2, 0, 0) };
  const db = new FakeDb(playingRoom(hands, {
    round: 3, cardsPerPlayerThisRound: 2, openedThisRound: 4, turnPlayerId: 'p3',
  }));
  delete room(db).players.p3; delete room(db).players.p4; delete room(db).players.p5; // 3 Geister
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('skipGhostTurn(false)'), true);
  const after = room(db).game;
  assert.equal(after.openedThisRound, 5); // Schwelle erreicht
  assert.deepEqual(after.followUp, { type: 'nextRound' }); // Runde endet
  assert.equal(Object.keys(after.revealLog).length, 1); // 1 Geister-Aufdeckung (Vorlauf war ohne Log)
});

test('Geisterhand leer, keiner hat mehr Karten: Auto-Skip tut nichts Schlimmes', async () => {
  const hands = { p1: H(0, 0, 0), p2: H(0, 0, 0), p3: H(0, 0, 0) };
  const db = new FakeDb(playingRoom(hands, { round: 3, cardsPerPlayerThisRound: 2, openedThisRound: 2, turnPlayerId: 'p3' }));
  delete room(db).players.p3;
  const c = makeClient(db, 'p1'); c.sync();
  assert.equal(await c.run('skipGhostTurn(false)'), false); // nichts zu holen, nichts kaputt
  assert.equal(room(db).game.followUp, undefined);
});
