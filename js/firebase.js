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
// Die Sitzung wird ausdrücklich dauerhaft im Browser-Speicher (IndexedDB) abgelegt,
// nicht in einem Cookie: Firebase kann sie nur von dort wiederherstellen. Geht sie
// verloren (Browserdaten gelöscht, privater Modus), gibt es eine NEUE uid.
const authReady = firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
  .catch(() => {}) // Persistenz nicht möglich -> trotzdem anmelden (dann nur bis Tab-Ende)
  .then(() => firebase.auth().signInAnonymously())
  .then((cred) => { playerId = cred.user.uid; });

// --- Spielerdaten merken: Name und zuletzt benutzter Raum-Code als Cookie ----
// Nur Komfort (Felder werden vorausgefüllt). Kein Tracking, kein Drittanbieter,
// keine Spieler-ID im Cookie. Ohne Cookies (z. B. file://) passiert einfach nichts.
const PROFILE_COOKIE_DAYS = 365;

function setCookie(name, value) {
  try {
    const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? '; Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; max-age=' + PROFILE_COOKIE_DAYS * 86400 + '; path=/; SameSite=Lax' + secure;
  } catch (e) { /* Cookies gesperrt: ignorieren */ }
}

function getCookie(name) {
  try {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
  } catch (e) { return ''; }
}

function deleteCookie(name) {
  try { document.cookie = name + '=; max-age=0; path=/'; } catch (e) { /* ignorieren */ }
}

// Gemerkte Werte für die Eingabefelder (bereinigt wie die Felder selbst: Name max. 20, Code max. 6)
function loadProfileCookies() {
  return {
    name: getCookie('tds_name').slice(0, 20),
    room: getCookie('tds_room').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  };
}

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

    // Starter abgestürzt? Dann hängt der Raum in "starting" -> zurücksetzen
    const status = (await db.ref('rooms/' + roomCode + '/status').get()).val();
    if (status === 'starting') recoverStuckStart().catch(console.error);
  }, 20000);
}

// Mobil: Im Hintergrund pausiert der Browser Timer. Beim Zurückkehren sofort
// melden, damit man nicht als "weg" gilt (und beim Rundenwechsel ausscheidet).
document.addEventListener('visibilitychange', () => { if (!document.hidden) presencePing(); });

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
    lastActivityAt: firebase.database.ServerValue.TIMESTAMP, // für die automatische Bereinigung
    players: { [playerId]: { name: name, joinedAt: firebase.database.ServerValue.TIMESTAMP } }
  });

  setCookie('tds_name', name);
  setCookie('tds_room', roomCode);
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

  // Stabile Identität: die Auth-uid bleibt pro Browser gleich. Wer schon in
  // players (registriert) oder in gamePlayers (Mitspieler) steht, darf immer
  // wieder rein - auch während "starting" und mitten im Spiel.
  const registered = !!(room.players && room.players[playerId]);
  const wasInGame = !!(room.gamePlayers && room.gamePlayers[playerId]);

  // Ist niemand mehr im Raum, aber ein altes Spiel hängt noch: zurück in die
  // Lobby. NICHT bei "starting": dort entsteht gerade ein Spiel, das wir nicht
  // überschreiben dürfen (hängt der Start wirklich, räumt recoverStuckStart auf).
  const nobodyThere = !room.players || Object.keys(room.players).length === 0;
  if (nobodyThere && room.status !== 'lobby' && room.status !== 'starting') {
    await roomRef.update({ status: 'lobby', gamePlayers: null, game: null, replayVotes: null });
    room.status = 'lobby';
    room.gamePlayers = null;
  }

  if (room.status === 'starting') {
    if (!registered && !wasInGame) return showError('Das Spiel wird gerade gestartet. Gleich nochmal versuchen.');
  } else if (room.status !== 'lobby' && !wasInGame) {
    return showError('Dieses Spiel läuft schon.');
  }

  // Maximal 10 Spieler (mehr kann das Spiel nicht austeilen)
  const count = room.players ? Object.keys(room.players).length : 0;
  if (count >= 10 && !registered) return showError('Der Raum ist voll (max. 10 Spieler).');

  // Wiederbeitritt ändert nur den Namen; ein neuer Spieler wird angelegt.
  // Spielzustand (status/game/gamePlayers) wird hier nie angefasst.
  if (registered) {
    await roomRef.child('players/' + playerId).update({ name: name });
  } else {
    await roomRef.child('players/' + playerId).set({
      name: name,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });
  }
  roomRef.child('lastActivityAt').set(firebase.database.ServerValue.TIMESTAMP);
  setCookie('tds_name', name);
  setCookie('tds_room', code);

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
    scheduleRenderGame(); // FIX: ohne das erschien "Zug überspringen" nie, wenn der Schlüsselinhaber ging

    // Sind während eines Spiels alle gegangen, Raum zurück in die Lobby
    if (Object.keys(players).length === 0) {
      roomRef.child('status').get().then((s) => {
        if (s.val() && s.val() !== 'lobby' && s.val() !== 'starting') {
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
    scheduleRenderGame(); // neuer Host bekommt Skip-Button/Notfall-Timer
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
      processPendingStats().catch(console.error);
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

  // Eine nach Absturz/Reload liegengebliebene Statistik weiter verbuchen
  processPendingStats().catch(console.error);

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
  deleteCookie('tds_room'); // wer bewusst geht, will nicht automatisch wieder in diesen Raum vorgeschlagen werden
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
