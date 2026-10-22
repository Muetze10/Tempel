// ============================================================
// app.js – Einstiegspunkt: verdrahtet die Buttons mit den Funktionen
// aus den anderen Dateien. Muss in index.html ZULETZT geladen werden.
// ============================================================

watchConnection();

// Gemerkten Namen und letzten Raum-Code vorausfüllen (Cookies, siehe firebase.js)
const savedProfile = loadProfileCookies();
if (savedProfile.name) nameInput.value = savedProfile.name;
if (savedProfile.room) roomCodeInput.value = savedProfile.room;

// Raum über Link mitbringen: index.html?raum=AB3F - der Link gewinnt
// gegenüber dem gemerkten Raum, wer klickt, hat eine Absicht.
const urlraum = new URLSearchParams(location.search).get('raum');
if (urlraum) roomCodeInput.value = urlraum.toUpperCase().slice(0, 6);

// Sound an/aus (Knopf im Spielbrett-Kopf, Zustand in localStorage)
const btnSound = document.getElementById('btn-sound');
function refreshSoundGlyph() {
  btnSound.textContent = soundMuted() ? '🔇' : '🔊';
}
btnSound.addEventListener('click', () => {
  toggleSound();
  refreshSoundGlyph();
});
refreshSoundGlyph();

// Lobby
btnCreateRoom.addEventListener('click', handleCreateRoom);
btnJoinRoom.addEventListener('click', handleJoinRoom);

// Warteraum
btnStartGame.addEventListener('click', () => startGameInternal());
btnToggleReady.addEventListener('click', handleToggleReady);
btnLeaveRoom.addEventListener('click', () => leaveRoom());

// Spiel
btnRoleContinue.addEventListener('click', () => showGameView());
btnSkipTurn.addEventListener('click', () => skipAbsentTurn());

// Endscreen (für jeden Spieler beide Optionen)
btnLeaveGame.addEventListener('click', () => leaveRoom());

btnBackToLobby.addEventListener('click', async () => {
  latestGame = null;
  autoStartAttempted = false;
  resetCenterPile();
  document.body.classList.remove('theme-good', 'theme-bad');
  // Die Listener bleiben aktiv - sie müssen das nächste Spiel erkennen.
  await db.ref('rooms/' + currentRoomCode).update({
    status: 'lobby', gamePlayers: null, game: null, replayVotes: null,
    lastActivityAt: firebase.database.ServerValue.TIMESTAMP
  });
});
