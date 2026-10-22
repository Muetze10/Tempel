// ============================================================
// sound.js – kleine Sound-Effekte per Web Audio API, ganz ohne
// Audiodateien (gewonnene Datenmenge). Laeuft erst nach der
// ersten Nutzereingabe (Browser-Vorgabe fuer Audio) - im Spiel
// tippt man vorher immer irgendwo, das passt.
// Tone abstellbar: Knopf im Spielbrett-Kopf, Zustand in localStorage.
// ============================================================

let audioCtx = null;

function soundMuted() {
  return localStorage.getItem('tds_sound') === 'off';
}

function toggleSound() {
  const off = soundMuted();
  localStorage.setItem('tds_sound', off ? 'on' : 'off');
  return !off; // neuer Zustand: true = Ton an
}

function getCtx() {
  if (soundMuted()) return null;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch (err) {
    return null; // Ton ist Luxus - nie zum Spielabbruch fuehren
  }
}

// Kurzer, dumpfer "Karte faellt auf den Stapel"-Klang (gefiltertes Rauschen)
function playCardDrop(ctx) {
  const dur = 0.09;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  const gain = ctx.createGain();
  gain.gain.value = 0.35;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

// Dumpfer Gong zur Rundenansage: zwei leicht verstimte Toene ohne Hall
function playRoundGong(ctx) {
  [164, 166].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.85, ctx.currentTime + 1.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(i === 0 ? 0.22 : 0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.25);
  });
}

// Kurzes Siegermotiv für den Endscreen (reine Sinustoene): a - d - a hoch
function playEndMotif(ctx, adventurersWon) {
  // Abenteurer: helle Toene aufwaerts. Wächter: dunkle, fallende.
  const notes = adventurersWon ? [440, 554, 587] : [330, 262, 220];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + i * 0.28;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  });
}

// Einstiegspunkt: playSound('card' | 'round' | 'end', adventuresWon)
function playSound(kind, flag) {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    if (kind === 'card') playCardDrop(ctx);
    else if (kind === 'round') playRoundGong(ctx);
    else if (kind === 'end') playEndMotif(ctx, flag !== false);
  } catch (err) { /* Ton ist Luxus - nie zum Spielabbruch fuehren */ }
}
