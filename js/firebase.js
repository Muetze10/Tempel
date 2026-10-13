// ============================================================
// firebase.js – Verbindung zu Firebase und alles rund um den RAUM:
// erstellen, beitreten, verlassen, Live-Listener, Host-Übergabe.
// Ruft Funktionen aus ui.js/game.js/stats.js auf (gemeinsamer Scope).
// ============================================================

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Anonymer Login: Firebase vergibt pro Browser eine feste uid (bleibt nach
// Reload erhalten). Die Sicherheitsregeln prüfen genau diese uid.
let playerId = null;
const authReady = firebase.auth().signInAnonymously()
  .then((cred) => { playerId = cred.user.uid; });

// Wartet auf den Login; zeigt einen Fehler, falls er scheitert
async function ensureLogin() {
  try { await authReady; return true; }
  catch (e) { showError('Anmeldung fehlgeschlagen. Seite neu laden?'); return false; }
}

// 4-stelliger Raum-Code ohne verwechselbare Zeichen (I, O, 0, 1)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// --- Raum-/Lobby-Zustand ---------------------------------------------------
let currentRoomCode = null;
let isHost = false;
let currentHostId = null;
let myName = '';
let latestVotes = {};
let latestPlayers = {};

// Mehrere Firebase-Updates (game + gamePlayers) kommen fast gleichzeitig an;
// über einen Mikrotask wird daraus nur ein Render mit konsistentem Stand.
let renderGameScheduled = false;
function scheduleRenderGame() {
  if (renderGameScheduled) return;
  renderGameScheduled = true;
  Promise.resolve().then(() => {
    renderGameScheduled = false;
    if (latestGame && !viewGame.hidden) renderGame();
  });
}

// --- Verbindungsstatus ------------------------------------------------------
// Bricht die Verbindung ab, zeigt der Warteraum veraltete Daten. Deshalb ein
// Hinweis-Banner; beim Wiederverbinden melden wir uns sofort neu im Raum an.
let wasConnected = false;
let serverOffset = 0; // Differenz zwischen Server- und Geräte-Uhr
db.ref('.info/serverTimeOffset').on('value', (s) => { serverOffset = s.val() || 0; });

function watchConnection() { // wird in app.js gestartet (braucht das Banner aus ui.js)
  db.ref('.info/connected').on('value', (snap) => {
    const connected = snap.val() === true;
    if (connected) wasConnected = true;
    connBannerEl.hidden = connected || !wasConnected;
    if (connected && currentRoomCode) presencePing();
  });
}

// --- Anwesenheit (Herzschlag) --------------------------------------------
// onDisconnect() greift nicht immer sofort (Netzwechsel, eingefrorener Tab).
// Deshalb meldet sich jeder Client alle 15 s; wer 45 s still war, wird von
// irgendeinem anderen Client aus der Liste entfernt. update() legt den
// Spieler außerdem wieder an, falls er zu Unrecht entfernt wurde.
let heartbeatTimer = null;
let staleCheckTimer = null;

function presencePing() {
  if (!currentRoomCode) return;
  const ref = db.ref('rooms/' + currentRoomCode + '/players/' + playerId);
  ref.onDisconnect().remove();
  ref.update({ name: myName, lastSeen: firebase.database.ServerValue.TIMESTAMP });
}

function startPresence(roomCode) {
  presencePing();
  heartbeatTimer = setInterval(presencePing, 15000);
  staleCheckTimer = setInterval(async () => {
    const playersRef = db.ref('rooms/' + roomCode + '/players');
    const players = (await playersRef.get()).val() || {};
    const now = Date.now() + serverOffset;
    const updates = {};
    Object.entries(players).forEach(([uid, p]) => {
      if (uid !== playerId && p.lastSeen && now - p.lastSeen > 45000) updates[uid] = null;
    });
    if (Object.keys(updates).length) playersRef.update(updates);
  }, 20000);
}

function stopPresence() {
  clearInterval(heartbeatTimer);
  clearInterval(staleCheckTimer);
}

// --- Raum erstellen -----------------------------------------------------
async function handleCreateRoom() {
  const name = nameInput.value.trim();
  if (!name) return showError('Bitte gib zuerst deinen Namen ein.');
  clearError();
  if (!(await ensureLogin())) return;

  // Code wählen, der noch nicht vergeben ist (sonst würde ein alter Raum samt
  // Statistik überschrieben)
  let roomCode;
  do { roomCode = generateRoomCode(); }
  while ((await db.ref('rooms/' + roomCode).get()).exists());

  await db.ref('rooms/' + roomCode).set({
    hostId: playerId,
    status: 'lobby',
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    players: { [playerId]: { name: name, joinedAt: firebase.database.ServerValue.TIMESTAMP } }
  });

  myName = name;
  isHost = true;
  enterRoom(roomCode);
}

// --- Raum beitreten -------------------------------------------------------
async function handleJoinRoom() {
  const name = nameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return showError('Bitte gib zuerst deinen Namen ein.');
  if (!code) return showError('Bitte gib einen Raum-Code ein.');
  clearError();
  if (!(await ensureLogin())) return;

  const roomRef = db.ref('rooms/' + code);
  const room = (await roomRef.get()).val();
  if (!room) return showError('Diesen Raum gibt es nicht. Code prüfen?');

  // Ist niemand mehr im Raum, aber ein altes Spiel hängt noch: zurück in die Lobby
  const nobodyThere = !room.players || Object.keys(room.players).length === 0;
  if (nobodyThere && room.status !== 'lobby') {
    await roomRef.update({ status: 'lobby', gamePlayers: null, game: null, replayVotes: null });
    room.status = 'lobby';
    room.gamePlayers = null;
  }

  // Läuft ein Spiel, darf nur wieder rein, wer schon dabei war (Wiedereinstieg)
  const wasInGame = room.gamePlayers && room.gamePlayers[playerId];
  if (room.status !== 'lobby' && !wasInGame) return showError('Dieses Spiel läuft schon.');

  await roomRef.child('players/' + playerId).set({
    name: name,
    joinedAt: firebase.database.ServerValue.TIMESTAMP
  });

  myName = name;
  isHost = room.hostId === playerId;
  enterRoom(code);
}

// --- In den Warteraum wechseln und alles live beobachten ------------------
function enterRoom(roomCode) {
  currentRoomCode = roomCode;
  startPresence(roomCode);
  watchStats(roomCode);

  viewLobby.hidden = true;
  viewRoom.hidden = false;
  roomCodeDisplay.textContent = roomCode;

  const roomRef = db.ref('rooms/' + roomCode);

  // Spielerliste (Live-Synchronisation für alle im Raum)
  roomRef.child('players').on('value', (snapshot) => {
    const players = snapshot.val() || {};
    latestPlayers = players;
    renderPlayerList(players);
    renderReadyCount();
    maybeClaimHost(players);

    // Sind während eines Spiels alle gegangen, Raum zurück in die Lobby
    if (Object.keys(players).length === 0) {
      roomRef.child('status').get().then((s) => {
        if (s.val() && s.val() !== 'lobby') {
          roomRef.update({ status: 'lobby', gamePlayers: null, game: null, replayVotes: null });
        }
      });
    }
  });

  roomRef.child('hostId').on('value', (snapshot) => {
    currentHostId = snapshot.val();
    isHost = currentHostId === playerId;
    btnStartGame.hidden = !isHost;
    renderPlayerList(latestPlayers);
  });

  // Abstimmung "Ich will (nochmal) spielen"
  roomRef.child('replayVotes').on('value', (snapshot) => {
    latestVotes = snapshot.val() || {};
    renderReadyCount();
    checkAutoStart();
  });

  // Zentraler game-Listener: erkennt neues Spiel (gameNumber), neue Runde
  // (round) und Spielende (winner).
  let lastRevealedGameNumber = 0;
  let lastHandledWinner = null;

  roomRef.child('game').on('value', (snapshot) => {
    const newGame = snapshot.val();
    const oldGame = latestGame;
    const isFreshGame = newGame && newGame.gameNumber && newGame.gameNumber !== lastRevealedGameNumber;

    if (oldGame && newGame && !isFreshGame && newGame.round !== oldGame.round) {
      announceRound(newGame.round);
    }
    latestGame = newGame;

    if (isFreshGame) {
      lastRevealedGameNumber = newGame.gameNumber;
      lastHandledWinner = null;
      resetCenterPile();
      if (newGame.winner) { // Wiedereinstieg in ein schon beendetes Spiel
        lastHandledWinner = newGame.winner;
        showEndView();
      } else {
        showRoleRevealView(); // jeder Spieler sieht seine Rolle bei jedem Spiel
      }
      return;
    }

    if (newGame && newGame.winner && newGame.winner !== lastHandledWinner) {
      lastHandledWinner = newGame.winner;
      updateStatsAfterGame(newGame, latestGamePlayers);
      showEndView();
      return;
    }

    // Nur rendern, wenn das Spielbrett sichtbar ist (nicht während des Rollen-Reveals)
    if (newGame && !viewGame.hidden) scheduleRenderGame();
  });

  roomRef.child('gamePlayers').on('value', (snapshot) => {
    latestGamePlayers = snapshot.val() || {};
    if (latestGame && !viewGame.hidden) scheduleRenderGame();
  });

  // Status: nur für die Rückkehr in den Warteraum
  roomRef.child('status').on('value', (snapshot) => {
    if (snapshot.val() === 'lobby') showRoomView();
  });
}

// Übernimmt den Host-Posten, wenn der bisherige nicht mehr in der Liste steht.
// transaction() löst das Wettrennen mehrerer Clients sauber auf.
function maybeClaimHost(players) {
  const ids = Object.keys(players);
  if (ids.length === 0) return;
  db.ref('rooms/' + currentRoomCode + '/hostId').transaction((current) => {
    if (current && players[current]) return current;
    return ids.sort()[0]; // deterministisch: alle wählen denselben neuen Host
  });
}

// --- Raum verlassen (Warteraum oder Endscreen) ------------------------------
async function leaveRoom() {
  const code = currentRoomCode;
  const roomRef = db.ref('rooms/' + code);
  stopPresence();
  currentRoomCode = null; // verhindert, dass ein spätes Ping uns wieder anlegt
  roomRef.child('players/' + playerId).onDisconnect().cancel();
  await Promise.all([
    roomRef.child('players/' + playerId).remove(),
    roomRef.child('replayVotes/' + playerId).remove()
  ]);

  ['players', 'hostId', 'replayVotes', 'status', 'game', 'gamePlayers'].forEach((child) => roomRef.child(child).off());
  unwatchStats(code);

  isHost = false;
  latestGame = null;
  document.body.classList.remove('theme-good', 'theme-bad');
  hideAllViews();
  viewLobby.hidden = false;
}
