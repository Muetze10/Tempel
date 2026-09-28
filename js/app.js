// ============================================================
// app.js – Einstiegspunkt. Verdrahtet jeden Button mit der
// passenden Funktion aus config.js/firebase.js/game.js/ui.js.
//
// WICHTIG für die Ladereihenfolge in index.html:
//   config.js -> firebase.js -> game.js -> ui.js -> app.js
// app.js muss ZULETZT geladen werden, weil hier auf Funktionen
// zugegriffen wird, die in den anderen vier Dateien definiert sind.
// ============================================================

// --- Lobby ---
btnCreateRoom.addEventListener('click', handleCreateRoom);
btnJoinRoom.addEventListener('click', handleJoinRoom);

// --- Warteraum ---
btnStartGame.addEventListener('click', () => startGameInternal());
btnToggleReady.addEventListener('click', handleToggleReady);
btnLeaveRoom.addEventListener('click', () => leaveRoom());

btnSkipTurn.addEventListener('click', () => skipAbsentTurn());

// --- Rollen-Reveal ---
btnRoleContinue.addEventListener('click', () => showGameView());

// --- Endscreen: für JEDEN Spieler beide Optionen ---
btnLeaveGame.addEventListener('click', () => leaveRoom());

btnBackToLobby.addEventListener('click', async () => {
  centerPileCount = 0;
  centerPileEl.innerHTML = '';
  latestGame = null;
  autoStartAttempted = false;
  document.body.classList.remove('theme-good', 'theme-bad');
  // WICHTIG: die game-/gamePlayers-Listener bleiben aktiv (nicht .off()) -
  // sie laufen für die ganze Raum-Session und müssen das NÄCHSTE Spiel
  // erkennen können. Nur beim tatsächlichen Verlassen des Raums (leaveRoom)
  // werden sie abgehängt.
  await db.ref('rooms/' + currentRoomCode).update({
    status: 'lobby', gamePlayers: null, game: null, replayVotes: null
  });
});
