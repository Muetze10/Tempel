// ============================================================
// app.js – Lobby-Logik für "Tempel des Schreckens Online"
//
// Was diese Datei macht:
// 1. Verbindet sich mit Firebase Realtime Database
// 2. Erlaubt Raum erstellen / Raum beitreten
// 3. Zeigt die Spielerliste live an (jeder Spieler sieht sofort,
//    wenn jemand Neues beitritt – ganz ohne eigenen Server)
//
// Die eigentliche Spiel-Logik (Karten, Rollen, Aufdecken) kommt
// in einem späteren Schritt dazu, sobald die Lobby steht.
// ============================================================

// --- Firebase initialisieren -----------------------------------------
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

// --- DOM-Elemente ---------------------------------------------------------
const viewLobby = document.getElementById('view-lobby');
const viewRoom = document.getElementById('view-room');
const viewRoleReveal = document.getElementById('view-role-reveal');
const viewGame = document.getElementById('view-game');
const viewEnd = document.getElementById('view-end');

const nameInput = document.getElementById('player-name');
const btnCreateRoom = document.getElementById('btn-create-room');
const roomCodeInput = document.getElementById('room-code-input');
const btnJoinRoom = document.getElementById('btn-join-room');
const lobbyError = document.getElementById('lobby-error');

const roomCodeDisplay = document.getElementById('room-code-display');
const playerListEl = document.getElementById('player-list');
const btnStartGame = document.getElementById('btn-start-game');

let currentRoomCode = null;
let isHost = false;

// --- Hilfsfunktionen --------------------------------------------------

// Erzeugt einen 4-stelligen Raum-Code aus Großbuchstaben/Zahlen (z. B. "K7QM")
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen (I, O, 0, 1)
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function showError(message) {
  lobbyError.textContent = message;
  lobbyError.hidden = false;
}

function clearError() {
  lobbyError.hidden = true;
}

// --- Raum erstellen -----------------------------------------------------
btnCreateRoom.addEventListener('click', async () => {
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

  isHost = true;
  enterRoom(roomCode);
});

// --- Raum beitreten -------------------------------------------------------
btnJoinRoom.addEventListener('click', async () => {
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
  if (snapshot.val().status !== 'lobby') {
    showError('Dieses Spiel läuft schon.');
    return;
  }

  // Spieler zur Spielerliste des Raums hinzufügen
  await roomRef.child('players/' + playerId).set({
    name: name,
    joinedAt: firebase.database.ServerValue.TIMESTAMP
  });

  isHost = snapshot.val().hostId === playerId;
  enterRoom(code);
});

// --- In den Warteraum wechseln und Spielerliste live beobachten -----------
function enterRoom(roomCode) {
  currentRoomCode = roomCode;

  viewLobby.hidden = true;
  viewRoom.hidden = false;
  roomCodeDisplay.textContent = roomCode;

  btnStartGame.hidden = !isHost; // nur der Host sieht den Start-Button

  // "on('value', ...)" hält die Verbindung offen: sobald sich irgendwo
  // in players/ etwas ändert, läuft diese Funktion für ALLE Spieler
  // im Raum automatisch erneut – das ist die Live-Synchronisation.
  db.ref('rooms/' + roomCode + '/players').on('value', (snapshot) => {
    const players = snapshot.val() || {};
    latestPlayers = players; // für den Rollen-/Karten-Zufall beim Start merken
    renderPlayerList(players);
  });

  // Reagiert auf Statuswechsel: sobald der Host das Spiel startet, wechseln
  // ALLE Clients automatisch zur richtigen Ansicht - keine manuelle Aktion nötig.
  let previousStatus = null;
  db.ref('rooms/' + roomCode + '/status').on('value', (snapshot) => {
    const status = snapshot.val();
    if (status === 'playing' && previousStatus !== 'playing') {
      // Frischer Spielstart: erst die eigene Rolle enthüllen, danach zum Brett
      showRoleRevealView();
    } else if (status === 'playing') {
      showGameView();
    } else if (status === 'ended') {
      showGameView(); // Board-Listener müssen weiterlaufen, damit latestGame/latestGamePlayers aktuell sind
      showEndView();
    } else if (status === 'lobby') {
      showRoomView();
    }
    previousStatus = status;
  });
}

let latestPlayers = {};

function renderPlayerList(players) {
  playerListEl.innerHTML = '';
  const entries = Object.values(players);

  entries.forEach((player) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="player-dot"></span>${escapeHtml(player.name)}`;
    playerListEl.appendChild(li);
  });

  // Start-Button erst ab 3 Spielern aktivieren (Mindestanzahl des Spiels)
  btnStartGame.disabled = entries.length < 3;
}

// Einfacher Schutz gegen HTML-Injection über den Namen
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// BILDER – exakt die Dateinamen aus deinem images/-Ordner
// ============================================================
const IMG = {
  leer:       'images/Tempel_leer.jpg',
  gold:       'images/Tempel_Goldjpg.jpg',
  falle:      'images/Tempel_Feuerfalle.jpg',
  key:        'images/Tempel_Key.webp',
  gut:        'images/Tempel_Gut.jpg',
  boese:      'images/Tempel_Boese.jpg',
  karteBack:  'images/Karte_Hintergrund.jpg',
  charBack:   'images/Karakter_Hintergrund.jpg'
};

const CARD_IMAGES = { empty: IMG.leer, gold: IMG.gold, trap: IMG.falle };
const CARD_LABELS = { empty: 'Leer', gold: 'Gold', trap: 'Feuerfalle' };

const ROLE_INFO = {
  adventurer: { label: 'Abenteurer', image: IMG.gut,   className: 'role-good' },
  guardian:   { label: 'Wächterin',  image: IMG.boese, className: 'role-bad' }
};

// ============================================================
// SPIEL-LOGIK
// Offizielle Tabellen aus der Spielanleitung (Schmidt Spiele)
// ============================================================

const ROLE_TABLE = {
  3:  { adventurer: 2, guardian: 2 },
  4:  { adventurer: 3, guardian: 2 },
  5:  { adventurer: 3, guardian: 2 },
  6:  { adventurer: 4, guardian: 2 },
  7:  { adventurer: 5, guardian: 3 },
  8:  { adventurer: 6, guardian: 3 },
  9:  { adventurer: 6, guardian: 3 },
  10: { adventurer: 7, guardian: 4 }
};

// Zusammensetzung des Kartenpools (5 Karten pro Spieler in Runde 1)
const ROOM_TABLE = {
  3:  { empty: 8,  gold: 5,  trap: 2 },
  4:  { empty: 12, gold: 6,  trap: 2 },
  5:  { empty: 16, gold: 7,  trap: 2 },
  6:  { empty: 20, gold: 8,  trap: 2 },
  7:  { empty: 26, gold: 7,  trap: 2 },
  8:  { empty: 30, gold: 8,  trap: 2 },
  9:  { empty: 34, gold: 9,  trap: 2 },
  10: { empty: 37, gold: 10, trap: 3 }
};

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
btnStartGame.addEventListener('click', async () => {
  const playerIds = Object.keys(latestPlayers);
  const n = playerIds.length;

  if (n < 3 || n > 10) {
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

  const shuffledPlayerIds = shuffleArray(playerIds);
  const gamePlayers = {};
  shuffledPlayerIds.forEach((uid, i) => {
    gamePlayers[uid] = {
      role: rolePool[i],
      hand: countTypes(cardPool.slice(i * 5, i * 5 + 5))
    };
  });

  // Schlüsselkarte auslosen: zufälliger Startspieler
  const startingPlayer = shuffledPlayerIds[Math.floor(Math.random() * n)];

  await db.ref('rooms/' + currentRoomCode).update({
    status: 'playing',
    gamePlayers: gamePlayers,
    game: {
      round: 1,
      cardsPerPlayerThisRound: 5,
      openedThisRound: 0,
      turnPlayerId: startingPlayer,
      totalGoldFound: 0,
      totalTrapsFound: 0,
      totalGoldInGame: roomCounts.gold,
      totalTrapsInGame: roomCounts.trap,
      winner: null,
      revealLog: {}
    }
  });
});

// ============================================================
// ANSICHTEN
// ============================================================
function hideAllViews() {
  viewLobby.hidden = true;
  viewRoom.hidden = true;
  viewRoleReveal.hidden = true;
  viewGame.hidden = true;
  viewEnd.hidden = true;
  document.body.classList.remove('body-endscreen');
}

function showRoomView() {
  hideAllViews();
  viewRoom.hidden = false;
}

// --- Rollen-Reveal: Vollbild, Karte antippen zum Umdrehen ------------------
const roleCardEl = document.getElementById('role-card');
const roleCardFrontEl = document.getElementById('role-card-front');
const roleCardImageEl = document.getElementById('role-card-image');
const roleCardTextEl = document.getElementById('role-card-text');
const btnRoleContinue = document.getElementById('btn-role-continue');

async function showRoleRevealView() {
  hideAllViews();
  viewRoleReveal.hidden = false;

  const snap = await db.ref('rooms/' + currentRoomCode + '/gamePlayers/' + playerId + '/role').get();
  const role = snap.val();
  if (!role) { showGameView(); return; }
  const info = ROLE_INFO[role];

  roleCardEl.classList.remove('flipped');
  roleCardFrontEl.classList.remove('role-good', 'role-bad');
  roleCardFrontEl.classList.add(info.className);
  roleCardImageEl.src = info.image;
  roleCardTextEl.textContent = 'Du bist: ' + info.label;
  btnRoleContinue.hidden = true;

  roleCardEl.onclick = () => {
    roleCardEl.classList.add('flipped');
    // Farbstimmung der ganzen Seite an die Rolle anpassen: blau = gut, rot = böse
    document.body.classList.remove('theme-good', 'theme-bad');
    document.body.classList.add(role === 'adventurer' ? 'theme-good' : 'theme-bad');
    setTimeout(() => { btnRoleContinue.hidden = false; }, 700);
  };
}

btnRoleContinue.addEventListener('click', () => showGameView());

// --- Spielbrett ------------------------------------------------------------
let latestGame = null;
let latestGamePlayers = {};
let gameListenersActive = false;
let centerPileCount = 0;

function ensureGameListeners() {
  if (gameListenersActive) return;
  gameListenersActive = true;

  db.ref('rooms/' + currentRoomCode + '/game').on('value', (snapshot) => {
    const newGame = snapshot.val();
    if (newGame && latestGame && newGame.round !== latestGame.round) {
      announceRound(newGame.round);
    }
    latestGame = newGame;
    if (latestGame) {
      renderGame();
      if (!viewEnd.hidden) renderEndView();
    }
  });

  db.ref('rooms/' + currentRoomCode + '/gamePlayers').on('value', (snapshot) => {
    latestGamePlayers = snapshot.val() || {};
    if (latestGame) {
      renderGame();
      if (!viewEnd.hidden) renderEndView();
    }
  });
}

function showGameView() {
  hideAllViews();
  viewGame.hidden = false;
  ensureGameListeners();
  if (latestGame) renderGame();
}

function showEndView() {
  hideAllViews();
  viewEnd.hidden = false;
  document.body.classList.add('body-endscreen'); // eigener Vollbild-Endscreen
  ensureGameListeners();
  renderEndView();
}

const roundDisplay = document.getElementById('round-display');
const myHandEl = document.getElementById('my-hand');
const turnLabelEl = document.getElementById('turn-label');
const seatsEl = document.getElementById('seats');
const centerPileEl = document.getElementById('center-pile');
const remainingCountsEl = document.getElementById('remaining-counts');
const roundBannerEl = document.getElementById('round-banner');
const roundBannerTextEl = document.getElementById('round-banner-text');
const cornerRoleEl = document.getElementById('corner-role');
const cornerRoleFrontEl = document.getElementById('corner-role-front');

// Große Rundenansage, die kurz über dem Bildschirm eingeblendet wird
function announceRound(roundNumber) {
  roundBannerTextEl.textContent = 'Runde ' + roundNumber;
  roundBannerEl.hidden = false;
  requestAnimationFrame(() => roundBannerEl.classList.add('show'));
  setTimeout(() => {
    roundBannerEl.classList.remove('show');
    setTimeout(() => { roundBannerEl.hidden = true; }, 400);
  }, 1800);
}

function renderGame() {
  const game = latestGame;
  if (!game) return;

  roundDisplay.textContent = game.round;

  const isMyTurn = game.turnPlayerId === playerId;
  const turnPlayerName = (latestPlayers[game.turnPlayerId] || {}).name || '?';
  turnLabelEl.textContent = isMyTurn
    ? 'Du hast den Schlüssel – tippe die Karten eines Mitspielers an'
    : turnPlayerName + ' hat den Schlüssel';
  turnLabelEl.classList.toggle('turn-mine', isMyTurn);

  // --- Eigene Karten als kleine Bilder ---
  const myHand = latestGamePlayers[playerId] ? latestGamePlayers[playerId].hand : null;
  myHandEl.innerHTML = '';
  if (myHand) {
    ['gold', 'trap', 'empty'].forEach((type) => {
      for (let i = 0; i < myHand[type]; i++) {
        const img = document.createElement('img');
        img.src = CARD_IMAGES[type];
        img.className = 'my-card';
        img.alt = CARD_LABELS[type];
        img.title = CARD_LABELS[type];
        myHandEl.appendChild(img);
      }
    });
    if (myHand.empty + myHand.gold + myHand.trap === 0) {
      myHandEl.innerHTML = '<span class="empty-hint">Alle deine Karten wurden aufgedeckt.</span>';
    }
  }

  // --- Eigene Charakterkarte in der Ecke (verdeckt) ---
  const myRole = latestGamePlayers[playerId] ? latestGamePlayers[playerId].role : null;
  if (myRole) {
    cornerRoleFrontEl.src = ROLE_INFO[myRole].image;
    cornerRoleEl.classList.remove('role-good', 'role-bad');
    cornerRoleEl.classList.add(ROLE_INFO[myRole].className);
  }

  // --- Spieler im Kreis um den Tempel ---
  const uids = Object.keys(latestGamePlayers);
  const n = uids.length;
  seatsEl.innerHTML = '';

  uids.forEach((uid, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2; // erster Spieler oben
    const left = 50 + 40 * Math.cos(angle);
    const top  = 50 + 36 * Math.sin(angle);

    const hand = latestGamePlayers[uid].hand;
    const remaining = hand.empty + hand.gold + hand.trap;
    const name = (latestPlayers[uid] || {}).name || '?';
    const isTurn = uid === game.turnPlayerId;
    const isMe = uid === playerId;
    const canPick = isMyTurn && !isMe && remaining > 0;

    const seat = document.createElement('div');
    seat.className = 'seat'
      + (isTurn ? ' seat-active' : '')
      + (canPick ? ' seat-pickable' : '')
      + (isMe ? ' seat-me' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';

    let cardsHtml = '';
    for (let c = 0; c < remaining; c++) {
      cardsHtml += `<img src="${IMG.karteBack}" class="seat-card-back" alt="">`;
    }

    seat.innerHTML = `
      <div class="seat-cards">${cardsHtml}</div>
      <span class="seat-name">
        ${isTurn ? `<img src="${IMG.key}" class="seat-key" alt="Schlüssel">` : ''}
        ${escapeHtml(name)}${isMe ? ' (du)' : ''}
      </span>
    `;

    if (canPick) seat.addEventListener('click', () => revealCard(uid));
    seatsEl.appendChild(seat);
  });

  // --- Wie viele Karten welcher Art noch unentdeckt im Tempel liegen ---
  const left = { empty: 0, gold: 0, trap: 0 };
  uids.forEach((uid) => {
    const h = latestGamePlayers[uid].hand;
    left.empty += h.empty;
    left.gold  += h.gold;
    left.trap  += h.trap;
  });

  remainingCountsEl.innerHTML = `
    <div class="remaining-item"><img src="${IMG.gold}" alt=""><span>${left.gold}×</span></div>
    <div class="remaining-item"><img src="${IMG.falle}" alt=""><span>${left.trap}×</span></div>
    <div class="remaining-item"><img src="${IMG.leer}" alt=""><span>${left.empty}×</span></div>
  `;

  // --- Aufgedeckte Karten im Ablegestapel in der Mitte ---
  const logEntries = Object.values(game.revealLog || {});
  if (logEntries.length > centerPileCount) {
    logEntries.slice(centerPileCount).forEach((entry) => addCardToCenterPile(entry.type));
    centerPileCount = logEntries.length;
  } else if (logEntries.length < centerPileCount) {
    centerPileEl.innerHTML = '';
    centerPileCount = logEntries.length;
  }
}

// Legt ein aufgedecktes Kärtchen leicht verdreht auf den Ablegestapel
function addCardToCenterPile(type) {
  const img = document.createElement('img');
  img.className = 'center-card';
  img.src = CARD_IMAGES[type];
  img.alt = CARD_LABELS[type];
  const rotation = Math.random() * 26 - 13;
  const offsetX = Math.random() * 10 - 5;
  const offsetY = Math.random() * 10 - 5;
  img.style.setProperty('--rot', rotation + 'deg');
  img.style.setProperty('--dx', offsetX + 'px');
  img.style.setProperty('--dy', offsetY + 'px');
  centerPileEl.appendChild(img);
}

// --- Charakterkarte in der Ecke: antippen zeigt sie kurz ------------------
let cornerTimer = null;
cornerRoleEl.addEventListener('click', () => {
  if (cornerRoleEl.classList.contains('revealed')) {
    cornerRoleEl.classList.remove('revealed');
    clearTimeout(cornerTimer);
    return;
  }
  cornerRoleEl.classList.add('revealed');
  clearTimeout(cornerTimer);
  // nach kurzer Zeit automatisch wieder verdecken, damit niemand mitliest
  cornerTimer = setTimeout(() => cornerRoleEl.classList.remove('revealed'), 2500);
});

// --- Eine Karte bei einem Mitspieler aufdecken ---------------------------
async function revealCard(targetUid) {
  const roomRef = db.ref('rooms/' + currentRoomCode);
  const [gameSnap, playersSnap] = await Promise.all([
    roomRef.child('game').get(),
    roomRef.child('gamePlayers').get()
  ]);
  const game = gameSnap.val();
  const gamePlayers = playersSnap.val();
  if (!game || !gamePlayers) return;

  if (game.turnPlayerId !== playerId) return; // nur der Schlüssel-Spieler darf aufdecken

  const targetHand = gamePlayers[targetUid].hand;
  const total = targetHand.empty + targetHand.gold + targetHand.trap;
  if (total === 0) return;

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

  const updates = {};
  updates['gamePlayers/' + targetUid + '/hand'] = targetHand;
  updates['game/revealLog/' + Date.now()] = { round: game.round, playerId: targetUid, type: type };
  updates['game/openedThisRound'] = newOpenedThisRound;
  updates['game/totalGoldFound'] = newGoldFound;
  updates['game/totalTrapsFound'] = newTrapsFound;

  // --- Sieg-Bedingungen ---
  if (newGoldFound === game.totalGoldInGame) {
    updates['status'] = 'ended';
    updates['game/winner'] = 'adventurer';
  } else if (newTrapsFound === game.totalTrapsInGame) {
    updates['status'] = 'ended';
    updates['game/winner'] = 'guardian';
  } else if (newOpenedThisRound === Object.keys(gamePlayers).length) {
    // Runde vorbei
    if (game.round === 4) {
      updates['status'] = 'ended';
      updates['game/winner'] = 'guardian';
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
      Object.keys(gamePlayers).forEach((uid, i) => {
        updates['gamePlayers/' + uid + '/hand'] =
          countTypes(shuffled.slice(i * nextRoundCards, i * nextRoundCards + nextRoundCards));
      });
      updates['game/round'] = game.round + 1;
      updates['game/cardsPerPlayerThisRound'] = nextRoundCards;
      updates['game/openedThisRound'] = 0;
      updates['game/turnPlayerId'] = targetUid;
    }
  } else {
    updates['game/turnPlayerId'] = targetUid; // Schlüssel wandert weiter
  }

  await roomRef.update(updates);
}

// ============================================================
// ENDSCREEN – eigene Vollbild-Seite
// ============================================================
const endTitle = document.getElementById('end-title');
const endMessage = document.getElementById('end-message');
const endRolesList = document.getElementById('end-roles-list');
const btnBackToLobby = document.getElementById('btn-back-to-lobby');

function renderEndView() {
  const game = latestGame;
  if (!game || !game.winner) return;

  const adventurersWon = game.winner === 'adventurer';
  viewEnd.classList.toggle('end-good', adventurersWon);
  viewEnd.classList.toggle('end-bad', !adventurersWon);

  endTitle.textContent = adventurersWon ? 'Die Abenteurer siegen!' : 'Die Wächterinnen siegen!';
  endMessage.textContent = adventurersWon
    ? 'Alle Goldschätze wurden rechtzeitig geborgen.'
    : 'Die Fallen haben zugeschlagen – oder die Zeit ist abgelaufen.';

  endRolesList.innerHTML = '';
  Object.keys(latestGamePlayers).forEach((uid) => {
    const name = (latestPlayers[uid] || {}).name || '?';
    const role = latestGamePlayers[uid].role;
    const info = ROLE_INFO[role];

    const li = document.createElement('li');
    li.className = 'end-role-item ' + info.className;
    li.innerHTML = `
      <img src="${info.image}" class="end-role-image" alt="">
      <span class="end-role-name">${escapeHtml(name)}</span>
      <span class="end-role-label">${info.label}</span>
    `;
    endRolesList.appendChild(li);
  });

  btnBackToLobby.hidden = !isHost;
}

btnBackToLobby.addEventListener('click', async () => {
  gameListenersActive = false;
  centerPileCount = 0;
  centerPileEl.innerHTML = '';
  latestGame = null;
  document.body.classList.remove('theme-good', 'theme-bad');
  db.ref('rooms/' + currentRoomCode + '/game').off();
  db.ref('rooms/' + currentRoomCode + '/gamePlayers').off();
  await db.ref('rooms/' + currentRoomCode).update({ status: 'lobby', gamePlayers: null, game: null });
});
