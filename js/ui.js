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
const btnCopyRoomCode = document.getElementById('btn-copy-room-code');
const roomCodeCopyHint = document.getElementById('room-code-copy-hint');
const playerListEl = document.getElementById('player-list');
const playerCountEl = document.getElementById('player-count');
const btnStartGame = document.getElementById('btn-start-game');
const btnToggleReady = document.getElementById('btn-toggle-ready');
const readyCountEl = document.getElementById('ready-count');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const roomLiveHintEl = document.getElementById('room-live-hint');

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

  // Auch aus dem Warteraum: weniger als 2 im laufenden Spiel? Dann endet es
  // gleich (siehe scheduleUnderstaffedCheck).
  scheduleUnderstaffedCheck();
}

// Hinweis im Warteraum, dass ein Spiel läuft und man beim nächsten dabei ist.
// Zeigt er nur, wenn ein Spiel läuft UND man selbst NICHT darin mitspielt
// (Wiedereinsteiger sitzen ja im Spiel). Der Status-Listener und der
// gamePlayers-Listener schalten ihn.
function updateRunningGameHint() {
  if (!roomLiveHintEl) return;
  const inGame = !!(latestGamePlayers && latestGamePlayers[playerId]);
  roomLiveHintEl.hidden = !(latestStatus === 'playing' && !inGame);
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
  // Hintergrund-Szene zurücksetzen: alle Ansichten außer dem Warteraum zeigen
  // den Spielplan als Hintergrund (siehe body.temple-waiting in style.css).
  document.body.classList.remove('temple-waiting');
  viewLobby.hidden = true;
  viewRoom.hidden = true;
  viewRoleReveal.hidden = true;
  viewGame.hidden = true;
  viewEnd.hidden = true;
  // Laufender Endscreen-Timer ist hinfällig (z. B. zurück in den Warteraum)
  if (typeof endScreenTimer !== 'undefined' && endScreenTimer) {
    clearTimeout(endScreenTimer);
    endScreenTimer = null;
  }
}

function showRoomView() {
  hideAllViews();
  // Warteraum kennt seine eigene Hintergrunddatei (Tempel_Warteraum_Hintergrund)
  document.body.classList.add('temple-waiting');
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
  // laufender (Sieges-)Sound wird beendet, ein neues Spiel beginnt
  if (typeof stopAllSounds === 'function') stopAllSounds();
  viewRoleReveal.hidden = false;
  roleCardTextEl.textContent = 'Neues Spiel beginnt …'; // bis die eigene Rolle da ist

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
    else {
      // Wartender Gast (Beitritt während des Spiels): Die Verteilung ist da und
      // ich bin nicht Teil davon - dann zurück in den Warteraum, nicht bis zum
      // Ende auf eine Rolle warten, die nie kommt.
      if (i >= 20 && latestStatus === 'playing'
        && latestGamePlayers && Object.keys(latestGamePlayers).length > 0
        && !latestGamePlayers[playerId]) {
        showRoomView();
        updateRunningGameHint();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
  roleCardImageEl.decoding = 'async';
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

let endScreenTimer = null;

function switchToEndView() {
  hideAllViews();
  viewEnd.hidden = false;
  renderEndView();
}

// Gewinnsound klingt, das SPIELFELD bleibt noch 6,5 s stehen - dann erst der
// Endscreen mit der Rollenenthüllung.
function showEndView() {
  showEndView._playedKey = showEndView._playedKey || '';
  const seqKey = currentRoomCode + '#' + ((latestGame && latestGame.gameNumber) || 0);
  if (showEndView._playedKey !== seqKey) {
    showEndView._playedKey = seqKey;
    playSound('end', latestGame && latestGame.winner === 'adventurer');
    if (endScreenTimer) clearTimeout(endScreenTimer);
    endScreenTimer = setTimeout(() => {
      endScreenTimer = null;
      switchToEndView();
    }, 6500);
    return;
  }
  // Wiedereinstieg in ein schon gehörtes Ende: Endscreen direkt zeigen
  if (!endScreenTimer) switchToEndView();
}

const roundDisplay = document.getElementById('round-display');
const myHandEl = document.getElementById('my-hand');
const turnLabelEl = document.getElementById('turn-label');
const seatsEl = document.getElementById('seats');
const centerZoneEl = document.getElementById('center-zone');
const centerPileEl = document.getElementById('center-pile');
const remainingCountsEl = document.getElementById('remaining-counts');
const roundBannerEl = document.getElementById('round-banner');
const roundBannerTextEl = document.getElementById('round-banner-text');
const cornerRoleEl = document.getElementById('corner-role');
const cornerRoleFrontEl = document.getElementById('corner-role-front');
const btnSkipTurn = document.getElementById('btn-skip-turn');
const roomNoteEl = document.getElementById('room-note');

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
        <img src="${IMG.karteBack}" class="my-card-face my-card-back" alt="" decoding="async">
        <img src="${CARD_IMAGES[type]}" class="my-card-face my-card-front" alt="${CARD_LABELS[type]}" title="${CARD_LABELS[type]}" decoding="async">
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
  // Rundenansage leiser, nicht aggressiv
  playSound('round');
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
  lastCornerRole = null;
  centerPileEl.innerHTML = '';
}

function renderCenterPile(revealLog) {
  const keys = Object.keys(revealLog || {}).sort();
  if (keys.length < shownLogKeys.size) resetCenterPile(); // neues Spiel
  let fresh = 0;
  keys.forEach((key) => {
    if (shownLogKeys.has(key)) return;
    shownLogKeys.add(key);
    addCardToCenterPile(revealLog[key].type);
    fresh++;
  });
  // Der Stapel aktualisiert sich bei allen Clients über den revealLog - deshalb
  // klingt der Karteneffekt hier (Gold/Falle/Karte), nicht nur beim Aufdecker.
  // Nur bei EINER neuen Karte klingt es - beim Wiedereinstieg (ganzer Stapel
  // neu aufgebaut) wäre es nur Geraeusch.
  if (fresh === 1) {
    const freshType = revealLog[keys[keys.length - 1]].type;
    playSound(freshType === 'gold' ? 'gold' : freshType === 'trap' ? 'trap' : 'card');
  }
}

// Legt eine aufgedeckte Karte leicht verdreht auf den Stapel
function addCardToCenterPile(type) {
  const img = document.createElement('img');
  img.className = 'center-card';
  img.src = CARD_IMAGES[type];
  img.alt = CARD_LABELS[type];
  img.decoding = 'async';
  img.style.setProperty('--rot', (Math.random() * 26 - 13) + 'deg');
  img.style.setProperty('--dx', (Math.random() * 10 - 5) + 'px');
  img.style.setProperty('--dy', (Math.random() * 10 - 5) + 'px');
  centerPileEl.appendChild(img);
}

// Für den kleinen "Tick" beim Zug-Counter, wenn sich die Zahl ändert
let lastTurnsLeft = null;

// zuletzt gezeichnete Rollenkarte in der Ecke (verhindert stetiges Neusetzen)
let lastCornerRole = null;

// Zwischengespeicherte Restkarten-Zeile: verhindert das Neuanlegen der Icons
// bei jedem Firebase-Event (siehe renderGame).
let lastRenderedCountsHtml = null;

// Notfall-Timer des Hosts für eine liegengebliebene Folgeaktion (siehe applyFollowUp)
let followUpTimer = null;

// Schrumpfstufen bei vielen Spielern – gilt für Fächer UND den
// abgelegten Stapel in der Mitte, damit beiden genug Platz bleibt.
function zoneScale(n) {
  return n <= 5 ? 1 : n <= 7 ? 0.85 : n <= 9 ? 0.72 : 0.6;
}

// --- Geister im Spiel: automatischer Skip + Sofort-Ende ---------------------
// JEDER anwesende Client bemerkt selbst, dass einer weg ist - nicht nur der
// Host mit seinem Skip-Button. Die Wartefrist deckt kurze Funkstille ab; die
// Transaktion in game.js prüft alles frisch, Wettläufe mehrerer Clients
// schaden also nicht (nur einer gewinnt).

let absentSkipTimer = null;
let absentSkipSeq = null;

function clearAbsentSkip() {
  if (absentSkipTimer) clearTimeout(absentSkipTimer);
  absentSkipTimer = null;
  absentSkipSeq = null;
}

function scheduleAbsentSkip() {
  const g = latestGame;
  const gameRuns = g && !g.winner && !g.followUp;
  const turnGone = gameRuns && !keyHiddenForRound && g.turnPlayerId
    && !isAroundNow(g.turnPlayerId, latestPlayers);
  if (!turnGone) { clearAbsentSkip(); return; }
  const seq = g.moveSeq || 0;
  if (absentSkipTimer && absentSkipSeq === seq) return; // für diesen Zug schon geplant
  clearAbsentSkip();
  absentSkipSeq = seq;
  // 7–9,5 s: genug Zeit für Funkstille, kurz genug, dass es nicht "hänge" wirkt
  absentSkipTimer = setTimeout(() => {
    absentSkipTimer = null;
    skipGhostTurn(false);
  }, 7000 + Math.random() * 2500);
}

let understaffedTimer = null;

function clearUnderstaffedCheck() {
  if (understaffedTimer) clearTimeout(understaffedTimer);
  understaffedTimer = null;
}

// Solange weniger als 2 Mitspieler wirklich da sind, endet das Spiel gleich
// (Wächter-Sieg). 20 s Gnade - ein Handy, das kurz abtaucht, darf zurückkommen.
function scheduleUnderstaffedCheck() {
  const g = latestGame;
  const present = (g && !g.winner && !g.followUp)
    ? countPresentGamePlayers()
    : null;
  if (present !== 1) { clearUnderstaffedCheck(); updateRoomNote(); return; }
  if (understaffedTimer) return;
  understaffedTimer = setTimeout(() => {
    understaffedTimer = null;
    endIfUnderstaffed();
  }, 20000);
}

// Anweisungen über dem Brett, solange das Spiel stirbt oder jemand fehlt
function updateRoomNote() {
  if (!roomNoteEl) return;
  const g = latestGame;
  let text = '';
  if (g && !g.winner && !g.followUp) {
    const present = countPresentGamePlayers();
    if (present === 1) text = 'Nur noch ein Spieler dabei – das Spiel endet gleich.';
    else if (present === 0) text = 'Niemand ist im Spiel – der Raum wird gleich zurückgesetzt.';
  }
  roomNoteEl.textContent = text;
  roomNoteEl.hidden = !text;
}

// Wie viele Spieler des laufenden Spiels sind wirklich noch anwesend?
// (gamePlayers minus die, deren lastSeen stale ist)
function countPresentGamePlayers() {
  return Object.keys(latestGamePlayers).filter((uid) => isAroundNow(uid, latestPlayers)).length;
}

// Baut den Spielerkreis auf. Wird nur gerufen, wenn sich der Spielzustand
// geändert hat (siehe seatsKey in renderGame) - ein Neuaufbau bei jedem
// Firebase-Event würde die Kartenbilder samt Animation ständig neu starten.
function renderSeats(game, uids, { keyHidden, isMyTurn, turnPlayerGone }) {
  const n = uids.length;
  const seatScale = zoneScale(n);
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
    // Sitz ausgrauen, wenn der Spieler gegangen ist (oder sein Tab seit >50 s
    // nichts gemeldet hat) - man sieht sofort, wessen Karten "Geisterkarten"...
    const gone = !isAroundNow(uid, latestPlayers);

    // Fächer: jede Karte leicht gedreht; mehr Karten = engere Überlappung
    const overlap = -(0.22 + Math.min(remaining, 8) * 0.035);
    let cardsHtml = '';
    for (let c = 0; c < remaining; c++) {
      const spread = c - (remaining - 1) / 2;
      cardsHtml += `<img src="${IMG.karteBack}" class="seat-card-back" alt="" decoding="async"
        style="--tilt:${spread * 5}deg; --lift:${Math.abs(spread) * 2}px">`;
    }

    const seat = document.createElement('div');
    seat.className = 'seat' + (canPick ? ' seat-pickable' : '') + (gone && !isMe ? ' seat-gone' : '');
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
    const goneTag = gone && !isMe ? ' (gegangen)' : '';
    nameEl.textContent = (entry.name || (latestPlayers[uid] || {}).name || '?') + (isMe ? ' (du)' : '') + goneTag;
    if (gone && !isMe) nameEl.classList.add('seat-name-gone');
    seatsEl.appendChild(nameEl);

    // Schlüssel: groß, zwischen Fächer und Name
    if (!keyHidden && uid === game.turnPlayerId) {
      const keyEl = document.createElement('img');
      keyEl.src = IMG.key;
      keyEl.decoding = 'async';
      keyEl.alt = 'Schlüssel';
      keyEl.className = 'turn-key';
      Object.assign(keyEl.style, at(38, 34));
      keyEl.style.setProperty('--key-scale', seatScale);
      seatsEl.appendChild(keyEl);
    }
  });
}

function renderGame() {
  const game = latestGame;
  if (!game) return;

  roundDisplay.textContent = game.round;

  const keyHidden = keyHiddenForRound === game.round;
  const isMyTurn = !keyHidden && game.turnPlayerId === playerId;
  // Host darf überspringen, wenn der Schlüsselinhaber weg ist - jetzt auch
  // über lastSeen (frisch < 50 s), nicht nur wenn der Listeneintrag fehlt.
  const turnPlayerGone = !keyHidden && !isAroundNow(game.turnPlayerId, latestPlayers);
  // Name des Schlüsselinhabers: erst aus der Spielerliste, sonst aus dem
  // Spielstand (der bleibt, wenn jemand geht - die Anzeige soll nicht "?" zeigen).
  const turnPlayerName = (latestPlayers[game.turnPlayerId] || {}).name
    || (latestGamePlayers[game.turnPlayerId] || {}).name
    || '?';
  turnLabelEl.textContent = keyHidden
    ? 'Neue Runde beginnt …'
    : isMyTurn
      ? 'Du hast den Schlüssel – tippe die Karten eines Mitspielers an'
      : turnPlayerGone
        ? turnPlayerName + ' ist weg – Zug wird übersprungen …'
        : turnPlayerName + ' hat den Schlüssel';
  turnLabelEl.classList.toggle('turn-mine', isMyTurn);
  updateRoomNote();

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
  if (myEntry && myEntry.role && myEntry.role !== lastCornerRole) {
    lastCornerRole = myEntry.role;
    cornerRoleFrontEl.src = ROLE_INFO[myEntry.role].image;
    cornerRoleFrontEl.decoding = 'async';
    cornerRoleEl.classList.remove('role-good', 'role-bad');
    cornerRoleEl.classList.add(ROLE_INFO[myEntry.role].className);
  }

  // --- Spieler im Kreis, Fächer zur Mitte gedreht. Fächer, Name und Schlüssel
  // liegen auf je eigenem Radius; ab 6 Spielern schrumpft alles etwas. ---
  const uids = Object.keys(latestGamePlayers);
  const n = uids.length;

  // Sitze nur neu bauen, wenn sich der Spielzustand wirklich geändert hat.
  // Zuvor wurde bei JEDEM Firebase-Event (Herzschlag aller 15 s, Host-Wechsel,
  // Status-Update, ...) das gesamte Sitze-DOM inklusive aller Kartenbilder und
  // Click-Handler erneuert - das war das spürbare Ruckeln beim Spielen.
  const seatsKey = [
    game.moveSeq, game.round, game.turnPlayerId, game.openedThisRound,
    game.followUp ? 1 : 0, keyHidden ? 1 : 0, isMyTurn ? 1 : 0, isHost ? 1 : 0,
    turnPlayerGone ? 1 : 0, revealInProgress ? 1 : 0,
    n, Object.keys(latestPlayers).length,
    uids.map((uid) => {
      const h = latestGamePlayers[uid].hand;
      // +a/anwesend, +g/gegangen: der Abgang soll sichtbar (ausgegraut) werden
      return uid + ':' + h.empty + h.gold + h.trap + (isAroundNow(uid, latestPlayers) ? '+a' : '+g');
    }).join(',')
  ].join('|');
  if (seatsKey !== lastRenderedSeatsKey) {
    lastRenderedSeatsKey = seatsKey;
    renderSeats(game, uids, { keyHidden, isMyTurn, turnPlayerGone });
  }

  // --- Mitte: Restkarten-Zähler, Zug-Countdown, Ablagestapel ---
  // Stapelgroesse passt sich der Spielerzahl an (gleiche Stufen wie die Fächer)
  centerZoneEl.style.setProperty('--pile-scale', zoneScale(uids.length));
  const left = { empty: 0, gold: 0, trap: 0 };
  uids.forEach((uid) => {
    const h = latestGamePlayers[uid].hand;
    left.empty += h.empty; left.gold += h.gold; left.trap += h.trap;
  });
  // Eine Zeile: Karten im Tempel + Züge, die die Runde noch hat
  const turnsLeft = Math.max(0, n - (game.openedThisRound || 0));
  const tick = lastTurnsLeft !== null && turnsLeft !== lastTurnsLeft;
  lastTurnsLeft = turnsLeft;
  // Nur neu setzen, wenn sich etwas aendert - sonst wuerde jede
  // Firebase-Aktivitaet (z. B. nur ein Herzschlag) die Icons neu anlegen
  // und den Tick-Animationseffekt stoeren.
  const countsHtml = `
    <div class="remaining-item"><img src="${IMG.gold}" alt="" decoding="async"><span>${left.gold}×</span></div>
    <div class="remaining-item"><img src="${IMG.falle}" alt="" decoding="async"><span>${left.trap}×</span></div>
    <div class="remaining-item"><img src="${IMG.leer}" alt="" decoding="async"><span>${left.empty}×</span></div>
    <div class="remaining-item remaining-turns${turnsLeft === 1 ? ' turns-last' : ''}" title="Züge in dieser Runde">
      <span class="turns-num${tick ? ' tick' : ''}">${turnsLeft}</span>
      <span class="turns-label">${turnsLeft === 1 ? 'Zug' : 'Züge'}</span>
    </div>`;
  if (countsHtml !== lastRenderedCountsHtml) {
    lastRenderedCountsHtml = countsHtml;
    remainingCountsEl.innerHTML = countsHtml;
  }

  renderCenterPile(game.revealLog);

  // Geist-Uhrwerk: automatischer Skip und Unterbesessenheits-Check
  scheduleAbsentSkip();
  scheduleUnderstaffedCheck();
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
