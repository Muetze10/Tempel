# Spiel-Sounds

`karte.mp3` (Karte fällt auf den Stapel), `runde.mp3` (Runden-Gong),
`ende-gut.mp3` (Abenteurer-Sieg), `ende-boese.mp3` (Wächterinnen-Sieg).

Eigene Klänge einsetzen:
1. Die Dateien einfach ersetzen (gleiche Namen behalten).
2. Andere Dateinamen? Nur in der SOUND_FILES-Map anpassen (`js/sound.js`).
3. Kompakt bleiben: 64 kbit/s Mono reichen für diese kurzen Klänge völlig aus.

Die Klänge wurden aus den Web-Audio-Wellenformen von js/sound.js
gerendert (siehe Git-Geschichte); js/sound.js hält dieselben Wellen
als Rückfall bereit, z. B. wenn das Laden über file:// nicht geht.
