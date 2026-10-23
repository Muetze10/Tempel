# Tempel – Projektanweisungen für KI-Agenten

## Was das Projekt ist

Fanprojekt: Browser-Nachbau des Brettspiels „Tempel" (Schmidt Spiele) für eine
Freundesgruppe. Vanilla JavaScript + Firebase Realtime Database. **Kein
Build-Schritt, kein Bundler, keine npm-Abhängigkeiten** – die Dateien werden
direkt vom Browser geladen.

- Live: <https://muetze10.github.io/Tempel/> (GitHub Pages aus `main`)
- Repo: <https://github.com/Muetze10/Tempel>

## Struktur

| Datei / Ordner | Inhalt |
| --- | --- |
| `index.html` | Markup; lädt Firebase-SDK und alle `js/`-Dateien in fester Reihenfolge |
| `style.css` | Design-Tokens (`:root`) + Layout; einzige Stylesheet-Datei |
| `fonts/` | Selbst gehostete Schriften (Cinzel, Work Sans; Variable Fonts, OFL) |
| `js/config.js` | reine Konstanten: Bilder, Kartentypen, Rollen, Verteilungstabellen |
| `js/sound.js` | Sound: lädt MP3s aus `sounds/`, Web-Audio-Synth als Rückfall, Ton-Schalter |
| `sounds/` | Sound-Dateien (`karte`, `runde`, `ende-gut`, `ende-boese`) + README; nichts weiter nötig |
| `js/firebase.js` | Firebase-Init, Raumverwaltung (create/join/leave), Live-Listener |
| `js/stats.js` | Spielstatistik |
| `js/game.js` | Spielregeln: Rollen, Karten, Runden, Siegbedingungen |
| `js/ui.js` | Darstellung: DOM, Kartenansicht, Animationen, Fehleranzeige |
| `js/app.js` | Einstiegspunkt, verdrahtet die Buttons – **muss zuletzt geladen werden** |
| `firebase-config.js` | Verbindungsdaten zum Firebase-Projekt |
| `images/` | Karten-, Rollen- und Hintergrundbilder |
| `functions/` | Cloud Function `cleanupRooms` (räumt ungenutzte Räume auf) – Node, wird **nicht** von GitHub Pages ausgeliefert |
| `database.rules.json` | Firebase-Sicherheitsregeln (Auth Pflicht, `config` gesperrt, `protected` geschützt) |
| `firebase.json`, `.firebaserc` | Firebase-CLI-Konfiguration (Projekt `tempel-des-schreckens-fadac`) |
| `package.json` | nur ein `npm test`-Skript, **keine** Abhängigkeiten |
| `README.md` | Einstiegspunkt: Was ist das Projekt, wie startet man es |
| `docs/DEPLOYMENT.md` | Reihenfolge für Rules/Function-Deployment (manuell in der Console) |
| `docs/AUDIT_REPORT.md`, `docs/AUDIT_SUMMARY.md`, `docs/IMPROVEMENT_PLAN.md` | letzter Audit, Kurzfassung, offene Punkte |
| `test/` | lokale Tests – steht in `.gitignore` |
| `Arbeitsplatz/` | Originalmaterial und Entwürfe – steht in `.gitignore` |

## Skripte und Ladereihenfolge

Alle Skripte sind **globale Skripte**: kein `import`/`export`, keine ES-Module.
Sie teilen sich einen Scope, eine Funktion aus `config.js` ist also in `ui.js`
sichtbar. Die Reihenfolge in `index.html` ist Teil der Architektur:

```text
config.js → sound.js → firebase.js → stats.js → game.js → ui.js → app.js
```

`app.js` bindet die Buttons an und steht deshalb als letztes.

**Cache-Buster:** alle `js/`-Dateien werden mit `?v=24` geladen (style.css mit
`?v=10`). Nach Änderungen an `js/*.js` den Wert in `index.html` hochzählen
(z. B. `?v=24`), sonst serviert der Browser weiterhin die alte Datei.

## Tests

```sh
npm test            # entspricht: node --test test/*.test.js
```

- 86 Tests, keine Abhängigkeiten, Node >= 18.
- `test/helpers.js` simuliert Firebase im Speicher (`FakeDb`) und lädt die
  Browser-Skripte über `node:vm` – dadurch lassen sich Spiellogik und UI-Code
  ohne Browser testen.
- **Wichtig:** `node --test test/` funktioniert unter Node 24 nicht
  (`Cannot find module .../test`). Den Glob `test/*.test.js` verwenden.
- `test/` gehört ins Repo und läuft in GitHub Actions (.github/workflows/ci.yml,
  `npm test` bei jedem Push). `Arbeitsplatz/` bleibt in der `.gitignore`.
- `test/cleanup.test.js` testet die Bereinigungslogik in `functions/cleanup.js`
  (Mock statt echter Firebase).

## Lokal entwickeln

Firebase verlangt `http://`, nicht `file://`. Statischen Server im Projektordner
starten:

```sh
python3 -m http.server 8000
# -> http://localhost:8000
```

Keine `npm install` – es gibt keine Abhängigkeiten. Nach Änderungen an
`js/`-Dateien den `?v=`-Wert erhöhen und die Seite neu laden.
Ausnahme: nur `functions/` hat Abhängigkeiten (`firebase-admin`,
`firebase-functions`) – die werden **ausschließlich** für das Deployment
installiert, nie für das Spiel.

## Firebase

- Realtime Database mit anonymer Anmeldung (`signInAnonymously`); die
  Security-Regeln prüfen die anonyme uid.
- Zugangsdaten liegen in `firebase-config.js` (öffentlicher Web-Config, kein
  Geheimnis). Die Security-Regeln liegen jetzt als `database.rules.json` im Repo
  – deployed werden sie aber **manuell** (`firebase deploy --only database`),
  siehe `docs/DEPLOYMENT.md`. Die Function `cleanupRooms` braucht zusätzlich den
  Blaze-Tarif und wird **nicht** deployed.
- Datenpfad: `rooms/<CODE>` mit `status`, `gamePlayers`, `game`, `replayVotes`,
  `lastActivityAt` (Aktivitäts-Uhr für die Bereinigung).

## Konventionen

- Kommentare und Nutzertexte auf Deutsch, Code-Identifier englisch.
- Einrückung 2 Leerzeichen, Semikolon am Zeilenende.
- Farben in CSS ausschließlich über die Tokens in `:root`.
- Keine Frameworks, keine Abhängigkeiten, kein Transpiler – Lösungen bleiben im
  vorhandenen Stil (Vanilla JS, DOM-APIs).
- Fehler über die vorhandene Anzeige `showError(...)` melden, nicht per
  `console.log`.

## Git

- Branch `main`, Auslieferung über GitHub Pages.
- Vor dem Commit: `npm test` laufen lassen.
- Nicht pushen, solange der Nutzer das nicht bestätigt hat.
