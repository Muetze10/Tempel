# Spiel-Sounds

| Datei | Wann klingt sie |
| --- | --- |
| `Karte Aufdecken.mp3` (neutrale Karte) | eine Karte fällt auf den Ablagestapel |
| `Schatz.mp3` | eine Goldschatz-Karte wird aufgedeckt |
| `Feuerfalle.mp3` | eine Feuerfalle wird aufgedeckt |
| `Gute gewinnen.mp3` | Abenteurer-Sieg (Endscreen folgt nach 6,5 s) |
| `Böse gewinnen.mp3` | Wächterinnen-Sieg (Endscreen folgt nach 6,5 s) |
| `Runde.mp3` *(optional)* | Runden-Gong; **fehlt sie,** summt der synthetische Gong aus `js/sound.js` |

Eigene Klänge einsetzen:
1. Die Dateien einfach ersetzen (gleiche Namen behalten).
2. Andere Dateinamen? Nur in der SOUND_FILES-Map anpassen (`js/sound.js`).
3. Kurz halten und komprimieren (Mono, ~128 kbit/s reichen).

Schlägt das Laden fehl (z. B. lokal über `file://`), hält `js/sound.js`
dieselben Wellen als Rückfall bereit.


