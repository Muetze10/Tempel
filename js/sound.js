// ============================================================
// sound.js – Sound-Effekte für das Spiel. Die Klänge liegen als
// kleine MP3s unter sounds/ (zusammen unter 30 KB, exakt die
// Wellenformen, die früher rein aus Web Audio erzeugt wurden).
// Geladen wird erst, wenn der erste Klang gebraucht wird;
// schlägt das Laden fehl (z. B. lokal über file://), erzeugt
// Web Audio dieselben Wellenformen selbst. Ton abstellbar:
// Knopf im Spielkopf, Zustand in localStorage.
// ============================================================

const SOUND_FILES = {
  card: 'sounds/Karte Aufdecken.mp3',
  round: 'sounds/karte.mp3',
  'end-good': 'sounds/Gute gewinnen.mp3',
  'end-bad': 'sounds/Böse gewinnen.mp3',
  trap: 'sounds/Feuerfalle.mp3',
  gold: 'sounds/Schatz.mp3'
};

let currentSoundSource = null;
let currentSoundGain = null;

function stopAllSounds() {
  try {
    if (currentSoundSource) {
      try { currentSoundSource.stop(); } catch (e) {}
      try { currentSoundSource.disconnect(); } catch (e) {}
      currentSoundSource = null;
    }
    if (currentSoundGain) {
      try { currentSoundGain.disconnect(); } catch (e) {}
      currentSoundGain = null;
    }
  } catch (e) {}
}

let audioCtx = null;
const soundBuffers = {}; // Klangname -> Promise<AudioBuffer>

function soundMuted() {
  return localStorage.getItem('tds_sound') === 'off';
}

function toggleSound() {
  const off = soundMuted();
  localStorage.setItem('tds_sound', off ? 'on' : 'off');
  return !off; // neuer Zustand: true = Ton an
}

function getCtx() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch (err) {
    return null; // Ton ist Luxus - nie zum Spielabbruch führen
  }
}

function loadBuffer(key, ctx) {
  if (!soundBuffers[key]) {
    soundBuffers[key] = fetch(SOUND_FILES[key])
      .then((res) => {
        if (!res.ok) throw new Error('Klang fehlt');
        return res.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw));
  }
  return soundBuffers[key];
}

// --- Ersatzklang, falls die Datei nicht lädt: dieselben Wellenformen ---

function makeCardBuffer(ctx) {
  const dur = 0.09;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Verklingendes Rauschen, danach Tiefpass 900 Hz (wie im BiquadFilter)
  const a = 1 - Math.exp(-2 * Math.PI * 900 / ctx.sampleRate);
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    const raw = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    y += a * (raw - y);
    data[i] = y;
  }
  return buf;
}

function makeToneBuffer(ctx, segments, copy) {
  // segments: [{f0, f1, level, tStart, tGone, tStop, gain}]
  const len = Math.ceil(ctx.sampleRate * copy);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  segments.forEach((seg) => {
    let phase = 0;
    const i0 = Math.floor(seg.tStart * ctx.sampleRate);
    const i1 = Math.min(len, Math.floor(seg.tStop * ctx.sampleRate));
    const rise = seg.tGone * 0.02;
    for (let j = i0; j < i1; j++) {
      const t = (j - i0) / ctx.sampleRate;
      const f = seg.f0 * Math.pow(seg.f1 / seg.f0, Math.min(t, seg.tGone) / seg.tGone);
      phase += 2 * Math.PI * f / ctx.sampleRate;
      let g;
      if (t <= rise) g = 0.0001 + (seg.level - 0.0001) * (t / rise);
      else if (t <= seg.tGone) g = seg.level * Math.pow(0.0001 / seg.level, (t - rise) / (seg.tGone - rise));
      else g = 0.0001;
      data[j] += Math.sin(phase) * g;
    }
  });
  return buf;
}

function makeRoundBuffer(ctx) {
  return makeToneBuffer(ctx, [
    { f0: 164, f1: 164 * 0.85, level: 0.22, tStart: 0, tGone: 1.2, tStop: 1.25 },
    { f0: 166, f1: 166 * 0.85, level: 0.16, tStart: 0, tGone: 1.2, tStop: 1.25 }
  ], 1.25);
}

function makeEndBuffer(ctx, good) {
  const notes = good ? [440, 554, 587] : [330, 262, 220];
  return makeToneBuffer(ctx, notes.map((f, i) => ({
    f0: f, f1: f, level: 0.25, tStart: i * 0.28, tGone: 0.36, tStop: i * 0.28 + 0.4
  })), 0.96);
}

function fallbackBuffer(kind, flag, ctx) {
  try {
    if (kind === 'card') return makeCardBuffer(ctx);
    if (kind === 'round') return makeRoundBuffer(ctx);
    return makeEndBuffer(ctx, flag !== false);
  } catch (err) {
    return null;
  }
}

// Einstiegspunkt: playSound('card' | 'round' | 'end', adventuresWon)
function playSound(kind, flag) {
  const ctx = getCtx();
  if (!ctx || soundMuted()) return;
  let key = kind;
  if (kind === 'end') key = flag !== false ? 'end-good' : 'end-bad';
  try {
    loadBuffer(key, ctx)
      .then((buffer) => {
        // Gewinnsound: alten stoppen
        if (key === 'end-good' || key === 'end-bad') {
          stopAllSounds();
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        let gainVal = 0.7;
        if (key === 'card') gainVal = 0.4;
        else if (key === 'round') gainVal = 0.3;
        else if (key === 'gold') gainVal = 0.7;
        else if (key === 'trap') gainVal = 0.85;
        else if (key === 'end-good') gainVal = 0.9;
        else if (key === 'end-bad') gainVal = 0.9;
        gain.gain.setValueAtTime(gainVal, ctx.currentTime);
        src.connect(gain).connect(ctx.destination);
        currentSoundSource = src;
        currentSoundGain = gain;
        src.onended = () => {
          if (currentSoundSource === src) {
            currentSoundSource = null;
            currentSoundGain = null;
          }
        };
        src.start();
      })
      .catch((err) => {
        // Datei fehlt (z. B. lokales file://): Synth als Rückfall
        const buf = fallbackBuffer(kind, flag, ctx);
        if (!buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      });
  } catch (err) { /* Ton ist Luxus - nie zum Spielabbruch führen */ }
}
