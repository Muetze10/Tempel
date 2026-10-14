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
  const lock = await db.ref('rooms/' + currentRoomCode + '/status')
    .transaction((current) => (current === 'lobby' ? 'starting' : undefined));
  if (!lock.committed) return; // ein anderer Client startet bereits

  // FIX: scheitert das Austeilen (Netzwerk, Berechtigung), bliebe der Status
  // sonst für immer auf "starting" - niemand könnte starten oder beitreten.
  const roomRef = db.ref('rooms/' + currentRoomCode);
  try {
    await dealNewGame(roomRef);
  } catch (err) {
    console.error('Spielstart fehlgeschlagen:', err);
    await roomRef.update({ status: 'lobby' }).catch(() => {});
  }
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

// --- Abstimmung "Ich will (nochmal) spielen" --------------------------------
async function handleToggleReady() {
  const amReady = !!latestVotes[playerId];
  await db.ref('rooms/' + currentRoomCode + '/replayVotes/' + playerId).set(!amReady);
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

// --- Zug weiterreichen (nur Host-Button, siehe ui.js) -----------------------
// Der Schlüssel geht an einen zufälligen anwesenden Spieler mit Karten.
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

// --- Ein Zug: erst wandert der Schlüssel, dann wird die Karte aufgedeckt ---
async function revealCard(targetUid) {
  if (revealInProgress) return;
  revealInProgress = true;
  if (latestGame) renderGame(); // Karten sofort als "gesperrt" zeigen

  try {
    const roomRef = db.ref('rooms/' + currentRoomCode);
    const [gameSnap, playersSnap] = await Promise.all([
      roomRef.child('game').get(),
      roomRef.child('gamePlayers').get()
    ]);
    const game = gameSnap.val();
    const gamePlayers = playersSnap.val();
    if (!game || !gamePlayers) return;
    if (game.turnPlayerId !== playerId || game.revealPending) return; // nur der Schlüsselinhaber

    const targetHand = gamePlayers[targetUid].hand;
    const total = targetHand.empty + targetHand.gold + targetHand.trap;
    if (total === 0) return;

    // Schritt 1: Schlüssel wandert zum Ziel; revealPending sperrt alle Klicks.
    await roomRef.update({ 'game/turnPlayerId': targetUid, 'game/revealPending': true });
    await new Promise((resolve) => setTimeout(resolve, 900));

    // FIX: Hat der Host den Zug in der Pause übersprungen, nicht mehr aufdecken
    // (sonst gäbe es einen Doppelzug).
    const current = (await roomRef.child('game').get()).val();
    if (!current || !current.revealPending || current.turnPlayerId !== targetUid || current.round !== game.round) return;

    // Schritt 2: zufällige Karte des Ziels aufdecken
    const pick = Math.random() * total;
    let type;
    if (pick < targetHand.empty) type = 'empty';
    else if (pick < targetHand.empty + targetHand.gold) type = 'gold';
    else type = 'trap';

    targetHand[type]--;

    const newOpenedThisRound = game.openedThisRound + 1;
    const newGoldFound = game.totalGoldFound + (type === 'gold' ? 1 : 0);
    const newTrapsFound = game.totalTrapsFound + (type === 'trap' ? 1 : 0);

    // Log-Schlüssel = laufende Nummer (NICHT die Uhrzeit: jedes Gerät hat eine
    // andere Uhr, dadurch kam die Reihenfolge im Ablagestapel durcheinander).
    const logKey = 'r' + String(Object.keys(game.revealLog || {}).length).padStart(3, '0');
    const revealUpdates = { 'game/revealPending': null };
    revealUpdates['gamePlayers/' + targetUid + '/hand'] = targetHand;
    revealUpdates['game/revealLog/' + logKey] = { round: game.round, playerId: targetUid, type: type };
    revealUpdates['game/openedThisRound'] = newOpenedThisRound;
    revealUpdates['game/totalGoldFound'] = newGoldFound;
    revealUpdates['game/totalTrapsFound'] = newTrapsFound;

    // Folgeaktion (Spielende / neue Runde) wird jetzt berechnet, aber erst nach
    // einer kurzen Pause geschrieben. Gold-Sieg wird VOR "Runde 4 vorbei"
    // geprüft: die letzte Karte der letzten Runde kann noch das letzte Gold sein.
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
        // Neue Runde: Restkarten einsammeln, mischen, neu austeilen - nur an
        // Spieler, die noch im Raum sind. Wer gegangen ist, scheidet aus; seine
        // Karten bleiben im Umlauf (sonst verschwänden Gold/Fallen).
        const presentUids = Object.keys(gamePlayers).filter((uid) => latestPlayers[uid]);

        if (presentUids.length < 2) {
          // Fast alle weg - Spiel kann nicht weitergehen.
          followUpUpdates = { status: 'ended', 'game/winner': 'guardian' };
        } else {
          const nextRoundCards = game.cardsPerPlayerThisRound - 1;
          const remainingPool = [];
          Object.keys(gamePlayers).forEach((uid) => {
            const hand = uid === targetUid ? targetHand : gamePlayers[uid].hand;
            for (let i = 0; i < hand.empty; i++) remainingPool.push('empty');
            for (let i = 0; i < hand.gold; i++) remainingPool.push('gold');
            for (let i = 0; i < hand.trap; i++) remainingPool.push('trap');
          });
          const shuffled = shuffleArray(remainingPool);
          const extraCards = shuffled.length - nextRoundCards * presentUids.length; // von Gegangenen "geerbt"

          followUpUpdates = {};
          let dealt = 0;
          presentUids.forEach((uid, i) => {
            const count = nextRoundCards + Math.floor(extraCards / presentUids.length) + (i < extraCards % presentUids.length ? 1 : 0);
            followUpUpdates['gamePlayers/' + uid + '/hand'] = countTypes(shuffled.slice(dealt, dealt + count));
            followUpUpdates['gamePlayers/' + uid + '/dealId'] = game.gameNumber + '-' + (game.round + 1);
            dealt += count;
          });
          Object.keys(gamePlayers).filter((uid) => !latestPlayers[uid]).forEach((uid) => {
            followUpUpdates['gamePlayers/' + uid] = null; // Sitz verschwindet
          });

          followUpUpdates['game/round'] = game.round + 1;
          followUpUpdates['game/cardsPerPlayerThisRound'] = nextRoundCards;
          followUpUpdates['game/openedThisRound'] = 0;
          followUpUpdates['game/turnPlayerId'] =
            presentUids.includes(targetUid) ? targetUid : presentUids[Math.floor(Math.random() * presentUids.length)];
        }
      }
    }

    // FIX: Die Folgeaktion liegt als JSON in der DB. Stirbt dieser Client in der
    // Pause, kann der Host sie ausführen (siehe ui.js) - vorher hing das Spiel.
    if (followUpUpdates) revealUpdates['game/followUp'] = JSON.stringify(followUpUpdates);
    await roomRef.update(revealUpdates);

    if (followUpUpdates) {
      // Pause: alle sehen die letzte Karte, bevor Runde/Endscreen kommt
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await applyFollowUp();
    }
  } finally {
    revealInProgress = false;
    if (latestGame && !viewGame.hidden) renderGame(); // wieder klickbar
  }
}

// Führt die hinterlegte Folgeaktion (Rundenwechsel/Spielende) GENAU EINMAL aus.
// Die Transaktion "beansprucht" den Eintrag; wer ihn zuerst löscht, schreibt.
// Zweite Aufrufer (z. B. Host-Notfall + Aufdecker) brechen ab.
async function applyFollowUp() {
  const roomRef = db.ref('rooms/' + currentRoomCode);
  let json = null;
  const claim = await roomRef.child('game/followUp').transaction((cur) => {
    json = cur;
    return cur ? null : undefined; // nichts offen -> abbrechen
  });
  if (!claim.committed || !json) return;
  await roomRef.update(JSON.parse(json));
}
