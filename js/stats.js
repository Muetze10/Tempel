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

// Statistik verbuchen - wiederaufnehmbar und idempotent.
// Beim Spielende legt game.js das Ergebnis atomar unter statsPending/g<Nr> ab.
// Hier wird es pro Spieler verbucht; im Spieler-Eintrag merkt sich done/g<Nr>,
// dass dieses Spiel schon gezählt ist (ein zweiter Durchlauf ändert nichts).
// Erst wenn ALLE Spieler verbucht sind, wird der Eintrag gelöscht. Bricht die
// Verbindung mittendrin ab, bleibt er stehen und der nächste Durchlauf (jeder
// Client, auch nach Reload beim Betreten des Raums) macht genau den Rest.
async function processPendingStats() {
  const roomRef = db.ref('rooms/' + currentRoomCode);
  const pending = (await roomRef.child('statsPending').get()).val();
  if (!pending) return;

  for (const [pKey, entry] of Object.entries(pending)) {
    // Gleicher Name = gleicher Statistik-Schlüssel -> vorher zusammenfassen
    const perKey = {};
    Object.values(entry.players || {}).forEach((p) => {
      const k = statsKey(p.name || '?');
      const d = perKey[k] || (perKey[k] = { name: p.name || '?', games: 0, wins: 0, losses: 0, guardian: 0, traps: 0, gold: 0 });
      d.games++;
      if (p.role === entry.winner) d.wins++; else d.losses++;
      if (p.role === 'guardian') d.guardian++;
      d.traps += p.traps || 0;
      d.gold += p.gold || 0;
    });

    await Promise.all(Object.entries(perKey).map(([k, d]) =>
      roomRef.child('stats/' + k).transaction((s) => {
        s = s || { games: 0, wins: 0, losses: 0, guardian: 0, traps: 0, gold: 0 };
        s.done = s.done || {};
        if (s.done[pKey]) return undefined; // dieses Spiel ist hier schon gezählt
        s.done[pKey] = true;
        s.name = d.name; // zuletzt benutzten Namen anzeigen
        ['games', 'wins', 'losses', 'guardian', 'traps', 'gold'].forEach((f) => { s[f] = (s[f] || 0) + d[f]; });
        return s;
      })));

    await roomRef.child('statsPending/' + pKey).remove(); // nur nach vollem Erfolg
  }
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
