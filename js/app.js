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
if (urlraum) {
  roomCodeInput.value = urlraum.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  // Falls bereits ein Name eingetragen ist, direkt versuchen beizutreten
  if (nameInput.value.trim()) {
    setTimeout(() => {
      try { btnJoinRoom.click(); } catch (e) { /* ignorieren */ }
    }, 350);
  }
}

// Sound an/aus (Knopf in der rechten Ecke des Spielbretts, Zustand in localStorage)
const btnSound = document.getElementById('btn-sound');
if (btnSound) {
  function refreshSoundGlyph() {
    btnSound.classList.toggle('muted', soundMuted());
  }
  btnSound.addEventListener('click', () => {
    toggleSound();
    refreshSoundGlyph();
  });
  refreshSoundGlyph();
}

// Lobby
btnCreateRoom.addEventListener('click', () => {
  const name = (nameInput.value || '').trim();
  if (!name) { showError('Bitte gib zuerst deinen Namen ein.'); nameInput.focus(); return; }
  handleCreateRoom();
});
btnJoinRoom.addEventListener('click', () => {
  const code = (roomCodeInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!code) { showError('Bitte gib einen Raum-Code ein.'); return; }
  roomCodeInput.value = code;
  handleJoinRoom();
});

// Warteraum
btnStartGame.addEventListener('click', () => startGameInternal());
btnToggleReady.addEventListener('click', handleToggleReady);
btnLeaveRoom.addEventListener('click', () => { if (confirm('Wirklich aus diesem Raum verlassen?')) leaveRoom(); });

// Spiel
btnRoleContinue.addEventListener('click', () => showGameView());
btnSkipTurn.addEventListener('click', () => skipAbsentTurn());

// Endscreen (für jeden Spieler beide Optionen)
btnLeaveGame.addEventListener('click', () => { if (!confirm('Wirklich das Spiel verlassen?')) return; if (typeof stopAllSounds === 'function') try { stopAllSounds(); } catch (e) {} leaveRoom(); });

if (btnCopyRoomCode) {
  btnCopyRoomCode.addEventListener('click', async () => {
    const code = currentRoomCode || (roomCodeDisplay ? roomCodeDisplay.textContent.trim() : '');
    if (!code) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (roomCodeCopyHint) {
        roomCodeCopyHint.hidden = false;
        setTimeout(() => { roomCodeCopyHint.hidden = true; }, 1200);
      }
    } catch (e) {
      if (roomCodeCopyHint) {
        roomCodeCopyHint.textContent = 'Kopieren fehlgeschlagen';
        roomCodeCopyHint.hidden = false;
        setTimeout(() => {
          if (roomCodeCopyHint) {
            roomCodeCopyHint.textContent = 'Code kopiert';
            roomCodeCopyHint.hidden = true;
          }
        }, 1600);
      }
    }
  });
}

btnBackToLobby.addEventListener('click', async () => {
  latestGame = null;
  autoStartAttempted = false;
  if (typeof resetCenterPile === 'function') resetCenterPile();
  // Musik stoppen + laufenden Endscreen-Timer verwerfen
  if (typeof stopAllSounds === 'function') stopAllSounds();
  if (typeof endScreenTimer !== 'undefined' && endScreenTimer) { clearTimeout(endScreenTimer); endScreenTimer = null; }
  document.body.classList.remove('theme-good', 'theme-bad');
  // Die Listener bleiben aktiv - sie müssen das nächste Spiel erkennen.
  await db.ref('rooms/' + currentRoomCode).update({
    status: 'lobby', gamePlayers: null, game: null, replayVotes: null,
    lastActivityAt: firebase.database.ServerValue.TIMESTAMP
  });
});
