// ============================================================
// config.js – reine Konstanten, keine Logik.
// Bilder, Kartentypen, Rollen und die offiziellen Verteilungs-
// Tabellen aus der Spielanleitung (Schmidt Spiele).
// ============================================================

// Bilder – exakt die Dateinamen aus deinem images/-Ordner
const IMG = {
  leer:       'images/Tempel_leer.jpg',
  gold:       'images/Tempel_Goldjpg.jpg',
  falle:      'images/Tempel_Feuerfalle.jpg',
  key:        'images/Tempel_Key.jpg',
  gut:        'images/Tempel_Gut.jpg',
  boese:      'images/Tempel_Boese.jpg',
  karteBack:  'images/Karte_Hintergrund.jpg',
  charBack:   'images/Karakter_Hintergrund.jpg'
};

const CARD_IMAGES = { empty: IMG.leer, gold: IMG.gold, trap: IMG.falle };
const CARD_LABELS = { empty: 'Leer', gold: 'Gold', trap: 'Feuerfalle' };

const ROLE_INFO = {
  adventurer: { label: 'Abenteurer', image: IMG.gut,   className: 'role-good' },
  guardian:   { label: 'Wächterin',  image: IMG.boese, className: 'role-bad' }
};

// Wächterinnen-Anzahl je nach Spielerzahl
const ROLE_TABLE = {
  3:  { adventurer: 2, guardian: 2 },
  4:  { adventurer: 3, guardian: 2 },
  5:  { adventurer: 3, guardian: 2 },
  6:  { adventurer: 4, guardian: 2 },
  7:  { adventurer: 5, guardian: 3 },
  8:  { adventurer: 6, guardian: 3 },
  9:  { adventurer: 6, guardian: 3 },
  10: { adventurer: 7, guardian: 4 }
};

// Zusammensetzung des Kartenpools (5 Karten pro Spieler in Runde 1)
const ROOM_TABLE = {
  3:  { empty: 8,  gold: 5,  trap: 2 },
  4:  { empty: 12, gold: 6,  trap: 2 },
  5:  { empty: 16, gold: 7,  trap: 2 },
  6:  { empty: 20, gold: 8,  trap: 2 },
  7:  { empty: 26, gold: 7,  trap: 2 },
  8:  { empty: 30, gold: 8,  trap: 2 },
  9:  { empty: 34, gold: 9,  trap: 2 },
  10: { empty: 37, gold: 10, trap: 3 }
};
