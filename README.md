# Tempel des Schreckens

Browser-Nachbau des Brettspiels „Tempel" (Schmidt Spiele) für eine Freundesgruppe.
Vanilla JavaScript + Firebase Realtime Database – **ohne Build-Schritt, ohne Bundler,
ohne npm-Abhängigkeiten**. Die Dateien im Repo sind die Dateien, die der Browser lädt.

> Ich bin weggezogen und wir möchten gerne weiter tempeln. Daher das Spiel.
> LG Mütze

**Live:** <https://muetze10.github.io/Tempel/>

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
