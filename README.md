# Tempel des Schreckens – Online

Fan-Projekt, um das Bluff-Kartenspiel mit Freunden über den Browser zu spielen.
Aktueller Stand: Lobby-System (Raum erstellen/beitreten, Spielerliste live).
Die eigentliche Spiellogik (Rollen, Karten, Aufdecken) folgt im nächsten Schritt.

## Setup

1. **Firebase-Projekt erstellen**
   - Auf [firebase.google.com](https://firebase.google.com) → "Projekt hinzufügen"
   - Im Menü links: **Build → Realtime Database** → "Datenbank erstellen" → **Testmodus** starten
     (Testmodus ist offen für jeden – für den Anfang unter Freunden okay, später ggf. Regeln verschärfen)

2. **Firebase-Konfiguration eintragen**
   - Projekteinstellungen (Zahnrad oben links) → "Meine Apps" → Web-App hinzufügen (</> Symbol)
   - Den `firebaseConfig`-Codeblock kopieren
   - In `firebase-config.js` einfügen (Platzhalter-Werte ersetzen)

3. **Lokal testen**
   - Da Firebase Module lädt, funktioniert Doppelklick auf `index.html` evtl. nicht zuverlässig.
     Stattdessen einen kleinen lokalen Server starten, z. B. mit Python:
     ```
     python3 -m http.server 8000
     ```
   - Dann im Browser: `http://localhost:8000`
   - Zum Testen zu zweit: zwei Browser-Tabs öffnen, einen Raum erstellen, im zweiten Tab beitreten

4. **Auf GitHub veröffentlichen**
   - Alle Dateien ins Repository pushen
   - GitHub → Repo → **Settings → Pages** → als Branch `main` (Ordner `/root`) wählen
   - Nach kurzer Zeit ist die Seite unter `https://DEIN-NAME.github.io/REPO-NAME/` erreichbar

## Wichtig

`firebase-config.js` enthält keine geheimen Passwörter im klassischen Sinne (Firebase-Web-Keys sind
öffentlich sichtbar), aber die Datenbank-Regeln solltest du irgendwann von "Testmodus" auf etwas
Restriktiveres umstellen, bevor die Seite dauerhaft öffentlich läuft.

## Nächste Schritte (noch nicht umgesetzt)

- Rollen verteilen (Abenteurer / Wächterinnen)
- Karten pro Spieler generieren und verdeckt anzeigen
- Schlüsselkarte / Zugreihenfolge
- Karte bei Mitspieler aufdecken + Ergebnis live anzeigen
- Spielende erkennen (alle Schätze gefunden / alle Fallen ausgelöst / 4 Runden vorbei)
