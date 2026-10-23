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

// Änderungsschlüssel des Spielerkreises (siehe renderGame in ui.js): ein
// Neuaufbau nur bei echter Änderung, nicht bei jedem Firebase-Event.
let lastRenderedSeatsKey = null;

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

// Setzt `rooms/<code>/lastActivityAt` auf die Serverzeit. Bewusst NICHT in der
// Transaktion: ein frischer Zeitstempel wäre bei jeder Wiederholung ein neuer
// Wert, die Transaktion käme also nie zur Ruhe.
function touchActivity() {
  const stamp = (typeof firebase !== 'undefined' && firebase.database && firebase.database.ServerValue)
    ? firebase.database.ServerValue.TIMESTAMP
    : Date.now();
  db.ref('rooms/' + currentRoomCode + '/lastActivityAt').set(stamp).catch(() => {});
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

  // Neues Spiel: den Sitz-Cache verwerfen, damit der Spielerkreis sicher neu
  // aufgebaut wird (auch wenn der neue Zustand zufällig gleich aussähe).
  lastRenderedSeatsKey = null;

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
// geschrieben wurde.
//
// Drei Fallstricke, die das Spiel lahmlegten:
// 1) Bei transaction() ist NUR `undefined` das Signal "abbrechen". Ein
//    zurückgegebenes `null` schreibt NULL und löscht damit den ganzen Raum -
//    die Spieler tauchten danach nur noch als Herzschlag (ohne joinedAt) wieder
//    auf und das Spiel war fort. Deshalb wird bei fehlendem Raum abgebrochen.
// 2) Eine Transaktion auf `rooms/<code>` läuft gegen den LOKALEN Cache. Ist der
//    (noch) leer - z. B. direkt nach dem Laden oder im Wiederverbindungs-
//    fenster - sieht die Funktion `null`, obwohl der Raum am Server existiert,
//    und bricht ab. Deshalb wird gewartet, bis der Live-Listener aus enterRoom
//    den Raumknoten gelesen hat.
// 3) Offline läuft transaction() ewig auf den Server zu. `revealCard` wartet
//    darauf, `revealInProgress` sperrte das Brett anschließend für immer.
//    Deshalb: erst Verbindung prüfen, dann ein hartes Zeitlimit.
const TX_TIMEOUT_MS = 8000;

async function roomTransaction(fn) {
  if (!isConnected()) return false; // schnelle Rückmeldung statt hängendem Zug
  let valid = false;
  const startedAt = Date.now();

  // Ein einziger Zeitgeber für das ganze Vorhaben: gilt für das Warten auf den
  // Raumknoten UND für die Transaktion selbst. Offline löst Firebase beides nie
  // auf - ohne Limit hinge der Zug (und damit `revealInProgress`) für immer.
  let timer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ committed: false }), TX_TIMEOUT_MS);
  });

  // (2) Erst warten, bis der Live-Listener aus enterRoom den Raumknoten gelesen
  // hat - sonst sieht die Transaktion einen leeren Cache und verwirft den Zug.
  if (typeof roomSynced !== 'undefined' && roomSynced && roomSynced.then) {
    const synced = await Promise.race([roomSynced, timedOut]);
    if (synced !== true) {
      // Der Timer kann in Tests sofort feuern; dann auf das echte Ergebnis warten.
      if (Date.now() - startedAt < TX_TIMEOUT_MS) {
        if ((await roomSynced) !== true) { if (timer) clearTimeout(timer); return false; }
      } else {
        if (timer) clearTimeout(timer);
        return false;
      }
    }
  }

  const roomRef = db.ref('rooms/' + currentRoomCode);
  const tx = roomRef.transaction((room) => {
    valid = false;
    if (!room) return undefined; // Raum weg? Nie null schreiben - das löscht ihn!
    valid = fn(room) !== false;
    return valid ? room : undefined;
  });
  // (3) Ein gekürzter Test-Timer kann sofort feuern, bevor die (im Test sehr
  // schnelle) Transaktion abschließt - deshalb zählt der Timer nur, wenn
  // tatsächlich Zeit vergangen ist; sonst wird das echte Ergebnis abgewartet.
  const settledTx = tx.then(
    (r) => r,
    () => ({ committed: false })
  );
  let res = await Promise.race([settledTx, timedOut]);
  if ((!res || !res.committed) && Date.now() - startedAt < TX_TIMEOUT_MS) res = await settledTx;
  if (timer) clearTimeout(timer);
  if (!res || !res.committed) return false;
  // lastActivityAt gehört nicht in die Transaktion: ein frischer Zeitstempel
  // macht jede Wiederholung zu einem neuen Wert (die Transaktion käme nie zur
  // Ruhe). Er wird separat - und mit Serverzeit - nach dem Erfolg gesetzt.
  touchActivity();
  return valid;
}

// Läuft gerade ein normaler Zug? (nicht beendet, keine Folgeaktion offen)
const isMoveOpen = (room) =>
  room.status === 'playing' && room.game && room.gamePlayers && !room.game.winner && !room.game.followUp;

// Ist ein Spieler wirklich noch anwesend? Unterschied zur bloßen players-
// Liste: Nach einem Absturz stirbt der Eintrag erst nach 45 s durch den
// Stale-Check anderer Clients (oder gar nie, wenn niemand mehr da ist).
// Wir messen den lastSeen-Frischturnus - Einträge ohne Zeitstempel (alte
// Räume / Tests) gelten als da, damit sich daran nichts ändert.
function isAroundNow(uid, players) {
  const p = players && players[uid];
  if (!p) return false;
  if (!p.lastSeen) return true;
  return nowMs() - p.lastSeen < 50000;
}

// --- Zug überspringen --------------------------------------------------------
// Gemeinsamer Kern für Host-Klick und Auto-Skip: Schlüssel weitergeben, wenn
// der Inhaber wirklich weg ist. Die Transaktion prüft alles frisch - mehrere
// Clients dürfen parallel daran glauben, nur einer gewinnt, der Rest läuft
// ins Leere. againstSeenSeq: Host-Klick gilt nur für die Zugnummer, die der
// Host gesehen hat; der Auto-Skip verzichtet darauf.

// Deckt Geisterkarten in EINEM Zug weiter auf, bis die Runde ihr Ziel erreicht
// hat oder wieder ein anwesender Spieler Karten hat. Genau das rettet die
// fachlich saubere Zählweise: openedThisRound muss die Spielranggröße erreichen
// (siehe revealOneCard), und ohne diesen Falls ging die Runde endlos fest,
// wenn die Anwesenden ihre Karten alle schon abgelegt hatten.
function revealGhostCards(room) {
  const g = room.game;
  while (true) {
    // Frisch pro Zug rechnen: eine verteilte Kartenhand kann in der Kette leer werden
    const goneWithCards = Object.keys(room.gamePlayers).filter(
      (uid) => !isAroundNow(uid, room.players) && handSize(room.gamePlayers[uid].hand) > 0);
    if (goneWithCards.length === 0) break;

    const uid = goneWithCards[Math.floor(Math.random() * goneWithCards.length)];
    revealOneCard(room, uid);
    // Ende der Kette: ein Sieg ist gefallen, oder der Schlüssel liegt wieder
    // bei einem Anwesenden - dann zur normalen Zählweise zurückkehren.
    if (g.followUp) {
      if (!isAroundNow(g.turnPlayerId, room.players)) {
        const presentNow = Object.keys(room.gamePlayers).filter(
          (u) => isAroundNow(u, room.players) && handSize(room.gamePlayers[u].hand) > 0);
        if (presentNow.length > 0) g.turnPlayerId = presentNow[Math.floor(Math.random() * presentNow.length)];
      }
      return true;
    }
  }
  const presentNow = Object.keys(room.gamePlayers).filter(
    (u) => isAroundNow(u, room.players) && handSize(room.gamePlayers[u].hand) > 0);
  // Geisterleer ohne Sieg: Schlüssel zurück zu einem Anwesenden geben
  if (!isAroundNow(g.turnPlayerId, room.players) && presentNow.length > 0) {
    g.turnPlayerId = presentNow[Math.floor(Math.random() * presentNow.length)];
  }
  return presentNow.length > 0;
}

async function skipGhostTurn(againstSeenSeq) {
  return roomTransaction((room) => {
    const g = room.game;
    if (!isMoveOpen(room)) return false;
    const seen = latestGame ? latestGame.moveSeq || 0 : null;
    if (againstSeenSeq && (g.moveSeq || 0) !== seen) return false;
    if (isAroundNow(g.turnPlayerId, room.players)) return false; // Inhaber ist noch da

    // Normalfall: Schlüssel an einen anwesenden Spieler mit Karten weitergeben
    const candidates = Object.keys(room.gamePlayers).filter(
      (uid) => isAroundNow(uid, room.players) && handSize(room.gamePlayers[uid].hand) > 0);
    if (candidates.length > 0) {
      g.turnPlayerId = candidates[Math.floor(Math.random() * candidates.length)];
      g.moveSeq = (g.moveSeq || 0) + 1; // ein Klick auf die alte Ansicht wird dadurch ungültig
      return true;
    }

    // Keine anwesenden Spieler mit Karten. Es bleiben nur die Geister - deren
    // Karten werden automatisch aufgedeckt (im Brettspiel laufen ihre Karten
    // auch weiter), bis die Runde ihr Ziel erreicht oder der Sieg fällt.
    return revealGhostCards(room);
  });
}

// Host-Klick: unverändert auch ohne Auto-Skip vorhanden ("sofort"-Option).
async function skipAbsentTurn() {
  if (!latestGame) return;
  return skipGhostTurn(true);
}

// Sofortiges Spielende, wenn nur noch EIN Mitspieler da ist (Wächter gewinnen,
// wie beim Rundenende mit <2 Anwesen, siehe dealNextRound). Die 20 s
// Wartefrist läuft in ui.js - ein kurz abgetauchtes Handy soll weitermachen
// dürfen. Niemand mehr da? Dann übernimmt die Wiederbelebung (Raum zurücksetzen).
async function endIfUnderstaffed() {
  return roomTransaction((room) => {
    if (!isMoveOpen(room)) return false;
    const present = Object.keys(room.gamePlayers).filter((uid) => isAroundNow(uid, room.players));
    if (present.length !== 1) return false;
    endGame(room, 'guardian');
    return true;
  });
}

// Verlassenen Raum zurücksetzen: kein Mitspieler des laufenden oder eines
// beendeten Spiels mehr anwesend, aber der Spielzustand hängt noch. Wird er
// von einem Außenstehenden ausgelöst (z. B. beim Beitreten), befreit er so
// "tote Lobbys", die sonst nie freikämen. Warteraum-Gäste zählen bewusst
// nicht mit - sie SOLLEN den Reset auslösen können.
async function resetOrphanedRoom() {
  return roomTransaction((room) => {
    if (!room) return false;
    if (room.status !== 'playing' && room.status !== 'ended') return false;
    // Entscheidend sind die Mitspieler DES SPIELS, nicht die Raumliste:
    const members = room.gamePlayers || {};
    const present = Object.keys(members).filter((uid) => isAroundNow(uid, room.players));
    if (present.length > 0) return false; // da ist jemand dran
    room.status = 'lobby';
    room.game = null;
    room.gamePlayers = null;
    room.replayVotes = null;
    room.statsPending = null; // Ergebnis des abgebrochenen Spiels: niemand verbucht es
    room.startingAt = null;
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
    if (!revealed) {
      // Technisch gescheitert (Timeout/Verbindung)? Nur dann melden - eine
      // reguläre Ablehnung (jemand war schneller) soll still vorbeigehen.
      if (latestGame && latestGame.turnPlayerId === playerId && !latestGame.followUp) {
        alert('Der Zug konnte nicht gespeichert werden. Bitte nochmal tippen.');
      }
      return;
    }

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
  if (type === 'gold') {
    g.totalGoldFound++;
    if (typeof playSound === 'function') playSound('gold');
  }
  if (type === 'trap') {
    g.totalTrapsFound++;
    if (typeof playSound === 'function') playSound('trap');
  }

  // Log-Schlüssel = laufende Nummer (NICHT die Uhrzeit: Geräteuhren gehen verschieden)
  g.revealLog = g.revealLog || {};
  g.revealLog['r' + String(Object.keys(g.revealLog).length).padStart(3, '0')] =
    { round: g.round, playerId: targetUid, type: type };

  g.turnPlayerId = targetUid;
  g.moveSeq = (g.moveSeq || 0) + 1;

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

  // Neue Runde: Sitz-Cache verwerfen (neue dealId, neue Karten im Fächer).
  lastRenderedSeatsKey = null;
}
