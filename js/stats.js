// ============================================================
// stats.js – Statistiken pro Raum. Gespeichert unter
// rooms/{code}/stats/{nameKey} - nach NAME statt Spieler-ID, damit
// dieselbe Person auch von einem anderen Gerät weiterzählt. Wer den
// Raum später mit demselben Code betritt, sieht sie wieder.
// Braucht: db, currentRoomCode (firebase.js), escapeHtml (ui.js).
// ============================================================

const statsListEl = document.getElementById('stats-list');

// Gültiger Firebase-Key aus dem Namen; "Lukas" und "lukas" sind dieselbe Person
function statsKey(name) {
  return encodeURIComponent(name.trim().toLowerCase()).replace(/[.#$/[\]]/g, '_');
}

// Nach Spielende zählen. Jeder Client ruft das auf, ein Lock-Wert im Raum
// (statsCounted = gameNumber) lässt aber nur EINEN durch - kein Doppelzählen,
// auch wenn der Host zwischendurch gewechselt hat.
async function updateStatsAfterGame(game, gamePlayers) {
  const roomRef = db.ref('rooms/' + currentRoomCode);
  const lock = await roomRef.child('statsCounted')
    .transaction((current) => (current === game.gameNumber ? undefined : game.gameNumber));
  if (!lock.committed) return;

  // Bei wem wurde wie oft Gold bzw. eine Falle aufgedeckt?
  const trapCounts = {}, goldCounts = {};
  Object.values(game.revealLog || {}).forEach((e) => {
    if (e.type === 'trap') trapCounts[e.playerId] = (trapCounts[e.playerId] || 0) + 1;
    if (e.type === 'gold') goldCounts[e.playerId] = (goldCounts[e.playerId] || 0) + 1;
  });

  await Promise.all(Object.keys(gamePlayers).map((uid) => {
    const p = gamePlayers[uid];
    return roomRef.child('stats/' + statsKey(p.name)).transaction((s) => {
      s = s || { games: 0, wins: 0, losses: 0, guardian: 0, traps: 0, gold: 0 };
      s.name = p.name; // zuletzt benutzten Namen anzeigen
      s.games++;
      if (p.role === game.winner) s.wins++; else s.losses++;
      if (p.role === 'guardian') s.guardian++;
      s.traps += trapCounts[uid] || 0;
      s.gold += goldCounts[uid] || 0;
      return s;
    });
  }));
}

// Auszeichnungen im Warteraum
function renderStats(stats) {
  const entries = Object.values(stats || {}).filter((s) => s.games > 0);
  const topOf = (key) => entries.reduce((a, b) => (b[key] > a[key] ? b : a), entries[0]);
  const awards = entries.length === 0 ? [] : [
    ['🏆 Meiste Siege', 'wins'],
    ['💔 Meiste Niederlagen', 'losses'],
    ['🗡️ Öfteste Wächterin', 'guardian'],
    ['💀 Pechvogel (meiste Fallen)', 'traps'],
    ['✨ Glückspilz (meistes Gold)', 'gold']
  ].map(([label, key]) => [label, topOf(key), key]).filter(([, player, key]) => player[key] > 0);

  statsListEl.innerHTML = awards
    .map(([label, player, key]) => `<li>${label}: <strong>${escapeHtml(player.name)}</strong> (${player[key]})</li>`)
    .join('');
}

// Beim Betreten/Verlassen eines Raums ein- bzw. ausschalten
function watchStats(roomCode) {
  db.ref('rooms/' + roomCode + '/stats').on('value', (snap) => renderStats(snap.val()));
}

function unwatchStats(roomCode) {
  db.ref('rooms/' + roomCode + '/stats').off();
  statsListEl.innerHTML = '';
}
