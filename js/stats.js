// ============================================================
// stats.js – Sieg-/Rollen-Statistiken, komplett unabhaengig vom
// Raum-Code gespeichert unter /playerStats/{nameKey} - nach NAME
// statt Spieler-ID, damit dieselbe Person auch von einem anderen
// Geraet oder in einem neuen Raum weiterzaehlt.
// Braucht: db (firebase.js), escapeHtml (ui.js).
// ============================================================

const statsListEl = document.getElementById('stats-list');
const statsRef = db.ref('playerStats');

// Macht aus einem Namen einen gueltigen Firebase-Key (keine . # $ / [ ])
// und ignoriert Gross-/Kleinschreibung, damit "Lukas" und "lukas" dieselbe
// Person sind.
function statsKey(name) {
  return encodeURIComponent(name.trim().toLowerCase()).replace(/[.#$/[\]]/g, '_');
}

// Nach Spielende einmal (nur vom Host, siehe firebase.js) fortschreiben.
async function updateStatsAfterGame(game, gamePlayers) {
  const stats = (await statsRef.get()).val() || {};

  // Wer hat wie oft Gold bzw. eine Falle abbekommen?
  const trapCounts = {}, goldCounts = {};
  Object.values(game.revealLog || {}).forEach((e) => {
    if (e.type === 'trap') trapCounts[e.playerId] = (trapCounts[e.playerId] || 0) + 1;
    if (e.type === 'gold') goldCounts[e.playerId] = (goldCounts[e.playerId] || 0) + 1;
  });

  const updates = {};
  Object.keys(gamePlayers).forEach((uid) => {
    const p = gamePlayers[uid];
    const key = statsKey(p.name);
    const s = stats[key] || { name: p.name, games: 0, wins: 0, losses: 0, guardian: 0, traps: 0, gold: 0 };
    s.name = p.name; // zuletzt benutzten Namen anzeigen
    s.games++;
    if (p.role === game.winner) s.wins++; else s.losses++;
    if (p.role === 'guardian') s.guardian++;
    s.traps += trapCounts[uid] || 0;
    s.gold += goldCounts[uid] || 0;
    updates[key] = s;
  });

  await statsRef.update(updates);
}

// Zeigt ein paar "Auszeichnungen" aus allen jemals gesammelten Statistiken -
// global, nicht nur fuer den aktuellen Raum, deshalb ein eigener Listener,
// der unabhaengig vom Betreten/Verlassen eines Raums laeuft.
function renderStats(stats) {
  if (!statsListEl) return;
  const entries = Object.values(stats || {}).filter((s) => s.games > 0);
  if (entries.length === 0) { statsListEl.innerHTML = ''; return; }

  const topOf = (key) => entries.reduce((a, b) => (b[key] > a[key] ? b : a), entries[0]);
  const awards = [
    ['🏆 Meiste Siege', topOf('wins'), 'wins'],
    ['💔 Meiste Niederlagen', topOf('losses'), 'losses'],
    ['🗡️ Öfteste Wächterin', topOf('guardian'), 'guardian'],
    ['💀 Pechvogel (meiste Fallen)', topOf('traps'), 'traps'],
    ['✨ Glückspilz (meistes Gold)', topOf('gold'), 'gold']
  ].filter(([, player, key]) => player[key] > 0);

  statsListEl.innerHTML = awards
    .map(([label, player, key]) => `<li>${label}: <strong>${escapeHtml(player.name)}</strong> (${player[key]})</li>`)
    .join('');
}

statsRef.on('value', (snapshot) => renderStats(snapshot.val() || {}));
