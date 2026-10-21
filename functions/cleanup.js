// ============================================================
// cleanup.js – Logik der automatischen Raum-Bereinigung.
// Bewusst OHNE firebase-functions-Import, damit sie mit einem Mock testbar ist.
// Alle Werte kommen aus Firebase unter config/roomCleanup:
//   enabled        true  -> Bereinigung läuft (alles andere = AUS)
//   inactiveAfterMs  Raum gilt nach so vielen ms ohne Aktivität als ungenutzt
//   intervalMs       frühestens alle so viele ms läuft eine Bereinigung
//   lastRunAt        (schreibt die Funktion selbst) verhindert Parallel-Läufe
// Pro Raum:  protected: true  -> wird NIE gelöscht.
// Alle Zeiten sind Unix-Millisekunden (zeitzonenunabhängig).
// ============================================================

const BATCH_SIZE = 200; // Räume pro Durchlauf (Schutz vor Zeitüberschreitung)

const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Liest und prüft die Konfiguration. Unvollständig/ungültig/aus -> null (= nichts tun).
function parseConfig(raw) {
  if (!raw || raw.enabled !== true) return null;
  if (!isPositiveNumber(raw.inactiveAfterMs) || !isPositiveNumber(raw.intervalMs)) return null;
  return { inactiveAfterMs: raw.inactiveAfterMs, intervalMs: raw.intervalMs };
}

// Letzte erkennbare Aktivität eines Raums: lastActivityAt, createdAt oder der
// letzte Herzschlag/Beitritt eines Spielers (ein offener Tab zählt als "in Benutzung").
// Gibt null zurück, wenn gar keine Zeit bekannt ist.
function lastActivity(room) {
  const times = [room.lastActivityAt, room.createdAt];
  Object.values(room.players || {}).forEach((p) => times.push(p && p.lastSeen, p && p.joinedAt));
  const valid = times.filter((t) => typeof t === 'number' && Number.isFinite(t));
  return valid.length ? Math.max(...valid) : null;
}

// Darf der Raum gelöscht werden? (geschützt/ohne Zeitangabe: nie)
function isDeletable(room, now, inactiveAfterMs) {
  if (!room || room.protected === true) return false;
  const last = lastActivity(room);
  if (last === null) return false;
  return now - last > inactiveAfterMs;
}

// Führt einen Durchlauf aus. `db` = Admin-Realtime-Database. Gibt eine Zusammenfassung zurück.
async function runCleanup(db, now) {
  const result = { ran: false, reason: '', deleted: [], skipped: 0, stamped: 0 };

  const cfg = parseConfig((await db.ref('config/roomCleanup').get()).val());
  if (!cfg) { result.reason = 'deaktiviert oder Konfiguration unvollständig'; return result; }

  // Nur EIN Lauf pro Intervall, auch bei mehreren parallelen Instanzen:
  // wer lastRunAt zuerst setzt, darf; alle anderen brechen ab.
  const claim = await db.ref('config/roomCleanup/lastRunAt').transaction((last) =>
    (typeof last === 'number' && now - last < cfg.intervalMs) ? undefined : now);
  if (!claim.committed) { result.reason = 'Intervall noch nicht erreicht'; return result; }
  result.ran = true;

  // Kandidaten: Räume, deren lastActivityAt alt ODER nicht vorhanden ist
  // (fehlende Werte sortieren zuerst). Der Index auf lastActivityAt steht in database.rules.json.
  const cutoff = now - cfg.inactiveAfterMs;
  const snap = await db.ref('rooms').orderByChild('lastActivityAt').endAt(cutoff).limitToFirst(BATCH_SIZE).get();
  const codes = Object.keys(snap.val() || {});

  for (const code of codes) {
    try {
      let removed = false, stamp = false;
      // Löschen NUR innerhalb einer Transaktion, die den Raum erneut prüft:
      // war er inzwischen wieder aktiv, ist er geschützt oder neu belegt -> bleibt er.
      await db.ref('rooms/' + code).transaction((room) => {
        removed = false; stamp = false;
        if (room === null) return room;
        if (room.protected === true) return undefined;
        // Altbestand ohne lastActivityAt wird NICHT sofort gelöscht (könnte alte,
        // gewollte Statistiken enthalten), sondern bekommt jetzt erst eine Uhr.
        if (typeof room.lastActivityAt !== 'number') { room.lastActivityAt = now; stamp = true; return room; }
        if (!isDeletable(room, now, cfg.inactiveAfterMs)) return undefined;
        removed = true;
        return null; // Raum löschen
      });
      if (removed) result.deleted.push(code);
      else if (stamp) result.stamped++;
      else result.skipped++;
    } catch (err) {
      result.skipped++; // ein kaputter Raum darf den Rest nicht aufhalten
      console.error('Bereinigung von Raum ' + code + ' fehlgeschlagen:', err);
    }
  }
  result.reason = 'ok';
  return result;
}

module.exports = { parseConfig, lastActivity, isDeletable, runCleanup, BATCH_SIZE };
