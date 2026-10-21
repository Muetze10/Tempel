// Cloud Function: räumt ungenutzte Räume auf (Logik + Konfiguration: siehe cleanup.js).
// Der Takt "jede Minute" ist nur der Wecker; ob und wie oft wirklich bereinigt
// wird, bestimmt ausschließlich config/roomCleanup in der Realtime Database.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { runCleanup } = require('./cleanup');

admin.initializeApp(); // nutzt Projekt und databaseURL aus der Functions-Umgebung

exports.cleanupRooms = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Etc/UTC', retryCount: 0 },
  async () => {
    const result = await runCleanup(admin.database(), Date.now());
    if (result.ran) console.log('Bereinigung:', JSON.stringify(result));
  }
);
