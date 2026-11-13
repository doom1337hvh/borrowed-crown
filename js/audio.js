/*
 * Borrowed Crown: sound.
 * A handful of synthesised cues, no audio files. Nothing plays until the player
 * has pressed a button, because browsers will not allow it sooner.
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  let ctx = null, master = null, on = true;
  const last = {};

  function boot() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = on ? 0.2 : 0;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
  }

  // One enveloped oscillator. `to` slides the pitch, `lp` muffles it, `at` delays it.
  function tone(freq, dur, o) {
    o = o || {};
    const t = ctx.currentTime + (o.at || 0), osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.4, t + (o.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; osc.connect(f); node = f; }
    node.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  function noise(dur, o) {
    o = o || {};
    const t = ctx.currentTime + (o.at || 0), n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    f.type = o.band ? 'bandpass' : 'lowpass'; f.frequency.value = o.band || o.lp || 800;
    g.gain.value = o.vol || 0.3;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  const cues = {
    march() { tone(196, 0.08, { vol: 0.3, to: 150 }); tone(196, 0.08, { vol: 0.22, to: 150, at: 0.1 }); },
    deny() { tone(110, 0.14, { type: 'square', vol: 0.12, to: 82, lp: 500 }); },
    battle() { noise(0.18, { vol: 0.4, band: 1900 }); noise(0.12, { vol: 0.3, band: 2700, at: 0.08 }); tone(90, 0.2, { type: 'sine', vol: 0.35, to: 50 }); },
    take() { tone(392, 0.14, { vol: 0.34 }); tone(523, 0.22, { vol: 0.34, at: 0.11 }); },
    lost() { tone(147, 0.32, { type: 'sawtooth', vol: 0.25, to: 70, lp: 520 }); noise(0.25, { vol: 0.22, lp: 380 }); },
    siege() { tone(78, 0.3, { type: 'sine', vol: 0.55, to: 52 }); tone(78, 0.3, { type: 'sine', vol: 0.45, to: 52, at: 0.3 }); },
    revolt() { tone(660, 0.5, { type: 'sine', vol: 0.22 }); tone(990, 0.45, { type: 'sine', vol: 0.1 }); tone(660, 0.5, { type: 'sine', vol: 0.2, at: 0.26 }); },
    omen() { tone(98, 1.1, { type: 'sawtooth', vol: 0.2, lp: 420, attack: 0.25 }); tone(147, 1.1, { type: 'sawtooth', vol: 0.13, lp: 420, attack: 0.25 }); },
    crown() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { vol: 0.28, at: i * 0.11 })); },
    winter() { noise(1.4, { vol: 0.07, band: 3200 }); },
    fall() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.5, { vol: 0.26, at: i * 0.3, lp: 1200 })); },
  };

  BC.audio = {
    boot: boot,
    get on() { return on; },
    set(v) { on = !!v; if (master) master.gain.value = on ? 0.2 : 0; },
    play(name) {
      if (!ctx || !on || !cues[name]) return;
      const now = ctx.currentTime;
      if (last[name] !== undefined && now - last[name] < 0.09) return;     // do not stack the same cue
      last[name] = now;
      try { cues[name](); } catch (e) { /* a sound failing must never stop the game */ }
    },
  };
})();
