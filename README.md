# Tempel des Schreckens

Browser-Nachbau des Brettspiels „Tempel" (Schmidt Spiele) für eine Freundesgruppe.
Vanilla JavaScript + Firebase Realtime Database – **ohne Build-Schritt, ohne Bundler,
ohne npm-Abhängigkeiten**. Die Dateien im Repo sind die Dateien, die der Browser lädt.

> Ich bin weggezogen und wir möchten gerne weiter tempeln. Daher das Spiel.
> LG Mütze

**Live:** <https://muetze10.github.io/Tempel/>

## Lokal starten

Firebase verlangt `http://`, nicht `file://`. Statischen Server im Projektordner starten:

```sh
python3 -m http.server 8000
# -> http://localhost:8000
```

Es gibt keine Abhängigkeiten – `npm install` ist nicht nötig. Nach Änderungen an
`js/*.js` den Cache-Buster `?v=` in `index.html` hochzählen und die Seite neu laden.

## Tests

```sh
npm test        # entspricht: node --test test/*.test.js
```

74 Tests, keine Abhängigkeiten, Node >= 18. Sie laufen **ohne Browser und ohne echtes
Firebase**: `test/helpers.js` simuliert die Datenbank im Speicher (`FakeDb`) und lädt
die echten Browser-Skripte über `node:vm`. Die Tests bleiben lokal und stehen nicht im
Repo (siehe `.gitignore`).

## Aufbau

| Ort | Inhalt |
| --- | --- |
| `index.html`, `style.css` | Markup und Gestaltung (Design-Tokens in `:root`) |
| `js/` | Browser-Code, **globale Skripte** in fester Reihenfolge: `config` → `firebase` → `stats` → `game` → `ui` → `app` |
| `images/` | Karten-, Rollen- und Hintergrundbilder |
| `firebase-config.js` | Web-Config des Firebase-Projekts (öffentlich, kein Geheimnis) |
| `functions/` | Cloud Function `cleanupRooms` – räumt ungenutzte Räume auf (optional) |
| `database.rules.json` | Sicherheitsregeln für die Realtime Database |
| `firebase.json`, `.firebaserc` | Konfiguration der Firebase-CLI |
| `test/` | lokale Tests (nicht im Repo) |
| `docs/` | Projekt-Dokumentation (nicht im Repo) |

## Firebase

- Realtime Database mit anonymer Anmeldung; Console: <https://console.firebase.google.com/>
- Datenpfad: `rooms/<CODE>` mit `status`, `players`, `gamePlayers`, `game`, `stats`, `lastActivityAt`
- **Die Regeln in `database.rules.json` sind noch nicht aktiv.** Sie müssen in der
  Firebase-Console eingefügt und veröffentlicht werden – Reihenfolge und Testschritte
  stehen in `docs/DEPLOYMENT.md`.

## Deployment

- **Spiel:** GitHub Pages aus `main` – reicht ein Push.
- **Regeln und Function:** manuell über die Firebase-CLI (`firebase deploy --only database`
  bzw. `--only functions`), siehe `docs/DEPLOYMENT.md`.

## Mehr

Diese Dateien liegen bewusst nur lokal und sind **nicht** Teil des Repos:

- `docs/DEPLOYMENT.md` – Firebase-Rules und Function ausrollen
- `docs/AUDIT_REPORT.md`, `docs/AUDIT_SUMMARY.md` – letzter Audit
- `docs/IMPROVEMENT_PLAN.md` – offene Punkte und Ideen
- `AGENTS.md` – Projektanweisungen für KI-Agenten
