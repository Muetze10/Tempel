// ============================================================
// ui.js – Alles Sichtbare: DOM-Referenzen, Ansichten wechseln,
// Rendering von Warteraum, Rollen-Reveal, Spielbrett und Endscreen.
//
// Braucht: db, playerId, currentRoomCode, isHost, currentHostId,
// latestPlayers, latestVotes (firebase.js), latestGame,
// latestGamePlayers, revealInProgress, revealCard() (game.js), IMG/
// CARD_IMAGES/CARD_LABELS/ROLE_INFO (config.js).
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

const roomCodeDisplay = document.getElementById('room-code-display');
const playerListEl = document.getElementById('player-list');
const playerCountEl = document.getElementById('player-count');
const btnStartGame = document.getElementById('btn-start-game');
const btnToggleReady = document.getElementById('btn-toggle-ready');
const readyCountEl = document.getElementById('ready-count');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const statsListEl = document.getElementById('stats-list');

// Zeigt ein paar "Auszeichnungen" aus den gesammelten Raum-Statistiken.
// stats sieht pro Spieler so aus: { name, games, wins, guardian, traps, gold }
function renderStats(stats) {
  if (!statsListEl) return;
  const entries = Object.values(stats || {}).filter((s) => s.games > 0);
  if (entries.length === 0) { statsListEl.innerHTML = ''; return; }

  // Kleine Helfer-Funktion: findet den Spieler mit dem hoechsten Wert in "key"
  const topOf = (key) => entries.reduce((a, b) => (b[key] > a[key] ? b : a), entries[0]);

  const awards = [
    ['🏆 Meiste Siege', topOf('wins'), 'wins'],
    ['🗡️ Öfteste Wächterin', topOf('guardian'), 'guardian'],
    ['💀 Pechvogel (meiste Fallen)', topOf('traps'), 'traps'],
    ['✨ Glückspilz (meistes Gold)', topOf('gold'), 'gold']
  ].filter(([, player, key]) => player[key] > 0);

  statsListEl.innerHTML = awards
    .map(([label, player, key]) => `<li>${label}: <strong>${escapeHtml(player.name)}</strong> (${player[key]})</li>`)
    .join('');
}

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
  const ready = Object.values(latestVotes).filter(Boolean).length;
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
const rolePoolInfoEl = document.getElementById('role-pool-info');
const btnRoleContinue = document.getElementById('btn-role-continue');

async function showRoleRevealView() {
  hideAllViews();
  viewRoleReveal.hidden = false;

  const roomRef = db.ref('rooms/' + currentRoomCode);
  const [roleSnap, gameSnap] = await Promise.all([
    roomRef.child('gamePlayers/' + playerId + '/role').get(),
    roomRef.child('game').get()
  ]);
  const role = roleSnap.val();
  if (!role) { showGameView(); return; }
  const info = ROLE_INFO[role];
  const g = gameSnap.val() || {};

  // Zeigt die Rollen-VERTEILUNG aus dem Kartenpool, nicht die tatsächlich
  // ausgeteilte Anzahl - da manchmal eine Karte unbenutzt bleibt, würde die
  // exakte Verteilung sonst Rückschlüsse zulassen. So bleibt sie verschleiert.
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
  document.body.classList.remove('theme-good', 'theme-bad'); // Farb-Hinweis nicht mit ins Spiel nehmen
  if (latestGame) renderGame(); // erster Render hier löst ggf. die Aufdeck-Animation aus
}

function showEndView() {
  hideAllViews();
  viewEnd.hidden = false;
  document.body.classList.add('body-endscreen'); // eigener Vollbild-Endscreen
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

// Baut die eigenen Karten als kleine Flip-Karten.
// animate=true (Rundenstart): erst verdeckt zeigen, dann reihum aufdecken.
// animate=false (z. B. ein anderer Spieler deckt zwischendurch eine meiner
// Karten auf): direkt aufgedeckt zeigen, ohne die Animation zu wiederholen.
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

    if (animate) {
      // Leicht gestaffelt, zeitlich abgestimmt darauf, dass die große
      // Rundenansage (falls vorhanden) gerade verblasst ist.
      setTimeout(() => flip.classList.add('flipped'), 1700 + idx * 90);
    } else {
      flip.classList.add('flipped');
    }
  });
}

// Große Rundenansage, die kurz über dem Bildschirm eingeblendet wird.
// Verwaltet nebenbei auch, bis wann der Schlüssel fuer diese Runde noch
// versteckt bleibt (keyHiddenForRound) - alles an einer Stelle, statt über
// zwei Dateien mit eigenem Timer verteilt (das war fehleranfällig).
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
      if (latestGame && !viewGame.hidden) renderGame(); // Schlüssel jetzt sichtbar machen
    }, 400);
  }, 1800);
}

function renderGame() {
  const game = latestGame;
  if (!game) return;

  roundDisplay.textContent = game.round;

  // Waehrend die grosse Rundenanzeige noch laeuft, bleibt der Schluessel
  // unsichtbar/nicht nutzbar - er "wandert" optisch erst danach zum naechsten
  // Spieler (siehe keyHiddenForRound, verwaltet in announceRound oben).
  const keyHidden = keyHiddenForRound === game.round;
  const isMyTurn = !keyHidden && game.turnPlayerId === playerId;
  const turnPlayerName = (latestPlayers[game.turnPlayerId] || {}).name || '?';
  turnLabelEl.textContent = keyHidden
    ? 'Neue Runde beginnt …'
    : game.revealPending
      ? turnPlayerName + ' hat den Schlüssel – Karte wird aufgedeckt …'
    : isMyTurn
      ? 'Du hast den Schlüssel – tippe die Karten eines Mitspielers an'
      : turnPlayerName + ' hat den Schlüssel';
  turnLabelEl.classList.toggle('turn-mine', isMyTurn);

  // Vorschlag fuer Aussteiger waehrend einer Runde: automatisch erkennen
  // lassen wir es bewusst nicht (zu fehleranfaellig bei kurzen Wackel-
  // Verbindungen) - stattdessen darf der Host den Zug manuell weiterreichen,
  // sobald der aktuelle Schluesselinhaber nicht mehr in der Spielerliste steht.
  const turnPlayerGone = !keyHidden && !latestPlayers[game.turnPlayerId];
  btnSkipTurn.hidden = !(isHost && turnPlayerGone);

  // --- Reihenfolge "erst Schlüssel weiter, dann Karte verschwindet" -------
  // In der Datenbank passiert das Aufdecken weiterhin in einem einzigen,
  // sicheren Schreibvorgang (kein Risiko durch aufgeteilte Schreibzugriffe).
  // Damit es für alle aber auch so AUSSIEHT, als würde der Schlüssel zuerst
  // wandern und erst danach die Karte verschwinden, wird die zuletzt
  // aufgedeckte Karte hier lokal noch für einen kurzen Moment so angezeigt,
  // als läge sie noch beim Zielspieler (effectiveGamePlayers) - der Schlüssel
  // (turnPlayerId, s. o.) zeigt in dieser Zeit aber schon den neuen Inhaber.
  const logEntries = Object.values(game.revealLog || {});
  if (logEntries.length < centerPileCount) {
    centerPileEl.innerHTML = '';
    centerPileCount = 0;
    pendingReveal = null;
  }
  if (!pendingReveal && logEntries.length > centerPileCount) {
    // Backlog (z. B. nach Wiedereinstieg) sofort nachholen, nur der
    // allerneueste Eintrag bekommt die kleine Verzoegerung.
    while (centerPileCount < logEntries.length - 1) {
      addCardToCenterPile(logEntries[centerPileCount].type);
      centerPileCount++;
    }
    const nextEntry = logEntries[centerPileCount];
    pendingReveal = { uid: nextEntry.playerId, type: nextEntry.type };
    setTimeout(() => {
      addCardToCenterPile(pendingReveal.type);
      centerPileCount++;
      pendingReveal = null;
      if (latestGame && !viewGame.hidden) renderGame();
    }, 550);
  }

  // "Effektive" Spielerdaten: fuer den Moment der Verzoegerung so, als haette
  // der Zielspieler seine Karte noch (eine mehr vom aufgedeckten Typ).
  let effectiveGamePlayers = latestGamePlayers;
  if (pendingReveal && latestGamePlayers[pendingReveal.uid]) {
    const p = latestGamePlayers[pendingReveal.uid];
    effectiveGamePlayers = {
      ...latestGamePlayers,
      [pendingReveal.uid]: { ...p, hand: { ...p.hand, [pendingReveal.type]: p.hand[pendingReveal.type] + 1 } }
    };
  }

  // --- Eigene Karten: beim Rundenstart erst verdeckt, dann aufdecken -----
  // (und danach aufgedeckt bleiben, bis die nächste Runde beginnt)
  //
  // Jede Austeilung hat eine ID (dealId), die bei den Karten des Spielers
  // selbst steht und damit zeitgleich mit ihnen ankommt. Aendert sich die ID,
  // wurde neu ausgeteilt: Karten erst verdeckt zeigen, dann aufdecken. Das
  // haengt an keinem Listener und keiner Reihenfolge - deshalb klappt es bei
  // JEDEM Spieler, nicht nur bei dem, der die Runde ausgeloest hat.
  const myEntry = effectiveGamePlayers[playerId];
  if (myEntry && myEntry.hand) {
    const myHand = myEntry.hand;
    const handKey = myHand.empty + '-' + myHand.gold + '-' + myHand.trap;
    const shouldAnimate = !!myEntry.dealId && myEntry.dealId !== lastDealId;
    if (shouldAnimate || handKey !== lastRenderedHandKey) {
      renderMyHand(myHand, shouldAnimate);
      lastRenderedHandKey = handKey;
    }
    if (shouldAnimate) lastDealId = myEntry.dealId; // fuer diese Austeilung erledigt
  }

  // --- Eigene Charakterkarte in der Ecke (verdeckt) ---
  const myRole = latestGamePlayers[playerId] ? latestGamePlayers[playerId].role : null;
  if (myRole) {
    cornerRoleFrontEl.src = ROLE_INFO[myRole].image;
    cornerRoleEl.classList.remove('role-good', 'role-bad');
    cornerRoleEl.classList.add(ROLE_INFO[myRole].className);
  }

  // --- Spieler rund um den Tempel, Karten faecherfoermig zur Mitte gedreht ---
  // Kartenfaecher, Name UND Schluessel werden getrennt positioniert (je ein
  // eigener Radius), damit sich bei vielen Spielern nichts ueberlappt. Ab 6+
  // Spielern schrumpft zusaetzlich ein Skalierungsfaktor Faecher und Schrift,
  // damit die Sitze trotz mehr Spielern auf dem Kreis Platz haben.
  const uids = Object.keys(effectiveGamePlayers);
  const n = uids.length;
  seatsEl.innerHTML = '';

  const seatScale = n <= 5 ? 1 : n <= 7 ? 0.85 : n <= 9 ? 0.72 : 0.6;

  uids.forEach((uid, i) => {
    // Eigener Platz immer unten, die anderen im Uhrzeigersinn darum herum
    const myIndex = uids.indexOf(playerId);
    const slot = myIndex >= 0 ? (i - myIndex + n) % n : i;
    const angle = (2 * Math.PI * slot) / n + Math.PI / 2; // Slot 0 = unten

    const left = 50 + 30 * Math.cos(angle);
    const top  = 50 + 27 * Math.sin(angle);
    const nameLeft = 50 + 45 * Math.cos(angle);
    const nameTop  = 50 + 41 * Math.sin(angle);
    // Der Schluessel liegt AUF EINEM EIGENEN Radius zwischen Faecher und
    // Name - so kollidiert er mit keinem von beiden und ist trotzdem klar
    // dem richtigen Spieler zugeordnet.
    const keyLeft = 50 + 38 * Math.cos(angle);
    const keyTop  = 50 + 34 * Math.sin(angle);
    const fanRotation = (angle * 180) / Math.PI + 90; // tangential zur Mitte

    const entry = effectiveGamePlayers[uid];
    const hand = entry.hand;
    const remaining = hand.empty + hand.gold + hand.trap;
    const name = entry.name || (latestPlayers[uid] || {}).name || '?';
    const isTurn = !keyHidden && uid === game.turnPlayerId;
    const isMe = uid === playerId;
    const canPick = isMyTurn && !isMe && remaining > 0 && !revealInProgress && !game.revealPending;

    const seat = document.createElement('div');
    seat.className = 'seat'
      + (canPick ? ' seat-pickable' : '')
      + (isMe ? ' seat-me' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';

    // Karten leicht gefaechert: jede Karte bekommt eine eigene kleine Drehung.
    // Die Ueberlappung (--ov) waechst mit der Kartenanzahl, damit der Faecher
    // bei vollen 5 Karten nie in den Nachbar-Sitz ragt - die Karten selbst
    // bleiben dabei in voller Groesse (--card-w wird nicht verkleinert).
    const overlap = -(0.22 + Math.min(remaining, 8) * 0.035);
    let cardsHtml = '';
    for (let c = 0; c < remaining; c++) {
      const spread = (c - (remaining - 1) / 2);
      cardsHtml += `<img src="${IMG.karteBack}" class="seat-card-back" alt=""
        style="--tilt:${spread * 5}deg; --lift:${Math.abs(spread) * 2}px">`;
    }

    seat.innerHTML = `
      <div class="seat-fan" style="--fan:${fanRotation}deg; --scale:${seatScale}">
        <div class="seat-cards" style="--ov:${overlap}">${cardsHtml}</div>
      </div>
    `;

    if (canPick) seat.addEventListener('click', () => revealCard(uid));
    seatsEl.appendChild(seat);

    // Name als eigenes Element auf groesserem Radius - bleibt immer waagerecht
    // und kollidiert dadurch nicht mit dem Kartenfaecher der Nachbarn.
    const nameEl = document.createElement('span');
    nameEl.className = 'seat-name';
    nameEl.style.left = nameLeft + '%';
    nameEl.style.top = nameTop + '%';
    nameEl.style.setProperty('--name-scale', seatScale);
    nameEl.textContent = name + (isMe ? ' (du)' : '');
    seatsEl.appendChild(nameEl);

    // Schluessel: groß, eigenes Element, eigener Radius - eindeutig sichtbar,
    // wer gerade am Zug ist, statt als kleines Icon neben dem Namen unterzugehen.
    if (isTurn) {
      const keyEl = document.createElement('img');
      keyEl.src = IMG.key;
      keyEl.alt = 'Schlüssel';
      keyEl.className = 'turn-key';
      keyEl.style.left = keyLeft + '%';
      keyEl.style.top = keyTop + '%';
      keyEl.style.setProperty('--key-scale', seatScale);
      seatsEl.appendChild(keyEl);
    }
  });

  // --- Wie viele Karten welcher Art noch unentdeckt im Tempel liegen ---
  const left = { empty: 0, gold: 0, trap: 0 };
  uids.forEach((uid) => {
    const h = effectiveGamePlayers[uid].hand;
    left.empty += h.empty;
    left.gold  += h.gold;
    left.trap  += h.trap;
  });

  remainingCountsEl.innerHTML = `
    <div class="remaining-item"><img src="${IMG.gold}" alt=""><span>${left.gold}×</span></div>
    <div class="remaining-item"><img src="${IMG.falle}" alt=""><span>${left.trap}×</span></div>
    <div class="remaining-item"><img src="${IMG.leer}" alt=""><span>${left.empty}×</span></div>
  `;
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
