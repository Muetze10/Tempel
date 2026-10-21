// ============================================================
// ui.js – Alles Sichtbare: Ansichten, Warteraum, Rollen-Reveal,
// Spielbrett, Endscreen. Nutzt Variablen aus firebase.js/game.js/config.js.
// ============================================================

// --- DOM-Elemente: Lobby ---------------------------------------------------
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
const connBannerEl = document.getElementById('conn-banner');

const roomCodeDisplay = document.getElementById('room-code-display');
const playerListEl = document.getElementById('player-list');
const playerCountEl = document.getElementById('player-count');
const btnStartGame = document.getElementById('btn-start-game');
const btnToggleReady = document.getElementById('btn-toggle-ready');
const readyCountEl = document.getElementById('ready-count');
const btnLeaveRoom = document.getElementById('btn-leave-room');

function showError(message) {
  lobbyError.textContent = message;
  lobbyError.hidden = false;
}

function clearError() {
  lobbyError.hidden = true;
}

function renderPlayerList(players) {
  playerListEl.innerHTML = '';
  const entries = Object.entries(players);

  entries.forEach(([uid, player]) => {
    const li = document.createElement('li');
    const hostTag = uid === currentHostId ? ' <span class="host-tag">Host</span>' : '';
    li.innerHTML = `<span class="player-dot"></span>${escapeHtml(player.name)}${hostTag}`;
    playerListEl.appendChild(li);
  });

  playerCountEl.textContent = entries.length;

  // Start-Button erst ab 3 Spielern aktivieren (Mindestanzahl des Spiels)
  btnStartGame.disabled = entries.length < 3;
}

// Zeigt an, wie viele Spieler per Abstimmung weiterspielen wollen
function renderReadyCount() {
  const n = Object.keys(latestPlayers).length;
  const ready = countReadyVotes();
  readyCountEl.textContent = `${ready} von ${n} bereit`;
  const amReady = !!latestVotes[playerId];
  btnToggleReady.textContent = amReady ? 'Bereit ✓ (zurückziehen)' : 'Ich will (nochmal) spielen';
}

// Einfacher Schutz gegen HTML-Injection über den Namen
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// ANSICHTEN
// ============================================================
function hideAllViews() {
  viewLobby.hidden = true;
  viewRoom.hidden = true;
  viewRoleReveal.hidden = true;
  viewGame.hidden = true;
  viewEnd.hidden = true;
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
const rolePoolInfoEl = document.getElementById('role-pool-info');
const btnRoleContinue = document.getElementById('btn-role-continue');

async function showRoleRevealView() {
  hideAllViews();
  viewRoleReveal.hidden = false;

  // Die Rolle kommt über den gamePlayers-Listener, NICHT per get(): get() las
  // beim Rematch den noch leeren Zwischenstand aus dem Cache, fand keine Rolle
  // und übersprang den Reveal. Wir warten, bis die Karten DIESES Spiels da sind
  // (dealId beginnt mit der gameNumber) - egal, welcher Listener zuerst feuert.
  const g = latestGame || {};
  const prefix = g.gameNumber + '-';
  let myEntry = null;
  for (let i = 0; i < 50 && !myEntry; i++) {
    const e = latestGamePlayers[playerId];
    if (e && e.role && e.dealId && e.dealId.startsWith(prefix)) myEntry = e;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!myEntry) { showGameView(); return; }
  const role = myEntry.role;
  const info = ROLE_INFO[role];

  // Zeigt die Rollen-Verteilung des Pools (nicht die tatsächlich ausgeteilte Anzahl)
  if (g.totalAdventurers != null) {
    rolePoolInfoEl.textContent =
      `Diesmal im Spiel: ${g.totalAdventurers} Abenteurer · ${g.totalGuardians} Wächterinnen`;
  }

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

// --- Spielbrett ------------------------------------------------------------
function showGameView() {
  hideAllViews();
  viewGame.hidden = false;
  document.body.classList.remove('theme-good', 'theme-bad');
  if (latestGame) renderGame(); // löst die Aufdeck-Animation der Hand aus
}

function showEndView() {
  hideAllViews();
  viewEnd.hidden = false;
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
const btnSkipTurn = document.getElementById('btn-skip-turn');

// Eigene Karten als Flip-Karten. animate=true (neue Austeilung): erst verdeckt,
// dann nacheinander aufdecken; sonst direkt aufgedeckt.
function renderMyHand(hand, animate) {
  myHandEl.innerHTML = '';
  const types = [];
  ['gold', 'trap', 'empty'].forEach((type) => {
    for (let i = 0; i < hand[type]; i++) types.push(type);
  });

  if (types.length === 0) {
    myHandEl.innerHTML = '<span class="empty-hint">Alle deine Karten wurden aufgedeckt.</span>';
    return;
  }

  types.forEach((type, idx) => {
    const flip = document.createElement('div');
    flip.className = 'my-card-flip' + (animate ? '' : ' no-anim');
    flip.innerHTML = `
      <div class="my-card-inner">
        <img src="${IMG.karteBack}" class="my-card-face my-card-back" alt="">
        <img src="${CARD_IMAGES[type]}" class="my-card-face my-card-front" alt="${CARD_LABELS[type]}" title="${CARD_LABELS[type]}">
      </div>
    `;
    myHandEl.appendChild(flip);
    // gestaffelt aufdecken, nachdem die Rundenansage verblasst ist
    if (animate) setTimeout(() => flip.classList.add('flipped'), 1700 + idx * 90);
    else flip.classList.add('flipped');
  });
}

// Große Rundenansage. Solange sie läuft (keyHiddenForRound), bleibt der
// Schlüssel der neuen Runde unsichtbar und nicht nutzbar.
let keyHiddenForRound = null;

function announceRound(roundNumber) {
  keyHiddenForRound = roundNumber;
  roundBannerTextEl.textContent = 'Runde ' + roundNumber;
  roundBannerEl.hidden = false;
  requestAnimationFrame(() => roundBannerEl.classList.add('show'));
  setTimeout(() => {
    roundBannerEl.classList.remove('show');
    setTimeout(() => {
      roundBannerEl.hidden = true;
      if (keyHiddenForRound === roundNumber) keyHiddenForRound = null;
      if (latestGame && !viewGame.hidden) renderGame();
    }, 400);
  }, 1800);
}

// --- Ablagestapel: wird nur aus dem revealLog aufgebaut ---------------------
// shownLogKeys merkt, welche Einträge schon liegen. Ein neuer Eintrag wird
// anhand seines Schlüssels erkannt (nicht anhand der Position) - so kann die
// Karte nie mit einer anderen verwechselt werden.
const shownLogKeys = new Set();

function resetCenterPile() {
  shownLogKeys.clear();
  centerPileEl.innerHTML = '';
}

function renderCenterPile(revealLog) {
  const keys = Object.keys(revealLog || {}).sort();
  if (keys.length < shownLogKeys.size) resetCenterPile(); // neues Spiel
  keys.forEach((key) => {
    if (shownLogKeys.has(key)) return;
    shownLogKeys.add(key);
    addCardToCenterPile(revealLog[key].type);
  });
}

// Legt eine aufgedeckte Karte leicht verdreht auf den Stapel
function addCardToCenterPile(type) {
  const img = document.createElement('img');
  img.className = 'center-card';
  img.src = CARD_IMAGES[type];
  img.alt = CARD_LABELS[type];
  img.style.setProperty('--rot', (Math.random() * 26 - 13) + 'deg');
  img.style.setProperty('--dx', (Math.random() * 10 - 5) + 'px');
  img.style.setProperty('--dy', (Math.random() * 10 - 5) + 'px');
  centerPileEl.appendChild(img);
}

// Für den kleinen "Tick" beim Zug-Counter, wenn sich die Zahl ändert
let lastTurnsLeft = null;

// Notfall-Timer des Hosts für eine liegengebliebene Folgeaktion (siehe applyFollowUp)
let followUpTimer = null;

function renderGame() {
  const game = latestGame;
  if (!game) return;

  roundDisplay.textContent = game.round;

  const keyHidden = keyHiddenForRound === game.round;
  const isMyTurn = !keyHidden && game.turnPlayerId === playerId;
  const turnPlayerName = (latestPlayers[game.turnPlayerId] || {}).name || '?';
  turnLabelEl.textContent = keyHidden
    ? 'Neue Runde beginnt …'
    : isMyTurn
      ? 'Du hast den Schlüssel – tippe die Karten eines Mitspielers an'
      : turnPlayerName + ' hat den Schlüssel';
  turnLabelEl.classList.toggle('turn-mine', isMyTurn);

  // Host darf überspringen, wenn der Schlüsselinhaber weg ist.
  const turnPlayerGone = !keyHidden && !latestPlayers[game.turnPlayerId];
  btnSkipTurn.hidden = !(isHost && turnPlayerGone);

  // FIX: Liegt die Folgeaktion (Rundenwechsel/Spielende) nach 4 s noch bereit,
  // ist der Aufdecker weg -> der Host führt sie aus. Normal dauert es 1,8 s.
  if (game.followUp && isHost && !followUpTimer) {
    followUpTimer = setTimeout(() => { followUpTimer = null; applyFollowUp(); }, 4000);
  }

  // --- Eigene Hand: bei neuer dealId erst verdeckt, dann aufdecken ---
  const myEntry = latestGamePlayers[playerId];
  if (myEntry && myEntry.hand) {
    const myHand = myEntry.hand;
    const handKey = myHand.empty + '-' + myHand.gold + '-' + myHand.trap;
    const shouldAnimate = !!myEntry.dealId && myEntry.dealId !== lastDealId;
    if (shouldAnimate || handKey !== lastRenderedHandKey) {
      renderMyHand(myHand, shouldAnimate);
      lastRenderedHandKey = handKey;
    }
    if (shouldAnimate) lastDealId = myEntry.dealId;
  }

  // --- Eigene Charakterkarte in der Ecke ---
  if (myEntry && myEntry.role) {
    cornerRoleFrontEl.src = ROLE_INFO[myEntry.role].image;
    cornerRoleEl.classList.remove('role-good', 'role-bad');
    cornerRoleEl.classList.add(ROLE_INFO[myEntry.role].className);
  }

  // --- Spieler im Kreis, Fächer zur Mitte gedreht. Fächer, Name und Schlüssel
  // liegen auf je eigenem Radius; ab 6 Spielern schrumpft alles etwas. ---
  const uids = Object.keys(latestGamePlayers);
  const n = uids.length;
  const seatScale = n <= 5 ? 1 : n <= 7 ? 0.85 : n <= 9 ? 0.72 : 0.6;
  const myIndex = uids.indexOf(playerId);
  seatsEl.innerHTML = '';

  uids.forEach((uid, i) => {
    // eigener Platz unten, die anderen im Uhrzeigersinn
    const slot = myIndex >= 0 ? (i - myIndex + n) % n : i;
    const angle = (2 * Math.PI * slot) / n + Math.PI / 2;
    const at = (rx, ry) => ({ left: 50 + rx * Math.cos(angle) + '%', top: 50 + ry * Math.sin(angle) + '%' });

    const entry = latestGamePlayers[uid];
    const hand = entry.hand;
    const remaining = hand.empty + hand.gold + hand.trap;
    const isMe = uid === playerId;
    const canPick = isMyTurn && !isMe && remaining > 0 && !revealInProgress;

    // Fächer: jede Karte leicht gedreht; mehr Karten = engere Überlappung
    const overlap = -(0.22 + Math.min(remaining, 8) * 0.035);
    let cardsHtml = '';
    for (let c = 0; c < remaining; c++) {
      const spread = c - (remaining - 1) / 2;
      cardsHtml += `<img src="${IMG.karteBack}" class="seat-card-back" alt=""
        style="--tilt:${spread * 5}deg; --lift:${Math.abs(spread) * 2}px">`;
    }

    const seat = document.createElement('div');
    seat.className = 'seat' + (canPick ? ' seat-pickable' : '');
    Object.assign(seat.style, at(30, 27));
    seat.innerHTML = `
      <div class="seat-fan" style="--fan:${(angle * 180) / Math.PI + 90}deg; --scale:${seatScale}">
        <div class="seat-cards" style="--ov:${overlap}">${cardsHtml}</div>
      </div>`;
    if (canPick) seat.addEventListener('click', () => revealCard(uid));
    seatsEl.appendChild(seat);

    // Name: waagerecht, weiter außen
    const nameEl = document.createElement('span');
    nameEl.className = 'seat-name';
    Object.assign(nameEl.style, at(45, 41));
    nameEl.style.setProperty('--name-scale', seatScale);
    nameEl.textContent = (entry.name || (latestPlayers[uid] || {}).name || '?') + (isMe ? ' (du)' : '');
    seatsEl.appendChild(nameEl);

    // Schlüssel: groß, zwischen Fächer und Name
    if (!keyHidden && uid === game.turnPlayerId) {
      const keyEl = document.createElement('img');
      keyEl.src = IMG.key;
      keyEl.alt = 'Schlüssel';
      keyEl.className = 'turn-key';
      Object.assign(keyEl.style, at(38, 34));
      keyEl.style.setProperty('--key-scale', seatScale);
      seatsEl.appendChild(keyEl);
    }
  });

  // --- Mitte: Restkarten-Zähler, Zug-Countdown, Ablagestapel ---
  const left = { empty: 0, gold: 0, trap: 0 };
  uids.forEach((uid) => {
    const h = latestGamePlayers[uid].hand;
    left.empty += h.empty; left.gold += h.gold; left.trap += h.trap;
  });
  // Eine Zeile: Karten im Tempel + Züge, die die Runde noch hat
  const turnsLeft = Math.max(0, n - (game.openedThisRound || 0));
  const tick = lastTurnsLeft !== null && turnsLeft !== lastTurnsLeft;
  lastTurnsLeft = turnsLeft;
  remainingCountsEl.innerHTML = `
    <div class="remaining-item"><img src="${IMG.gold}" alt=""><span>${left.gold}×</span></div>
    <div class="remaining-item"><img src="${IMG.falle}" alt=""><span>${left.trap}×</span></div>
    <div class="remaining-item"><img src="${IMG.leer}" alt=""><span>${left.empty}×</span></div>
    <div class="remaining-item remaining-turns${turnsLeft === 1 ? ' turns-last' : ''}" title="Züge in dieser Runde">
      <span class="turns-num${tick ? ' tick' : ''}">${turnsLeft}</span>
      <span class="turns-label">${turnsLeft === 1 ? 'Zug' : 'Züge'}</span>
    </div>`;

  renderCenterPile(game.revealLog);
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

// ============================================================
// ENDSCREEN – eigene Vollbild-Seite
// ============================================================
const endTitle = document.getElementById('end-title');
const endMessage = document.getElementById('end-message');
const endRolesList = document.getElementById('end-roles-list');
const btnBackToLobby = document.getElementById('btn-back-to-lobby');
const btnLeaveGame = document.getElementById('btn-leave-game');

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
    const name = latestGamePlayers[uid].name || (latestPlayers[uid] || {}).name || '?';
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
}
