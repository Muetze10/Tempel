// ============================================================
// game.js – Spielregeln: Spiel starten, Zug (Schlüssel + Karte
// aufdecken), Rundenwechsel. Nutzt Variablen aus firebase.js und
// ruft renderGame() aus ui.js auf (alle Dateien teilen den Scope).
// ============================================================

let latestGame = null;
let latestGamePlayers = {};

// Hand-Animation: Jede Austeilung hat eine dealId (steht bei den Karten des
// Spielers). Neue ID = neu ausgeteilt -> Karten erst verdeckt, dann aufdecken.
let lastDealId = null;
let lastRenderedHandKey = null;

// Sperrt gegen Doppelklick/Doppel-Tap, solange ein Zug läuft
let revealInProgress = false;

// Fisher-Yates-Shuffle: mischt ein Array wirklich zufällig
function shuffleArray(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Zählt, wie oft jeder Kartentyp vorkommt
function countTypes(cards) {
  const counts = { empty: 0, gold: 0, trap: 0 };
  cards.forEach((c) => counts[c]++);
  return counts;
}

// --- Spiel starten: Rollen + Karten zufällig verteilen ---------------------
// Host-Button und Mehrheits-Abstimmung nutzen dieselbe Funktion; der
// transaction()-Lock auf den Status verhindert einen doppelten Start.
async function startGameInternal() {
  // Lock = Status "starting" + Zeitstempel in EINER Transaktion. Der Zeitstempel
  // erlaubt, einen abgestürzten Start später zurückzusetzen (recoverStuckStart).
  const locked = await roomTransaction((room) => {
    if (room.status !== 'lobby') return false;
    room.status = 'starting';
    room.startingAt = nowMs();
    return true;
  });
  if (!locked) return; // ein anderer Client startet bereits

  // FIX: scheitert das Austeilen (Netzwerk, Berechtigung), bliebe der Status
  // sonst für immer auf "starting" - niemand könnte starten oder beitreten.
  const roomRef = db.ref('rooms/' + currentRoomCode);
  try {
    await dealNewGame(roomRef);
  } catch (err) {
    console.error('Spielstart fehlgeschlagen:', err);
    await roomRef.update({ status: 'lobby', startingAt: null }).catch(() => {});
  }
}

// Setzt einen "starting"-Raum zurück, wenn der Starter abgestürzt ist (kein
// Zeitstempel = Altlast aus der Zeit vor dem Zeitstempel -> ebenfalls hängend).
async function recoverStuckStart(maxAgeMs = 20000) {
  return roomTransaction((room) => {
    if (room.status !== 'starting') return false;
    if (room.startingAt && nowMs() - room.startingAt < maxAgeMs) return false; // läuft noch
    room.status = 'lobby';
    delete room.startingAt;
    return true;
  });
}

async function dealNewGame(roomRef) {
  const [playersSnap, gamesPlayedSnap] = await Promise.all([
    roomRef.child('players').get(),
    roomRef.child('gamesPlayed').get()
  ]);
  const players = playersSnap.val() || {};
  const playerIds = Object.keys(players);
  const n = playerIds.length;

  if (n < 3 || n > 10) {
    await roomRef.update({ status: 'lobby', startingAt: null }); // Lock wieder freigeben
    alert('Tempel des Schreckens braucht 3 bis 10 Spieler.');
    return;
  }

  // Rollen-Pool zusammenstellen und mischen
  const roleCounts = ROLE_TABLE[n];
  let rolePool = [];
  for (let i = 0; i < roleCounts.adventurer; i++) rolePool.push('adventurer');
  for (let i = 0; i < roleCounts.guardian; i++) rolePool.push('guardian');
  // Pool ist gewollt ggf. größer als n: n Rollen ziehen, der Rest bleibt ungenutzt.
  // Der Pool darf aber nie KLEINER sein, sonst bekäme jemand keine Rolle.
  if (rolePool.length < n) throw new Error('Zu wenige Rollen (' + rolePool.length + ') für ' + n + ' Spieler');
  rolePool = shuffleArray(rolePool).slice(0, n);

  // Schatzkammer-Karten mischen und je 5 pro Spieler austeilen
  const roomCounts = ROOM_TABLE[n];
  let cardPool = [];
  for (let i = 0; i < roomCounts.empty; i++) cardPool.push('empty');
  for (let i = 0; i < roomCounts.gold; i++) cardPool.push('gold');
  for (let i = 0; i < roomCounts.trap; i++) cardPool.push('trap');
  cardPool = shuffleArray(cardPool);
  if (cardPool.length !== n * 5) throw new Error('Kartenpool passt nicht zu ' + n + ' Spielern');

  const gameNumber = (gamesPlayedSnap.val() || 0) + 1;
  const shuffledPlayerIds = shuffleArray(playerIds);
  const gamePlayers = {};
  shuffledPlayerIds.forEach((uid, i) => {
    gamePlayers[uid] = {
      name: (players[uid] || {}).name || '?',
      role: rolePool[i],
      hand: countTypes(cardPool.slice(i * 5, i * 5 + 5)),
      dealId: gameNumber + '-1' // Austeilung Nr. 1 dieses Spiels
    };
  });

  const startingPlayer = shuffledPlayerIds[Math.floor(Math.random() * n)];

  await roomRef.update({
    status: 'playing',
    startingAt: null,
    lastActivityAt: nowMs(),
    gamesPlayed: gameNumber,
    replayVotes: null, // Abstimmung für die nächste Runde zurücksetzen
    gamePlayers: gamePlayers,
    game: {
      round: 1,
      gameNumber: gameNumber,
      cardsPerPlayerThisRound: 5,
      openedThisRound: 0,
      moveSeq: 0, // Zugnummer: jeder Zug/Skip/Rundenwechsel zählt hoch (siehe revealCard)
      turnPlayerId: startingPlayer,
      totalGoldFound: 0,
      totalTrapsFound: 0,
      totalGoldInGame: roomCounts.gold,
      totalTrapsInGame: roomCounts.trap,
      totalAdventurers: roleCounts.adventurer, // Pool-Verteilung fuer die Anzeige beim Reveal (nicht die echte)
      totalGuardians: roleCounts.guardian,
      winner: null,
      revealLog: {}
    }
  });
}

// --- Abstimmung "Ich will (nochmal) spielen" --------------------------------
async function handleToggleReady() {
  const amReady = !!latestVotes[playerId];
  await db.ref('rooms/' + currentRoomCode).update({
    ['replayVotes/' + playerId]: !amReady,
    lastActivityAt: nowMs()
  });
}

// Startet automatisch, sobald mehr als die Hälfte zugestimmt hat - nur der
// Host löst aus, damit nicht alle Clients gleichzeitig starten wollen.
let autoStartAttempted = false;

// FIX: Stimmen von Spielern, die den Raum verlassen haben, zählen nicht mehr
// (ihre Stimme bleibt sonst in der DB und konnte den Start auslösen).
function countReadyVotes() {
  return Object.keys(latestVotes).filter((uid) => latestVotes[uid] && latestPlayers[uid]).length;
}

function checkAutoStart() {
  const n = Object.keys(latestPlayers).length;
  const ready = countReadyVotes();
  const majorityReached = n >= 3 && ready > n / 2;

  if (!majorityReached) {
    autoStartAttempted = false; // Schwelle unterschritten - nächstes Mal darf wieder gestartet werden
    return;
  }
  if (autoStartAttempted || !isHost) return;

  autoStartAttempted = true;
  startGameInternal();
}

// ============================================================
// ZÜGE - alles Spielrelevante läuft als Transaktion auf dem Raum.
// Firebase wiederholt eine Transaktion automatisch, wenn sich die Daten
// zwischenzeitlich geändert haben; geprüft wird also immer gegen den
// AKTUELLEN Stand. Lokale Sperren (revealInProgress) sind nur noch Komfort
// gegen Doppelklicks, für die Korrektheit sorgt game.moveSeq.
// ============================================================

// Server-nahe Zeit in ms (Geräteuhr + von Firebase gemeldeter Versatz)
function nowMs() {
  return Date.now() + (typeof serverOffset === 'number' ? serverOffset : 0);
}

const handSize = (h) => h.empty + h.gold + h.trap;

// Führt fn(room) atomar aus. fn ändert `room` und gibt true zurück (schreiben)
// oder false (Zug ungültig -> nichts wird geschrieben). Liefert true, wenn
// geschrieben wurde. Ist der lokale Cache noch leer (room === null), gibt
// Firebase der Funktion gleich mit den echten Daten eine zweite Chance.
async function roomTransaction(fn) {
  let valid = false;
  const res = await db.ref('rooms/' + currentRoomCode).transaction((room) => {
    valid = false;
    if (room === null) return room;
    valid = fn(room) !== false;
    return valid ? room : undefined;
  });
  return res.committed && valid;
}

// Läuft gerade ein normaler Zug? (nicht beendet, keine Folgeaktion offen)
const isMoveOpen = (room) =>
  room.status === 'playing' && room.game && room.gamePlayers && !room.game.winner && !room.game.followUp;

// --- Zug überspringen (Host-Button) -----------------------------------------
// Nur gültig, wenn der Schlüsselinhaber weg ist, und nur gegen die Zugnummer,
// die der Host gesehen hat.
async function skipAbsentTurn() {
  if (!latestGame) return;
  const expectedSeq = latestGame.moveSeq || 0;
  return roomTransaction((room) => {
    const g = room.game;
    if (!isMoveOpen(room) || (g.moveSeq || 0) !== expectedSeq) return false;
    if (room.players && room.players[g.turnPlayerId]) return false; // Inhaber ist noch da
    const candidates = Object.keys(room.gamePlayers).filter(
      (uid) => room.players && room.players[uid] && handSize(room.gamePlayers[uid].hand) > 0);
    if (candidates.length === 0) return false;
    g.turnPlayerId = candidates[Math.floor(Math.random() * candidates.length)];
    g.moveSeq = expectedSeq + 1; // ein Klick auf die alte Ansicht wird dadurch ungültig
    room.lastActivityAt = nowMs();
    return true;
  });
}

// --- Ein Zug = EIN atomarer Schritt -----------------------------------------
// Schlüssel wandert zum Ziel UND die Karte wird aufgedeckt, in derselben
// Transaktion und nur, wenn der Zug noch gültig ist (Zugnummer, Schlüsselinhaber,
// Ziel hat Karten). Es gibt keinen Zwischenzustand mehr, der hängen bleiben kann.
async function revealCard(targetUid) {
  if (revealInProgress || !latestGame) return;
  revealInProgress = true;
  renderGame(); // Karten sofort als "gesperrt" zeigen

  try {
    const expectedSeq = latestGame.moveSeq || 0; // Zustand, auf den sich der Klick bezieht
    const revealed = await roomTransaction((room) => {
      const g = room.game;
      if (!isMoveOpen(room) || g.turnPlayerId !== playerId) return false;
      if ((g.moveSeq || 0) !== expectedSeq) return false; // Klick auf veraltete Ansicht
      const target = room.gamePlayers[targetUid];
      if (targetUid === playerId || !target || handSize(target.hand) === 0) return false;
      revealOneCard(room, targetUid);
      return true;
    });
    if (!revealed) return;

    // Pause (nur Optik): alle sehen die letzte Karte, bevor eine neue Runde oder
    // der Endscreen kommt. Ist eine Folgeaktion offen, führt sie dieser Client aus -
    // fällt er aus, übernimmt der Host (ui.js).
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await applyFollowUp();
  } finally {
    revealInProgress = false;
    if (latestGame && !viewGame.hidden) renderGame(); // wieder klickbar
  }
}

// Deckt eine zufällige Karte des Ziels auf und gibt ihm den Schlüssel.
function revealOneCard(room, targetUid) {
  const g = room.game;
  const hand = room.gamePlayers[targetUid].hand;
  const total = handSize(hand);

  // Zufällige Karte aus dem Vorrat des Ziels ziehen
  const pick = Math.random() * total;
  const type = pick < hand.empty ? 'empty' : pick < hand.empty + hand.gold ? 'gold' : 'trap';
  hand[type]--;

  g.openedThisRound++;
  if (type === 'gold') g.totalGoldFound++;
  if (type === 'trap') g.totalTrapsFound++;

  // Log-Schlüssel = laufende Nummer (NICHT die Uhrzeit: Geräteuhren gehen verschieden)
  g.revealLog = g.revealLog || {};
  g.revealLog['r' + String(Object.keys(g.revealLog).length).padStart(3, '0')] =
    { round: g.round, playerId: targetUid, type: type };

  g.turnPlayerId = targetUid;
  g.moveSeq = (g.moveSeq || 0) + 1;
  room.lastActivityAt = nowMs();

  // Folgeaktion nur vormerken (führt applyFollowUp nach kurzer Pause aus).
  // Gold-Sieg zuerst: die letzte Karte der letzten Runde kann noch das letzte Gold sein.
  if (g.totalGoldFound === g.totalGoldInGame) g.followUp = { type: 'end', winner: 'adventurer' };
  else if (g.totalTrapsFound === g.totalTrapsInGame) g.followUp = { type: 'end', winner: 'guardian' };
  else if (g.openedThisRound >= Object.keys(room.gamePlayers).length) {
    g.followUp = g.round === 4 ? { type: 'end', winner: 'guardian' } : { type: 'nextRound' };
  }
}

// Führt die vorgemerkte Folgeaktion (Rundenwechsel/Spielende) GENAU EINMAL aus.
// Wer die Transaktion zuerst durchbringt, gewinnt; alle anderen finden kein
// followUp mehr und brechen ab (Aufdecker, Host-Notfall, mehrere Tabs).
async function applyFollowUp() {
  return roomTransaction((room) => {
    if (room.status !== 'playing' || !room.game || !room.game.followUp) return false;
    const f = room.game.followUp;
    delete room.game.followUp;
    room.game.moveSeq = (room.game.moveSeq || 0) + 1;
    room.lastActivityAt = nowMs();
    if (f.type === 'end') endGame(room, f.winner);
    else dealNextRound(room);
    return true;
  });
}

// Spielende. Das Ergebnis für die Statistik wird im SELBEN atomaren Schritt
// in statsPending abgelegt - es kann also nie ein beendetes Spiel ohne
// vorgemerkte Statistik geben (siehe stats.js).
function endGame(room, winner) {
  const g = room.game;
  room.status = 'ended';
  g.winner = winner;

  const traps = {}, gold = {};
  Object.values(g.revealLog || {}).forEach((e) => {
    if (e.type === 'trap') traps[e.playerId] = (traps[e.playerId] || 0) + 1;
    if (e.type === 'gold') gold[e.playerId] = (gold[e.playerId] || 0) + 1;
  });
  const players = {};
  Object.keys(room.gamePlayers).forEach((uid) => {
    const p = room.gamePlayers[uid];
    players[uid] = { name: p.name || '?', role: p.role, traps: traps[uid] || 0, gold: gold[uid] || 0 };
  });
  room.statsPending = room.statsPending || {};
  room.statsPending['g' + g.gameNumber] = { winner: winner, players: players };
}

// Neue Runde: Restkarten einsammeln, mischen, an ANWESENDE Spieler neu
// austeilen (eine Karte weniger pro Kopf). Wer gegangen ist, scheidet aus;
// seine Karten bleiben im Umlauf (sonst verschwänden Gold/Fallen).
function dealNextRound(room) {
  const g = room.game, gp = room.gamePlayers;
  const lastTarget = g.turnPlayerId; // behält den Schlüssel, falls anwesend
  const present = Object.keys(gp).filter((uid) => room.players && room.players[uid]);

  if (present.length < 2) { endGame(room, 'guardian'); return; } // Spiel kann nicht weitergehen

  const nextCards = g.cardsPerPlayerThisRound - 1;
  const pool = [];
  Object.keys(gp).forEach((uid) => {
    ['empty', 'gold', 'trap'].forEach((t) => { for (let i = 0; i < gp[uid].hand[t]; i++) pool.push(t); });
  });
  const shuffled = shuffleArray(pool);
  const extra = shuffled.length - nextCards * present.length; // von Gegangenen "geerbt"

  let dealt = 0;
  present.forEach((uid, i) => {
    const count = nextCards + Math.floor(extra / present.length) + (i < extra % present.length ? 1 : 0);
    gp[uid].hand = countTypes(shuffled.slice(dealt, dealt + count));
    gp[uid].dealId = g.gameNumber + '-' + (g.round + 1);
    dealt += count;
  });
  Object.keys(gp).filter((uid) => !present.includes(uid)).forEach((uid) => { delete gp[uid]; });

  g.round++;
  g.cardsPerPlayerThisRound = nextCards;
  g.openedThisRound = 0;
  g.turnPlayerId = present.includes(lastTarget) ? lastTarget : present[Math.floor(Math.random() * present.length)];
}
