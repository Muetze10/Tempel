// ============================================================
// firebase.js – Verbindung zu Firebase und alles rund um den
// RAUM (nicht das eigentliche Spiel): erstellen, beitreten,
// verlassen, Live-Listener, Host-Übergabe.
//
// Braucht: firebaseConfig (aus firebase-config.js), und ruft an
// mehreren Stellen in ui.js/game.js definierte Funktionen auf
// (renderPlayerList, showRoleRevealView, checkAutoStart, ...).
// Das funktioniert, weil alle Dateien denselben globalen Scope
// teilen - wichtig ist nur, dass ui.js und game.js VOR app.js
// geladen werden (siehe index.html).
// ============================================================

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- Eigene Spieler-ID -------------------------------------------------
// Jeder Browser bekommt eine zufällige ID, die in localStorage gespeichert
// wird. So "merkt" die Seite sich den Spieler auch nach einem Reload,
// ohne dass ein Login-System nötig ist.
function getPlayerId() {
  let id = localStorage.getItem('tds_player_id');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('tds_player_id', id);
  }
  return id;
}
const playerId = getPlayerId();

// Erzeugt einen 4-stelligen Raum-Code aus Großbuchstaben/Zahlen (z. B. "K7QM")
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen (I, O, 0, 1)
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Ein Rundenwechsel schreibt game/ UND gamePlayers/ in einem update() -
// das sind zwei getrennte Firebase-Listener, die dadurch in nicht
// garantierter Reihenfolge feuern. Rendert man sofort bei JEDEM der beiden,
// kann der zuerst ankommende Listener mit noch inkonsistentem Zwischenstand
// rendern (z. B. schon die neue, kuerzere Hand, aber noch die alte Runde) -
// das hat bisher die Aufdeck-Animation kaputt gemacht (Karten kurz
// aufgedeckt, dann nochmal). Ueber einen Mikrotask warten wir, bis beide
// Updates angekommen sind, und rendern erst dann einmal.
let renderGameScheduled = false;
function scheduleRenderGame() {
  if (renderGameScheduled) return;
  renderGameScheduled = true;
  Promise.resolve().then(() => {
    renderGameScheduled = false;
    if (latestGame && !viewGame.hidden) renderGame();
  });
}

// --- Raum-/Lobby-Zustand ---------------------------------------------------
let currentRoomCode = null;
let isHost = false;
let currentHostId = null;
let latestVotes = {};
let latestPlayers = {};

// --- Raum erstellen -----------------------------------------------------
async function handleCreateRoom() {
  const name = nameInput.value.trim();
  if (!name) {
    showError('Bitte gib zuerst deinen Namen ein.');
    return;
  }
  clearError();

  const roomCode = generateRoomCode();

  // Raum in der Datenbank anlegen: Host-Info + erster Spieler
  await db.ref('rooms/' + roomCode).set({
    hostId: playerId,
    status: 'lobby',
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    players: {
      [playerId]: { name: name, joinedAt: firebase.database.ServerValue.TIMESTAMP }
    }
  });

  // Sorgt dafür, dass der Spieler automatisch aus dem Raum verschwindet,
  // sobald der Tab geschlossen wird oder die Verbindung abbricht.
  db.ref('rooms/' + roomCode + '/players/' + playerId).onDisconnect().remove();

  isHost = true;
  enterRoom(roomCode);
}

// --- Raum beitreten -------------------------------------------------------
async function handleJoinRoom() {
  const name = nameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();

  if (!name) {
    showError('Bitte gib zuerst deinen Namen ein.');
    return;
  }
  if (!code) {
    showError('Bitte gib einen Raum-Code ein.');
    return;
  }
  clearError();

  const roomRef = db.ref('rooms/' + code);
  const snapshot = await roomRef.get();

  if (!snapshot.exists()) {
    showError('Diesen Raum gibt es nicht. Code prüfen?');
    return;
  }

  const room = snapshot.val();
  // Laeuft schon ein Spiel: nur reinlassen, wer (per gespeicherter playerId)
  // bereits Teil DIESES laufenden Spiels war - so kann man nach Verbindungs-
  // abbruch/Reload wieder einsteigen, aber niemand Fremdes mitten im Spiel.
  const wasInGame = room.gamePlayers && room.gamePlayers[playerId];
  if (room.status !== 'lobby' && !wasInGame) {
    showError('Dieses Spiel läuft schon.');
    return;
  }

  // Spieler zur Spielerliste des Raums hinzufügen (bzw. bei Wiedereinstieg
  // aktualisieren - Name kann sich seit dem letzten Mal geaendert haben)
  await roomRef.child('players/' + playerId).set({
    name: name,
    joinedAt: firebase.database.ServerValue.TIMESTAMP
  });

  db.ref('rooms/' + code + '/players/' + playerId).onDisconnect().remove();

  isHost = room.hostId === playerId;
  enterRoom(code);
}

// --- In den Warteraum wechseln und alles live beobachten -----------------
// onDisconnect() greift meist zuverlaessig, aber nicht immer sofort (z. B.
// Handy-Netzwechsel, Tab eingefroren) - dann steht ein Spieler noch in der
// Lobby, obwohl er laengst weg ist. Deshalb zusaetzlich ein Herzschlag: jeder
// Client meldet sich alle 15s, der Host entfernt alle, die 45s nichts mehr
// von sich hoeren liessen.
let heartbeatTimer = null;
let staleCheckTimer = null;

function startPresenceCheck(roomCode) {
  const lastSeenRef = db.ref('rooms/' + roomCode + '/players/' + playerId + '/lastSeen');
  const ping = () => lastSeenRef.set(firebase.database.ServerValue.TIMESTAMP);
  ping();
  heartbeatTimer = setInterval(ping, 15000);

  staleCheckTimer = setInterval(async () => {
    const snap = await db.ref('rooms/' + roomCode + '/players').get();
    const players = snap.val() || {};
    const now = Date.now();
    const updates = {};
    Object.entries(players).forEach(([uid, p]) => {
      if (p.lastSeen && now - p.lastSeen > 45000) updates[uid] = null;
    });
    if (Object.keys(updates).length) db.ref('rooms/' + roomCode + '/players').update(updates);
  }, 20000);
}

function stopPresenceCheck() {
  clearInterval(heartbeatTimer);
  clearInterval(staleCheckTimer);
}

function enterRoom(roomCode) {
  currentRoomCode = roomCode;
  startPresenceCheck(roomCode);

  viewLobby.hidden = true;
  viewRoom.hidden = false;
  roomCodeDisplay.textContent = roomCode;

  // "on('value', ...)" hält die Verbindung offen: sobald sich irgendwo
  // in players/ etwas ändert, läuft diese Funktion für ALLE Spieler
  // im Raum automatisch erneut – das ist die Live-Synchronisation.
  db.ref('rooms/' + roomCode + '/players').on('value', (snapshot) => {
    const players = snapshot.val() || {};
    latestPlayers = players; // für den Rollen-/Karten-Zufall beim Start merken
    renderPlayerList(players);
    renderReadyCount();
    maybeClaimHost(players); // springt ein, falls der bisherige Host den Raum verlassen hat

    // Sind waehrend eines laufenden Spiels alle gegangen, wuerde der Raum
    // sonst fuer immer auf status "playing" haengen bleiben und koennte nie
    // wieder betreten werden. Die Statistiken bleiben davon unberuehrt, da
    // sie in einem eigenen "stats"-Pfad liegen.
    if (Object.keys(players).length === 0) {
      db.ref('rooms/' + roomCode + '/status').get().then((s) => {
        if (s.val() && s.val() !== 'lobby') {
          db.ref('rooms/' + roomCode).update({ status: 'lobby', gamePlayers: null, game: null, replayVotes: null });
        }
      });
    }
  });

  // Wer aktuell Host ist - kann sich durch maybeClaimHost() aendern, sobald
  // der ursprüngliche Host den Raum verlässt.
  db.ref('rooms/' + roomCode + '/hostId').on('value', (snapshot) => {
    currentHostId = snapshot.val();
    isHost = currentHostId === playerId;
    btnStartGame.hidden = !isHost;
    renderPlayerList(latestPlayers); // Host-Markierung in der Liste aktualisieren
  });

  // Abstimmung "Ich will (nochmal) spielen": startet automatisch, sobald
  // mehr als die Hälfte der Spieler zugestimmt hat.
  db.ref('rooms/' + roomCode + '/replayVotes').on('value', (snapshot) => {
    latestVotes = snapshot.val() || {};
    renderReadyCount();
    checkAutoStart();
  });

  // ============================================================
  // ZENTRALER game-Listener: einzige Quelle der Wahrheit dafür, ob ein
  // frisches Spiel begonnen hat (gameNumber), eine neue Runde da ist
  // (round) oder das Spiel vorbei ist (winner). Läuft über den normalen
  // on('value')-Listener (kein manuelles .get()) - liefert dadurch immer
  // einen konsistenten, vollständigen Snapshot statt eines Zwischenstands.
  // ZUSÄTZLICH: der automatische Start per Abstimmung (checkAutoStart)
  // wird nur vom Host ausgelöst, nicht von allen Clients gleichzeitig -
  // das beseitigt den Mehrfach-Wettlauf um die Start-transaction(), der
  // vermutlich die eigentliche Ursache dafür war, dass unregelmäßig eine
  // einzelne Person ihren Rollen-Reveal verpasste.
  let lastRevealedGameNumber = 0;
  let lastHandledWinner = null;

  db.ref('rooms/' + roomCode + '/game').on('value', (snapshot) => {
    const newGame = snapshot.val();
    const oldGame = latestGame;
    const isFreshGame = newGame && newGame.gameNumber && newGame.gameNumber !== lastRevealedGameNumber;

    if (oldGame && newGame && !isFreshGame && newGame.round !== oldGame.round) {
      // announceRound (ui.js) kuemmert sich selbst darum, bis wann der
      // Schluessel fuer diese Runde versteckt bleibt - siehe dort.
      announceRound(newGame.round);
    }

    latestGame = newGame;

    if (isFreshGame) {
      lastRevealedGameNumber = newGame.gameNumber;
      lastHandledWinner = null;
      showRoleRevealView(); // JEDER Spieler sieht das bei JEDEM Spiel, ohne Ausnahme
      return;
    }

    if (newGame && newGame.winner && newGame.winner !== lastHandledWinner) {
      lastHandledWinner = newGame.winner;
      // Nur der Host schreibt die Statistiken, damit sie nicht doppelt/mehrfach
      // (einmal pro verbundenem Client) hochgezaehlt werden.
      if (isHost) updateStatsAfterGame(newGame, latestGamePlayers);
      showEndView();
      return;
    }

    // Normales Update während des laufenden Spiels (Kartenaufdeckung, Zug
    // wandert weiter, ...). Nur rendern, wenn das Spielbrett auch wirklich
    // die aktive Ansicht ist - sonst würde ein zu früh eintreffendes Update
    // (z. B. während noch der Rollen-Reveal läuft) die "Karten sind neu
    // ausgeteilt"-Markierung verbrauchen, BEVOR die Aufdeck-Animation
    // überhaupt gezeigt wurde.
    if (newGame && !viewGame.hidden) {
      scheduleRenderGame();
    }
  });

  db.ref('rooms/' + roomCode + '/gamePlayers').on('value', (snapshot) => {
    latestGamePlayers = snapshot.val() || {};
    if (latestGame && !viewGame.hidden) scheduleRenderGame();
  });

  // Der Status wird nur noch für die Rückkehr in den Warteraum gebraucht -
  // alles Spielrelevante läuft über den game-Listener oben.
  db.ref('rooms/' + roomCode + '/status').on('value', (snapshot) => {
    if (snapshot.val() === 'lobby') showRoomView();
  });
}

// Springt ein, wenn der aktuelle Host nicht mehr in der Spielerliste steht
// (z. B. weil er den Raum verlassen hat): der Spieler mit der "kleinsten" ID
// übernimmt automatisch. transaction() macht das sicher, auch wenn mehrere
// Clients gleichzeitig reagieren - Firebase löst das Wettrennen sauber auf.
function maybeClaimHost(players) {
  const ids = Object.keys(players);
  if (ids.length === 0) return;
  db.ref('rooms/' + currentRoomCode + '/hostId').transaction((current) => {
    if (current && players[current]) return current; // Host ist noch da, nichts ändern
    return ids.sort()[0]; // deterministisch: alle Clients kommen auf denselben neuen Host
  });
}

// --- Raum verlassen (von überall: Warteraum ODER Endscreen) -----------------
async function leaveRoom() {
  stopPresenceCheck();
  const roomRef = db.ref('rooms/' + currentRoomCode);
  roomRef.child('players/' + playerId).onDisconnect().cancel();
  await Promise.all([
    roomRef.child('players/' + playerId).remove(),
    roomRef.child('replayVotes/' + playerId).remove()
  ]);

  // Alle Live-Verbindungen zu diesem Raum sauber trennen
  roomRef.child('players').off();
  roomRef.child('hostId').off();
  roomRef.child('replayVotes').off();
  roomRef.child('status').off();
  db.ref('rooms/' + currentRoomCode + '/game').off();
  db.ref('rooms/' + currentRoomCode + '/gamePlayers').off();

  currentRoomCode = null;
  isHost = false;
  document.body.classList.remove('theme-good', 'theme-bad');
  hideAllViews();
  viewLobby.hidden = false;
}
