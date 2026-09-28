// ============================================================
// game.js – Spielzustand und Spielregeln: Rollen/Karten verteilen,
// Runden-/Sieg-Logik, eine Karte aufdecken.
//
// Braucht: db, currentRoomCode, playerId, isHost, latestPlayers,
// latestVotes (aus firebase.js), ROLE_TABLE/ROOM_TABLE (config.js),
// und ruft renderGame()/announceRound() (ui.js) auf.
// ============================================================

// --- Spiel-Zustand ----------------------------------------------------
let latestGame = null;
let latestGamePlayers = {};
let centerPileCount = 0;

// Waehrend dies gesetzt ist, wird die zuletzt aufgedeckte Karte in der
// Anzeige noch fuer einen kurzen Moment beim Zielspieler "zurueckgehalten" -
// der Schluessel (game.turnPlayerId) ist zu diesem Zeitpunkt aber schon beim
// naechsten Spieler. Siehe renderGame() in ui.js.
let pendingReveal = null;

// lastDealId: welche Austeilung (gameNumber-Runde) WIR schon animiert haben.
// Die ID steht bei jedem Spieler direkt in seinen eigenen Daten (dealId) und
// kommt damit ATOMAR mit den neuen Karten an - unabhaengig davon, welcher
// Firebase-Listener (game / gamePlayers) zuerst feuert (siehe ui.js).
// lastRenderedHandKey: verhindert unnötiges Neu-Bauen der Kartenanzeige, wenn
// sich an der eigenen Hand gar nichts geändert hat.
let lastDealId = null;
let lastRenderedHandKey = null;

// Sperrt gegen Doppelklick/Doppel-Tap beim Aufdecken (siehe revealCard unten)
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
// Gemeinsam genutzt vom Host-Button UND von der Mehrheits-Abstimmung.
// Ein transaction()-Lock auf den Status verhindert, dass zwei Aufrufe
// gleichzeitig starten (z. B. Host klickt genau in dem Moment, in dem
// die Abstimmung die Mehrheit erreicht).
async function startGameInternal() {
  const lock = await db.ref('rooms/' + currentRoomCode + '/status')
    .transaction((current) => (current === 'lobby' ? 'starting' : undefined));
  if (!lock.committed) return; // ein anderer Client startet bereits

  const roomRef = db.ref('rooms/' + currentRoomCode);
  const [playersSnap, gamesPlayedSnap] = await Promise.all([
    roomRef.child('players').get(),
    roomRef.child('gamesPlayed').get()
  ]);
  const players = playersSnap.val() || {};
  const playerIds = Object.keys(players);
  const n = playerIds.length;

  if (n < 3 || n > 10) {
    await roomRef.update({ status: 'lobby' }); // Lock wieder freigeben
    alert('Tempel des Schreckens braucht 3 bis 10 Spieler.');
    return;
  }

  // Rollen-Pool zusammenstellen und mischen
  const roleCounts = ROLE_TABLE[n];
  let rolePool = [];
  for (let i = 0; i < roleCounts.adventurer; i++) rolePool.push('adventurer');
  for (let i = 0; i < roleCounts.guardian; i++) rolePool.push('guardian');
  rolePool = shuffleArray(rolePool).slice(0, n);

  // Schatzkammer-Karten mischen und je 5 pro Spieler austeilen
  const roomCounts = ROOM_TABLE[n];
  let cardPool = [];
  for (let i = 0; i < roomCounts.empty; i++) cardPool.push('empty');
  for (let i = 0; i < roomCounts.gold; i++) cardPool.push('gold');
  for (let i = 0; i < roomCounts.trap; i++) cardPool.push('trap');
  cardPool = shuffleArray(cardPool);

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
    gamesPlayed: gameNumber,
    replayVotes: null, // Abstimmung für die nächste Runde zurücksetzen
    gamePlayers: gamePlayers,
    game: {
      round: 1,
      gameNumber: gameNumber,
      cardsPerPlayerThisRound: 5,
      openedThisRound: 0,
      turnPlayerId: startingPlayer,
      totalGoldFound: 0,
      totalTrapsFound: 0,
      totalGoldInGame: roomCounts.gold,
      totalTrapsInGame: roomCounts.trap,
      totalAdventurers: roleCounts.adventurer, // fuer die Rollen-Pool-Anzeige beim Reveal
      totalGuardians: roleCounts.guardian,
      winner: null,
      revealLog: {}
    }
  });
}

// --- Statistiken: nach Spielende einmal (nur vom Host, siehe firebase.js)
// fortschreiben. Liegen unter rooms/{code}/stats/{uid} und ueberleben daher
// auch, wenn zwischenzeitlich alle den Raum verlassen und spaeter per Code
// wieder einsteigen.
async function updateStatsAfterGame(game, gamePlayers) {
  const statsRef = db.ref('rooms/' + currentRoomCode + '/stats');
  const snap = await statsRef.get();
  const stats = snap.val() || {};

  // Wer hat wie oft Gold bzw. eine Falle "abbekommen" (bei ihm aufgedeckt)?
  const trapCounts = {};
  const goldCounts = {};
  Object.values(game.revealLog || {}).forEach((entry) => {
    if (entry.type === 'trap') trapCounts[entry.playerId] = (trapCounts[entry.playerId] || 0) + 1;
    if (entry.type === 'gold') goldCounts[entry.playerId] = (goldCounts[entry.playerId] || 0) + 1;
  });

  const updates = {};
  Object.keys(gamePlayers).forEach((uid) => {
    const p = gamePlayers[uid];
    const s = stats[uid] || { name: p.name, games: 0, wins: 0, guardian: 0, traps: 0, gold: 0 };
    s.name = p.name; // Namensaenderungen mitnehmen
    s.games = (s.games || 0) + 1;
    if (p.role === game.winner) s.wins = (s.wins || 0) + 1;
    if (p.role === 'guardian') s.guardian = (s.guardian || 0) + 1;
    s.traps = (s.traps || 0) + (trapCounts[uid] || 0);
    s.gold = (s.gold || 0) + (goldCounts[uid] || 0);
    updates[uid] = s;
  });

  await statsRef.update(updates);
}

// --- Abstimmung "Ich will (nochmal) spielen" --------------------------------
async function handleToggleReady() {
  const amReady = !!latestVotes[playerId];
  await db.ref('rooms/' + currentRoomCode + '/replayVotes/' + playerId).set(!amReady);
}

// Startet automatisch, sobald mehr als die Hälfte zugestimmt hat.
//
// WICHTIG: Nur der Host löst den Start tatsächlich aus. Vorher riefen ALLE
// Clients gleichzeitig startGameInternal() auf, sobald die Mehrheit erreicht
// war - die transaction() sorgte zwar dafür, dass nur EIN Schreibvorgang
// tatsächlich passiert, aber so viele gleichzeitig konkurrierende Clients
// waren vermutlich die Ursache dafür, dass ausgerechnet der "gewinnende"
// Client (zufällig, je nach Netzwerk-Timing) seinen eigenen Rollen-Reveal
// manchmal verpasste. Mit nur einem Initiator ist der Ablauf eindeutig.
let autoStartAttempted = false;

function checkAutoStart() {
  const n = Object.keys(latestPlayers).length;
  const ready = Object.values(latestVotes).filter(Boolean).length;
  const majorityReached = n >= 3 && ready > n / 2;

  if (!majorityReached) {
    autoStartAttempted = false; // Schwelle wieder unterschritten - nächstes Mal darf wieder gestartet werden
    return;
  }
  if (autoStartAttempted || !isHost) return; // nicht doppelt und nur der Host startet

  autoStartAttempted = true;
  startGameInternal();
}

// --- Zug weiterreichen, wenn der aktuelle Schluesselinhaber weg ist ------
// Nur der Host sieht/nutzt den Button (siehe ui.js). Der Schluessel geht an
// einen zufaelligen anwesenden Spieler mit noch verbleibenden Karten.
async function skipAbsentTurn() {
  if (!latestGame) return;
  const candidates = Object.keys(latestGamePlayers).filter((uid) => {
    const hand = latestGamePlayers[uid].hand;
    const remaining = hand.empty + hand.gold + hand.trap;
    return latestPlayers[uid] && remaining > 0;
  });
  if (candidates.length === 0) return; // niemand Anwesendes hat noch Karten
  const nextUid = candidates[Math.floor(Math.random() * candidates.length)];
  await db.ref('rooms/' + currentRoomCode).update({ 'game/turnPlayerId': nextUid, 'game/revealPending': null });
}

// --- Eine Karte bei einem Mitspieler aufdecken ---------------------------
// revealInProgress sperrt gegen Doppelklick/Doppel-Tap: ohne diese Sperre
// konnten zwei schnelle Klicks (v. a. auf Touchscreens) beide parallel
// starten, bevor der erste fertig geschrieben hatte - Ergebnis: zwei
// aufgedeckte Karten statt einer. Die Sperre bleibt auch während der kurzen
// Pause vor Runden-/Spielende aktiv, damit dort kein zweiter Klick mehr
// durchkommt, bevor die Runde wirklich gewechselt hat.
async function revealCard(targetUid) {
  if (revealInProgress) return;
  revealInProgress = true;
  if (latestGame) renderGame(); // Karten sofort optisch als "gesperrt" markieren

  try {
    const roomRef = db.ref('rooms/' + currentRoomCode);
    const [gameSnap, playersSnap] = await Promise.all([
      roomRef.child('game').get(),
      roomRef.child('gamePlayers').get()
    ]);
    const game = gameSnap.val();
    const gamePlayers = playersSnap.val();
    if (!game || !gamePlayers) return;

    if (game.turnPlayerId !== playerId || game.revealPending) return; // nur der Schlüssel-Spieler darf aufdecken

    const targetHand = gamePlayers[targetUid].hand;
    const total = targetHand.empty + targetHand.gold + targetHand.trap;
    if (total === 0) return;

    // --- Schritt 1: ERST den Schlüssel weitergeben (bei allen sichtbar). ---
    // revealPending sperrt in der Zwischenzeit jedes Antippen, damit der neue
    // Schlüsselinhaber nicht schon selbst aufdeckt, bevor die Karte dran ist.
    await roomRef.update({ 'game/turnPlayerId': targetUid, 'game/revealPending': true });
    await new Promise((resolve) => setTimeout(resolve, 900));

    // --- Schritt 2: DANN die Karte aufdecken (Logik wie bisher) ---

    // Zufällige Karte aus dem Vorrat des Zielspielers ziehen
    const pick = Math.random() * total;
    let type;
    if (pick < targetHand.empty) type = 'empty';
    else if (pick < targetHand.empty + targetHand.gold) type = 'gold';
    else type = 'trap';

    targetHand[type]--;

    const newOpenedThisRound = game.openedThisRound + 1;
    const newGoldFound = game.totalGoldFound + (type === 'gold' ? 1 : 0);
    const newTrapsFound = game.totalTrapsFound + (type === 'trap' ? 1 : 0);

    // --- Der Reveal selbst - bei allen Spielern direkt sichtbar (die Karte
    // landet im Ablegestapel). null entfernt die Sperre wieder. ---
    const revealUpdates = { 'game/revealPending': null };
    revealUpdates['gamePlayers/' + targetUid + '/hand'] = targetHand;
    revealUpdates['game/revealLog/' + Date.now()] = { round: game.round, playerId: targetUid, type: type };
    revealUpdates['game/openedThisRound'] = newOpenedThisRound;
    revealUpdates['game/totalGoldFound'] = newGoldFound;
    revealUpdates['game/totalTrapsFound'] = newTrapsFound;

    // --- Was als Nächstes passiert, wird JETZT schon berechnet (auf Basis
    // des einen konsistenten Standes von oben), aber noch nicht geschrieben. ---
    // WICHTIG: Gold-Sieg wird VOR "Runde 4 zuende" geprüft. Ist die letzte
    // Karte der letzten Runde zufällig auch die letzte Goldkarte, gewinnen
    // dadurch korrekt die Abenteurer statt der Wächterinnen "weil die Zeit um ist".
    let followUpUpdates = null;

    if (newGoldFound === game.totalGoldInGame) {
      followUpUpdates = { status: 'ended', 'game/winner': 'adventurer' };
    } else if (newTrapsFound === game.totalTrapsInGame) {
      followUpUpdates = { status: 'ended', 'game/winner': 'guardian' };
    } else if (newOpenedThisRound === Object.keys(gamePlayers).length) {
      // Runde vorbei
      if (game.round === 4) {
        followUpUpdates = { status: 'ended', 'game/winner': 'guardian' };
      } else {
        // Restliche Karten einsammeln, mischen, neu austeilen (eine weniger pro Spieler)
        const nextRoundCards = game.cardsPerPlayerThisRound - 1;
        const remainingPool = [];
        Object.keys(gamePlayers).forEach((uid) => {
          const hand = uid === targetUid ? targetHand : gamePlayers[uid].hand;
          for (let i = 0; i < hand.empty; i++) remainingPool.push('empty');
          for (let i = 0; i < hand.gold; i++) remainingPool.push('gold');
          for (let i = 0; i < hand.trap; i++) remainingPool.push('trap');
        });
        const shuffled = shuffleArray(remainingPool);
        followUpUpdates = {};
        Object.keys(gamePlayers).forEach((uid, i) => {
          followUpUpdates['gamePlayers/' + uid + '/hand'] =
            countTypes(shuffled.slice(i * nextRoundCards, i * nextRoundCards + nextRoundCards));
          // Neue Austeilung markieren - jeder Client animiert daran das Aufdecken
          followUpUpdates['gamePlayers/' + uid + '/dealId'] = game.gameNumber + '-' + (game.round + 1);
        });
        followUpUpdates['game/round'] = game.round + 1;
        followUpUpdates['game/cardsPerPlayerThisRound'] = nextRoundCards;
        followUpUpdates['game/openedThisRound'] = 0;
        followUpUpdates['game/turnPlayerId'] = targetUid;
      }
    }
    // Normaler Zug: Der Schlüssel liegt durch Schritt 1 schon beim Zielspieler.

    await roomRef.update(revealUpdates);

    if (followUpUpdates) {
      // Kurze Pause: alle sehen die zuletzt aufgedeckte Karte noch, bevor die
      // nächste Runde angekündigt wird oder der Sieger-Screen erscheint.
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await roomRef.update(followUpUpdates);
    }
  } finally {
    revealInProgress = false;
    if (latestGame && !viewGame.hidden) renderGame(); // Karten wieder klickbar machen
  }
}
