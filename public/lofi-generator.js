window.LofiGenerator = (() => {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
    mohanam: [0, 2, 4, 7, 9],
    kalyani: [0, 2, 4, 6, 7, 9, 11],
    mayamalavagowla: [0, 1, 4, 5, 7, 8, 11],
    charukesi: [0, 2, 4, 5, 7, 8, 10]
  };

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function createNoiseBuffer(ctx, durationSec) {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return buffer;
  }

  function addVinylDustToBuffer(buffer, intensity = 0.06) {
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const edgeSamples = Math.floor(sr * 0.015);
    for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
      const data = buffer.getChannelData(ch);
      let pink = 0;
      for (let i = 0; i < len; i += 1) {
        const white = Math.random() * 2 - 1;
        pink = 0.96 * pink + 0.04 * white;
        let crackle = 0;
        if (Math.random() < 0.0005) {
          crackle = (Math.random() * 2 - 1) * 0.42;
        }
        let edgeEnv = 1;
        if (i < edgeSamples) edgeEnv = i / edgeSamples;
        else if (i > len - edgeSamples) edgeEnv = (len - i) / edgeSamples;
        data[i] = Math.max(-0.98, Math.min(0.98, (data[i] + (pink * 0.14 + crackle) * intensity) * edgeEnv));
      }
    }
  }

  function getScaleIntervals(scaleType) {
    return SCALES[scaleType] || SCALES.minor;
  }

  function getChordProgression(keyIndex, scaleType) {
    const rootMidi = 48 + keyIndex;
    const iv = getScaleIntervals(scaleType);
    if (scaleType === 'major' || scaleType === 'kalyani') {
      return [
        [rootMidi + iv[1], rootMidi + iv[3], rootMidi + iv[5], rootMidi + 12, rootMidi + iv[2] + 12],
        [rootMidi + iv[4], rootMidi + iv[6], rootMidi + 12 + iv[1], rootMidi + 12 + iv[3]],
        [rootMidi + 0, rootMidi + iv[2], rootMidi + iv[4], rootMidi + iv[6], rootMidi + 12 + iv[1]],
        [rootMidi + iv[5 % iv.length], rootMidi + 12, rootMidi + 12 + iv[2], rootMidi + 12 + iv[4]]
      ];
    }
    if (scaleType === 'mohanam' || scaleType === 'mayamalavagowla' || scaleType === 'charukesi') {
      // Drone-friendly Carnatic modal chord voicings (Sa-Pa-Sa + characteristic swaras)
      const swara2 = iv[1] || 2;
      const swara3 = iv[2] || 4;
      const fifth = iv.find((x) => x === 7) ?? 7;
      const swara6 = iv[iv.length - 2] || 9;
      return [
        [rootMidi, rootMidi + fifth, rootMidi + 12 + swara3, rootMidi + 12 + swara6],
        [rootMidi + swara2, rootMidi + fifth, rootMidi + 12, rootMidi + 12 + swara3],
        [rootMidi + swara6 - 12, rootMidi, rootMidi + swara3 + 12, rootMidi + fifth + 12],
        [rootMidi, rootMidi + swara3, rootMidi + fifth, rootMidi + 12]
      ];
    }
    // Natural minor lo-fi progression
    return [
      [rootMidi + 0, rootMidi + 3, rootMidi + 7, rootMidi + 10, rootMidi + 14],
      [rootMidi + 8, rootMidi + 12, rootMidi + 15, rootMidi + 19],
      [rootMidi + 5, rootMidi + 8, rootMidi + 12, rootMidi + 15, rootMidi + 19],
      [rootMidi + 7, rootMidi + 10, rootMidi + 14, rootMidi + 17]
    ];
  }

  function scheduleRhodesChord(ctx, dest, notes, startTime, duration, gainScale = 1) {
    notes.forEach((midi, idx) => {
      const freq = midiToFreq(midi);
      const stagger = idx * 0.02;
      const t0 = startTime + stagger;
      const tEnd = startTime + duration;
      if (t0 >= tEnd) return;

      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freq, t0);

      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, t0);
      osc2.detune.setValueAtTime((Math.random() - 0.5) * 8, t0);

      const tineOsc = ctx.createOscillator();
      tineOsc.type = 'sine';
      tineOsc.frequency.setValueAtTime(freq * 4, t0);

      const tineGain = ctx.createGain();
      tineGain.gain.setValueAtTime(0.055 * gainScale, t0);
      tineGain.gain.exponentialRampToValueAtTime(0.0008, Math.min(tEnd, t0 + 0.22));

      const noteGain = ctx.createGain();
      noteGain.gain.setValueAtTime(0.0001, t0);
      noteGain.gain.linearRampToValueAtTime((0.14 * gainScale) / Math.sqrt(notes.length), t0 + 0.018);
      noteGain.gain.exponentialRampToValueAtTime((0.06 * gainScale) / Math.sqrt(notes.length), Math.max(t0 + 0.05, tEnd - 0.06));
      noteGain.gain.linearRampToValueAtTime(0.0001, tEnd);

      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(((idx / Math.max(1, notes.length - 1)) - 0.5) * 0.45, t0);

      osc1.connect(noteGain);
      const overGain = ctx.createGain();
      overGain.gain.value = 0.22;
      osc2.connect(overGain);
      overGain.connect(noteGain);
      tineOsc.connect(tineGain);
      tineGain.connect(noteGain);

      noteGain.connect(panner);
      panner.connect(dest);

      osc1.start(t0);
      osc2.start(t0);
      tineOsc.start(t0);
      osc1.stop(tEnd + 0.02);
      osc2.stop(tEnd + 0.02);
      tineOsc.stop(tEnd + 0.02);
    });
  }

  function scheduleDrumHit(ctx, dest, noiseBuf, type, time, velocity = 1) {
    if (type === 'kick' || type === 'house_kick') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(type === 'house_kick' ? 148 : 128, time);
      osc.frequency.exponentialRampToValueAtTime(type === 'house_kick' ? 48 : 42, time + 0.13);

      gain.gain.setValueAtTime(0.88 * velocity, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + (type === 'house_kick' ? 0.28 : 0.32));

      osc.connect(gain);
      gain.connect(dest);
      osc.start(time);
      osc.stop(time + 0.34);
    } else if (type === 'snare' || type === 'clap') {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(type === 'clap' ? 1950 : 1650, time);
      bp.Q.value = type === 'clap' ? 1.1 : 0.7;

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.45 * velocity, time);
      nGain.gain.exponentialRampToValueAtTime(0.001, time + (type === 'clap' ? 0.16 : 0.19));

      noise.connect(bp);
      bp.connect(nGain);
      nGain.connect(dest);
      noise.start(time);
      noise.stop(time + 0.2);

      if (type === 'snare') {
        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(195, time);
        body.frequency.exponentialRampToValueAtTime(105, time + 0.08);
        const bGain = ctx.createGain();
        bGain.gain.setValueAtTime(0.32 * velocity, time);
        bGain.gain.exponentialRampToValueAtTime(0.001, time + 0.11);
        body.connect(bGain);
        bGain.connect(dest);
        body.start(time);
        body.stop(time + 0.12);
      }
    } else if (type === 'hat' || type === 'open_hat') {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(type === 'open_hat' ? 5600 : 6400, time);

      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(11000, time);

      const dur = type === 'open_hat' ? 0.18 : 0.055;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime((type === 'open_hat' ? 0.22 : 0.16) * velocity, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

      noise.connect(hp);
      hp.connect(lpf);
      lpf.connect(gain);
      gain.connect(dest);
      noise.start(time);
      noise.stop(time + dur + 0.02);
    }
  }

  function scheduleTanpuraDrone(ctx, dest, keyIndex, totalDur, level = 0.16) {
    const saLow = midiToFreq(48 + keyIndex); // Sa
    const pa = midiToFreq(48 + keyIndex + 7); // Pa
    const saHigh = midiToFreq(60 + keyIndex); // Upper Sa

    const strings = [
      { freq: saLow, type: 'sawtooth', gain: level * 0.45, pan: -0.2 },
      { freq: pa, type: 'sawtooth', gain: level * 0.28, pan: 0.22 },
      { freq: saHigh, type: 'triangle', gain: level * 0.35, pan: 0.0 }
    ];

    strings.forEach((s, idx) => {
      const osc = ctx.createOscillator();
      osc.type = s.type;
      osc.frequency.setValueAtTime(s.freq, 0);
      osc.detune.setValueAtTime((idx - 1) * 3.5, 0);

      // Slow breathing amplitude modulation for authentic tanpura jawari shimmer
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.32 + idx * 0.14;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = s.gain * 0.28;

      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 1450;
      lpf.Q.value = 2.2;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, 0);
      g.gain.linearRampToValueAtTime(s.gain, 0.25);
      g.gain.setValueAtTime(s.gain, Math.max(0.3, totalDur - 0.25));
      g.gain.linearRampToValueAtTime(0.001, totalDur);

      const pan = ctx.createStereoPanner();
      pan.pan.value = s.pan;

      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      osc.connect(lpf);
      lpf.connect(g);
      g.connect(pan);
      pan.connect(dest);

      osc.start(0);
      lfo.start(0);
      osc.stop(totalDur + 0.02);
      lfo.stop(totalDur + 0.02);
    });
  }

  function scheduleNadhaswaramPhrase(ctx, dest, keyIndex, scaleType, barStart, barDur, beatDur) {
    const iv = getScaleIntervals(scaleType);
    const base = 60 + keyIndex; // Middle C4..B4 register
    const swaraPool = [
      base + iv[0],
      base + (iv[1] ?? 2),
      base + (iv[2] ?? 4),
      base + (iv[3] ?? 5),
      base + (iv[4] ?? 7),
      base + (iv[5] ?? 9),
      base + 12
    ];

    // Expressive gamaka melody sequence (6 notes across 1 bar)
    const steps = [
      { idx: 0, offset: 0, dur: beatDur * 0.9, slideFrom: -2 },
      { idx: 2, offset: beatDur * 0.9, dur: beatDur * 0.85, slideFrom: 1 },
      { idx: 4, offset: beatDur * 1.75, dur: beatDur * 1.15, slideFrom: -1 },
      { idx: 3, offset: beatDur * 2.9, dur: beatDur * 0.5, slideFrom: 1 },
      { idx: 2, offset: beatDur * 3.4, dur: beatDur * 0.55, slideFrom: 1 }
    ];

    steps.forEach((step) => {
      const t0 = barStart + step.offset;
      const tEnd = Math.min(barStart + barDur, t0 + step.dur);
      if (tEnd <= t0 + 0.05) return;

      const targetFreq = midiToFreq(swaraPool[step.idx % swaraPool.length]);
      const startFreq = midiToFreq(swaraPool[step.idx % swaraPool.length] + step.slideFrom);

      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(startFreq, t0);
      osc1.frequency.exponentialRampToValueAtTime(targetFreq, Math.min(tEnd, t0 + 0.09));

      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(startFreq, t0);
      osc2.frequency.exponentialRampToValueAtTime(targetFreq, Math.min(tEnd, t0 + 0.09));

      // Gamaka vibrato
      const vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = 5.4;
      const vibDepth = ctx.createGain();
      vibDepth.gain.setValueAtTime(0, t0);
      vibDepth.gain.linearRampToValueAtTime(targetFreq * 0.014, Math.min(tEnd, t0 + 0.14));
      vib.connect(vibDepth);
      vibDepth.connect(osc1.frequency);
      vibDepth.connect(osc2.frequency);

      // Double-reed nasal formant resonators
      const formant1 = ctx.createBiquadFilter();
      formant1.type = 'bandpass';
      formant1.frequency.value = 1150;
      formant1.Q.value = 2.4;

      const formant2 = ctx.createBiquadFilter();
      formant2.type = 'peaking';
      formant2.frequency.value = 2400;
      formant2.Q.value = 1.8;
      formant2.gain.value = 6;

      const lowWarmth = ctx.createBiquadFilter();
      lowWarmth.type = 'lowpass';
      lowWarmth.frequency.value = 3400;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.001, t0);
      env.gain.linearRampToValueAtTime(0.26, t0 + 0.045);
      env.gain.setValueAtTime(0.22, Math.max(t0 + 0.05, tEnd - 0.06));
      env.gain.linearRampToValueAtTime(0.001, tEnd);

      const sqGain = ctx.createGain();
      sqGain.gain.value = 0.28;

      osc1.connect(formant1);
      osc2.connect(sqGain);
      sqGain.connect(formant1);
      formant1.connect(formant2);
      formant2.connect(lowWarmth);
      lowWarmth.connect(env);
      env.connect(dest);

      osc1.start(t0);
      osc2.start(t0);
      vib.start(t0);
      osc1.stop(tEnd + 0.02);
      osc2.stop(tEnd + 0.02);
      vib.stop(tEnd + 0.02);
    });
  }

  function scheduleMridangamStroke(ctx, dest, noiseBuf, stroke, time, keyIndex, velocity = 1) {
    const tonic = midiToFreq(48 + keyIndex); // Tuned Valanthalai pitch to track root!

    if (stroke === 'thom' || stroke === 'gumki') {
      // Thoppi left bass head
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      if (stroke === 'gumki') {
        osc.frequency.setValueAtTime(68, time);
        osc.frequency.exponentialRampToValueAtTime(118, time + 0.07);
        osc.frequency.exponentialRampToValueAtTime(74, time + 0.22);
      } else {
        osc.frequency.setValueAtTime(142, time);
        osc.frequency.exponentialRampToValueAtTime(64, time + 0.14);
      }

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.75 * velocity, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.26);

      osc.connect(g);
      g.connect(dest);
      osc.start(time);
      osc.stop(time + 0.28);
    } else if (stroke === 'dhin' || stroke === 'nam' || stroke === 'chapu') {
      // Valanthalai resonant treble head
      const f1 = stroke === 'chapu' ? tonic * 1.5 : tonic * 2;
      const f2 = f1 * 1.98;
      const dur = stroke === 'chapu' ? 0.28 : 0.21;

      const osc1 = ctx.createOscillator();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(f1, time);

      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(f2, time);

      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0.38 * velocity, time);
      g1.gain.exponentialRampToValueAtTime(0.001, time + dur);

      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.22 * velocity, time);
      g2.gain.exponentialRampToValueAtTime(0.001, time + dur * 0.75);

      osc1.connect(g1);
      osc2.connect(g2);
      g1.connect(dest);
      g2.connect(dest);
      osc1.start(time);
      osc2.start(time);
      osc1.stop(time + dur + 0.02);
      osc2.stop(time + dur + 0.02);

      // Crisp finger-slap transient
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 1.4;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.28 * velocity, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.032);
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(dest);
      noise.start(time);
      noise.stop(time + 0.04);
    } else if (stroke === 'tha') {
      // Damped crisp palm stroke ("Tha")
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1250;
      bp.Q.value = 1.8;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.42 * velocity, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.055);
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(dest);
      noise.start(time);
      noise.stop(time + 0.065);
    }
  }

  function scheduleMridangamBar(ctx, dest, noiseBuf, barStart, beatDur, keyIndex) {
    // Adi Tala 8-matra / 16-subdivision groove: Tha Dhin Thom Nam | Tha Thom Dhin Chapu
    const q = beatDur / 2;
    const events = [
      { s: 'thom', t: 0, v: 1.0 },
      { s: 'dhin', t: 0.01, v: 0.9 },
      { s: 'tha', t: q * 1, v: 0.75 },
      { s: 'chapu', t: q * 2, v: 0.85 },
      { s: 'gumki', t: q * 3, v: 0.85 },
      { s: 'tha', t: q * 3.5, v: 0.6 },
      { s: 'nam', t: q * 4, v: 0.95 },
      { s: 'tha', t: q * 5, v: 0.7 },
      { s: 'thom', t: q * 6, v: 0.95 },
      { s: 'dhin', t: q * 6, v: 0.8 },
      { s: 'chapu', t: q * 7, v: 0.9 }
    ];

    events.forEach((ev) => {
      scheduleMridangamStroke(ctx, dest, noiseBuf, ev.s, barStart + ev.t, keyIndex, ev.v);
    });
  }

  function scheduleHouseBassGroove(ctx, dest, chords, bar, barStart, beatDur) {
    const chord = chords[bar % chords.length];
    const root = chord[0] - 12;
    const oct = root + 12;
    const fifth = root + 7;

    const hits = [
      { midi: root, t: 0, dur: beatDur * 0.72 },
      { midi: root, t: beatDur * 0.75, dur: beatDur * 0.45 },
      { midi: fifth, t: beatDur * 1.5, dur: beatDur * 0.45 },
      { midi: root, t: beatDur * 2.0, dur: beatDur * 0.72 },
      { midi: oct, t: beatDur * 2.75, dur: beatDur * 0.45 },
      { midi: fifth, t: beatDur * 3.5, dur: beatDur * 0.45 }
    ];

    hits.forEach((h) => {
      const t0 = barStart + h.t;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiToFreq(h.midi), t0);

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(midiToFreq(h.midi), t0);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(920, t0);
      lp.frequency.exponentialRampToValueAtTime(240, t0 + h.dur);
      lp.Q.value = 3.2;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(0.46, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.14, Math.max(t0 + 0.03, t0 + h.dur - 0.03));
      g.gain.linearRampToValueAtTime(0.001, t0 + h.dur);

      osc.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      g.connect(dest);

      osc.start(t0);
      sub.start(t0);
      osc.stop(t0 + h.dur + 0.02);
      sub.stop(t0 + h.dur + 0.02);
    });
  }

  function scheduleDeepHouseStab(ctx, dest, notes, startTime, dur) {
    notes.forEach((midi, idx) => {
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscB.type = 'triangle';
      const freq = midiToFreq(midi);
      oscA.frequency.setValueAtTime(freq, startTime);
      oscB.frequency.setValueAtTime(freq, startTime);
      oscA.detune.setValueAtTime(-7, startTime);
      oscB.detune.setValueAtTime(7, startTime);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(260, startTime);
      lp.frequency.exponentialRampToValueAtTime(1750, startTime + 0.05);
      lp.frequency.exponentialRampToValueAtTime(340, startTime + dur);
      lp.Q.value = 2.0;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, startTime);
      g.gain.linearRampToValueAtTime(0.11 / Math.sqrt(notes.length), startTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + dur);

      const pan = ctx.createStereoPanner();
      pan.pan.value = ((idx % 2 === 0 ? -1 : 1) * 0.35);

      oscA.connect(lp);
      oscB.connect(lp);
      lp.connect(g);
      g.connect(pan);
      pan.connect(dest);

      oscA.start(startTime);
      oscB.start(startTime);
      oscA.stop(startTime + dur + 0.02);
      oscB.stop(startTime + dur + 0.02);
    });
  }

  function scheduleOrchestralBar(ctx, dest, chord, barStart, barDur, beatDur) {
    // 1. Warm stereo String Ensemble swell
    chord.forEach((midi, idx) => {
      const freq = midiToFreq(midi);
      [-10, 0, 10].forEach((det) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, barStart);
        osc.detune.setValueAtTime(det, barStart);

        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(1400, barStart);
        lp.frequency.linearRampToValueAtTime(2300, barStart + barDur * 0.55);
        lp.frequency.linearRampToValueAtTime(1200, barStart + barDur);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, barStart);
        g.gain.linearRampToValueAtTime(0.036 / Math.sqrt(chord.length), barStart + Math.min(0.45, barDur * 0.3));
        g.gain.setValueAtTime(0.036 / Math.sqrt(chord.length), Math.max(barStart + 0.5, barStart + barDur - 0.35));
        g.gain.linearRampToValueAtTime(0.001, barStart + barDur);

        const pan = ctx.createStereoPanner();
        pan.pan.value = ((idx / Math.max(1, chord.length - 1)) - 0.5) * 0.75;

        osc.connect(lp);
        lp.connect(g);
        g.connect(pan);
        pan.connect(dest);
        osc.start(barStart);
        osc.stop(barStart + barDur + 0.02);
      });
    });

    // 2. Warm French Horn / Low Brass fifth drone swell
    const brassNotes = [chord[0] - 12, chord[0] - 5];
    brassNotes.forEach((midi) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiToFreq(midi), barStart);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(520, barStart);
      lp.frequency.linearRampToValueAtTime(980, barStart + barDur * 0.5);
      lp.frequency.linearRampToValueAtTime(480, barStart + barDur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, barStart);
      g.gain.linearRampToValueAtTime(0.085, barStart + 0.35);
      g.gain.linearRampToValueAtTime(0.001, barStart + barDur);

      osc.connect(lp);
      lp.connect(g);
      g.connect(dest);
      osc.start(barStart);
      osc.stop(barStart + barDur + 0.02);
    });

    // 3. Pizzicato / Harp plucked arpeggio bits
    chord.forEach((midi, idx) => {
      const t0 = barStart + idx * (beatDur * 0.5);
      if (t0 >= barStart + barDur - 0.1) return;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(midi + 12), t0);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.11, t0);
      g.gain.exponentialRampToValueAtTime(0.0008, Math.min(barStart + barDur, t0 + 0.35));

      const pan = ctx.createStereoPanner();
      pan.pan.value = ((idx % 2 === 0 ? -1 : 1) * 0.45);

      osc.connect(g);
      g.connect(pan);
      pan.connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.38);
    });
  }

  async function generateSample({
    preset = 'rhodes',
    keyIndex = 0,
    scale = 'minor',
    bpm = 78,
    bars = 4,
    sampleRate = 44100
  }) {
    const safeBpm = Math.max(55, Math.min(138, Number(bpm) || 78));
    const safeBars = Math.max(1, Math.min(8, Number(bars) || 4));
    const beatDur = 60 / safeBpm;
    const barDur = beatDur * 4;
    const totalDur = barDur * safeBars;
    const totalSamples = Math.floor(totalDur * sampleRate);

    const offline = new OfflineAudioContext(2, totalSamples, sampleRate);
    const masterBus = offline.createGain();
    masterBus.gain.value = 0.85;

    const tapeLpf = offline.createBiquadFilter();
    tapeLpf.type = 'lowpass';
    tapeLpf.frequency.value = ['drums', 'deep_house', 'soul_house', 'bass_drums', 'mridangam'].includes(preset)
      ? 10500
      : 3800;
    tapeLpf.Q.value = 0.7;

    masterBus.connect(tapeLpf);
    tapeLpf.connect(offline.destination);

    const chords = getChordProgression(keyIndex, scale);
    const noiseBuf = createNoiseBuffer(offline, 1.5);

    if (preset === 'rhodes') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const chord = chords[bar % chords.length];
        const barStart = bar * barDur;
        scheduleRhodesChord(offline, masterBus, chord, barStart, beatDur * 2.45);
        scheduleRhodesChord(offline, masterBus, chord, barStart + beatDur * 2.5, beatDur * 1.45);
      }
    } else if (preset === 'drums') {
      const sixteenth = beatDur / 4;
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        scheduleDrumHit(offline, masterBus, noiseBuf, 'kick', bStart + 0 * beatDur, 1.0);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'kick', bStart + 1.5 * beatDur + 0.012, 0.75);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'kick', bStart + 2.75 * beatDur, 0.85);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + 1 * beatDur, 0.95);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + 3 * beatDur, 1.0);
        if (bar % 2 === 1) {
          scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + 3.75 * beatDur, 0.42);
        }
        for (let step = 0; step < 16; step += 2) {
          const swing = (step % 4 === 2) ? sixteenth * 0.28 : 0;
          const vel = (step % 4 === 0) ? 0.85 : 0.45;
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + step * sixteenth + swing, vel);
        }
      }
    } else if (preset === 'bass') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const chord = chords[bar % chords.length];
        const root = chord[0] - 12;
        const fifth = root + 7;
        const barStart = bar * barDur;
        const hits = [
          { midi: root, time: barStart, dur: beatDur * 1.4 },
          { midi: root, time: barStart + beatDur * 1.5, dur: beatDur * 0.9 },
          { midi: fifth, time: barStart + beatDur * 2.5, dur: beatDur * 0.85 },
          { midi: root + 12, time: barStart + beatDur * 3.5, dur: beatDur * 0.45 }
        ];
        hits.forEach((hit) => {
          const osc = offline.createOscillator();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(midiToFreq(hit.midi), hit.time);
          const sub = offline.createOscillator();
          sub.type = 'sine';
          sub.frequency.setValueAtTime(midiToFreq(hit.midi), hit.time);
          const lp = offline.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(420, hit.time);
          const g = offline.createGain();
          g.gain.setValueAtTime(0.001, hit.time);
          g.gain.linearRampToValueAtTime(0.55, hit.time + 0.02);
          g.gain.exponentialRampToValueAtTime(0.18, Math.max(hit.time + 0.04, hit.time + hit.dur - 0.04));
          g.gain.linearRampToValueAtTime(0.001, hit.time + hit.dur);
          osc.connect(lp);
          sub.connect(lp);
          lp.connect(g);
          g.connect(masterBus);
          osc.start(hit.time);
          sub.start(hit.time);
          osc.stop(hit.time + hit.dur + 0.02);
          sub.stop(hit.time + hit.dur + 0.02);
        });
      }
    } else if (preset === 'pad') {
      tapeLpf.frequency.value = 1800;
      for (let bar = 0; bar < safeBars; bar += 1) {
        const chord = chords[bar % chords.length];
        const barStart = bar * barDur;
        chord.forEach((midi, idx) => {
          const freq = midiToFreq(midi);
          const oscA = offline.createOscillator();
          const oscB = offline.createOscillator();
          oscA.type = 'sawtooth';
          oscB.type = 'sawtooth';
          oscA.frequency.setValueAtTime(freq, barStart);
          oscB.frequency.setValueAtTime(freq, barStart);
          oscA.detune.setValueAtTime(-9, barStart);
          oscB.detune.setValueAtTime(9, barStart);
          const g = offline.createGain();
          g.gain.setValueAtTime(0.001, barStart);
          g.gain.linearRampToValueAtTime(0.075 / Math.sqrt(chord.length), barStart + 0.35);
          g.gain.setValueAtTime(0.075 / Math.sqrt(chord.length), barStart + barDur - 0.35);
          g.gain.linearRampToValueAtTime(0.001, barStart + barDur);
          const pan = offline.createStereoPanner();
          pan.pan.setValueAtTime(((idx % 2 === 0 ? -1 : 1) * 0.35), barStart);
          oscA.connect(g);
          oscB.connect(g);
          g.connect(pan);
          pan.connect(masterBus);
          oscA.start(barStart);
          oscB.start(barStart);
          oscA.stop(barStart + barDur + 0.02);
          oscB.stop(barStart + barDur + 0.02);
        });
      }
    } else if (preset === 'vinyl') {
      const rainBuf = createNoiseBuffer(offline, totalDur);
      const rainSrc = offline.createBufferSource();
      rainSrc.buffer = rainBuf;
      const bp = offline.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1250;
      bp.Q.value = 0.55;
      const rainGain = offline.createGain();
      rainGain.gain.value = 0.24;
      const humOsc = offline.createOscillator();
      humOsc.type = 'sine';
      humOsc.frequency.value = 60;
      const humGain = offline.createGain();
      humGain.gain.value = 0.025;
      rainSrc.connect(bp);
      bp.connect(rainGain);
      rainGain.connect(masterBus);
      humOsc.connect(humGain);
      humGain.connect(masterBus);
      rainSrc.start(0);
      humOsc.start(0);
    } else if (preset === 'nadhaswaram') {
      scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.16);
      for (let bar = 0; bar < safeBars; bar += 1) {
        scheduleNadhaswaramPhrase(offline, masterBus, keyIndex, scale, bar * barDur, barDur, beatDur);
      }
    } else if (preset === 'mridangam') {
      scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.07);
      for (let bar = 0; bar < safeBars; bar += 1) {
        scheduleMridangamBar(offline, masterBus, noiseBuf, bar * barDur, beatDur, keyIndex);
      }
    } else if (preset === 'carnatic_lofi') {
      scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.12);
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 3.8, 0.65);
        scheduleMridangamBar(offline, masterBus, noiseBuf, bStart, beatDur, keyIndex);
        if (bar % 2 === 0) {
          scheduleNadhaswaramPhrase(offline, masterBus, keyIndex, scale, bStart, barDur, beatDur);
        }
      }
    } else if (preset === 'deep_house') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        for (let beat = 0; beat < 4; beat += 1) {
          scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + beat * beatDur, 0.95);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'open_hat', bStart + (beat + 0.5) * beatDur, 0.72);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + (beat + 0.25) * beatDur, 0.35);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + (beat + 0.75) * beatDur, 0.45);
        }
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 1, 0.9);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 3, 0.9);

        scheduleDeepHouseStab(offline, masterBus, chord, bStart + beatDur * 0.75, beatDur * 0.8);
        scheduleDeepHouseStab(offline, masterBus, chord, bStart + beatDur * 2.5, beatDur * 1.1);
        scheduleHouseBassGroove(offline, masterBus, chords, bar, bStart, beatDur);
      }
    } else if (preset === 'soul_house') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        for (let beat = 0; beat < 4; beat += 1) {
          scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + beat * beatDur, 0.9);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'open_hat', bStart + (beat + 0.5) * beatDur, 0.55);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + (beat + 0.75) * beatDur, 0.48);
        }
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + beatDur * 1, 0.78);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 1, 0.55);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + beatDur * 3, 0.82);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 3, 0.58);

        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 1.4, 0.95);
        scheduleRhodesChord(offline, masterBus, chord, bStart + beatDur * 1.5, beatDur * 1.2, 0.8);
        scheduleRhodesChord(offline, masterBus, chord, bStart + beatDur * 2.75, beatDur * 1.1, 0.85);
        scheduleHouseBassGroove(offline, masterBus, chords, bar, bStart, beatDur);
      }
    } else if (preset === 'bass_drums') {
      const sixteenth = beatDur / 4;
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + 0 * beatDur, 1.0);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + 1.5 * beatDur, 0.82);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + 2.75 * beatDur, 0.9);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + 1 * beatDur, 0.95);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', bStart + 3 * beatDur, 1.0);
        for (let step = 0; step < 16; step += 2) {
          const swing = (step % 4 === 2) ? sixteenth * 0.25 : 0;
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + step * sixteenth + swing, step % 4 === 0 ? 0.85 : 0.45);
        }
        scheduleHouseBassGroove(offline, masterBus, chords, bar, bStart, beatDur);
      }
    } else if (preset === 'orchestral') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const chord = chords[bar % chords.length];
        scheduleOrchestralBar(offline, masterBus, chord, bar * barDur, barDur, beatDur);
      }
    }

    const rendered = await offline.startRendering();
    addVinylDustToBuffer(
      rendered,
      preset === 'vinyl' ? 0.28 : (['deep_house', 'soul_house'].includes(preset) ? 0.03 : 0.07)
    );

    const keyLabel = NOTE_NAMES[keyIndex] || 'C';
    const scaleNames = {
      minor: 'Min',
      major: 'Maj',
      mohanam: 'Mohanam',
      kalyani: 'Kalyani',
      mayamalavagowla: 'Mayamalavagowla',
      charukesi: 'Charukesi'
    };
    const scaleLabel = scaleNames[scale] || scale;
    const presetLabels = {
      rhodes: `Dusty Rhodes (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      drums: `Boom-Bap Drums (${safeBpm} BPM)`,
      bass: `Warm Tape Bass (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      pad: `Midnight Pad (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      vinyl: `Vinyl Rain & Crackles (${safeBars} Bars)`,
      nadhaswaram: `Nadhaswaram + Tanpura (${keyLabel} ${scaleLabel})`,
      mridangam: `Mridangam Tala (${keyLabel} • ${safeBpm} BPM)`,
      carnatic_lofi: `Modern Carnatic Lo-Fi (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      deep_house: `Deep House (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      soul_house: `Soul House (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      bass_drums: `Bass & Drums Pocket (${keyLabel} ${scaleLabel} • ${safeBpm} BPM)`,
      orchestral: `Orchestral Strings & Brass (${keyLabel} ${scaleLabel})`
    };

    return {
      buffer: rendered,
      title: presetLabels[preset] || 'Lo-Fi Sample'
    };
  }

  function scheduleSubBassLine(ctx, dest, chords, barIndex, barStart, beatDur, density = 0.65) {
    const chord = chords[barIndex % chords.length];
    const root = (chord[0] || 48) - 12;
    const fifth = root + 7;
    const steps = density > 0.6
      ? [
          { off: 0, dur: beatDur * 1.35, midi: root },
          { off: beatDur * 1.5, dur: beatDur * 0.85, midi: root },
          { off: beatDur * 2.5, dur: beatDur * 0.75, midi: fifth },
          { off: beatDur * 3.25, dur: beatDur * 0.65, midi: root + 3 }
        ]
      : [
          { off: 0, dur: beatDur * 1.8, midi: root },
          { off: beatDur * 2.5, dur: beatDur * 1.25, midi: fifth }
        ];

    steps.forEach((n) => {
      const t0 = barStart + n.off;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(n.midi), t0);
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(midiToFreq(n.midi), t0);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(340, t0);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(0.46, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.14, Math.max(t0 + 0.05, t0 + n.dur - 0.04));
      g.gain.linearRampToValueAtTime(0.001, t0 + n.dur);

      osc.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      g.connect(dest);
      osc.start(t0);
      sub.start(t0);
      osc.stop(t0 + n.dur + 0.02);
      sub.stop(t0 + n.dur + 0.02);
    });
  }

  function schedulePatternBar(offline, masterBus, noiseBuf, barStart, beatDur, profile, opts = {}) {
    const sixteenth = beatDur / 4;
    const swing = Math.max(0, Math.min(0.28, Number(profile?.swingRatio) || 0.14));
    const kicks = Array.isArray(profile?.kickPattern) && profile.kickPattern.length === 16
      ? profile.kickPattern
      : [1, 0, 0, 0.35, 0, 0, 0.5, 0, 0.85, 0, 0.45, 0, 0, 0, 0, 0];
    const snares = Array.isArray(profile?.snarePattern) && profile.snarePattern.length === 16
      ? profile.snarePattern
      : [0, 0, 0, 0, 0.9, 0, 0, 0.25, 0, 0, 0, 0, 0.92, 0, 0, 0.25];
    const hats = Array.isArray(profile?.hatPattern) && profile.hatPattern.length === 16
      ? profile.hatPattern
      : [0.65, 0.25, 0.55, 0.25, 0.7, 0.25, 0.55, 0.35, 0.65, 0.25, 0.55, 0.25, 0.7, 0.25, 0.6, 0.35];
    const halfTime = Boolean(opts.halfTime);
    const drumGain = Number.isFinite(opts.drumScale) ? opts.drumScale : 1.0;

    for (let step = 0; step < 16; step += 1) {
      const swingOffset = (step % 2 === 1) ? sixteenth * swing : 0;
      const t = barStart + step * sixteenth + swingOffset;
      const kVel = kicks[step] || 0;
      const sVel = snares[step] || 0;
      const hVel = hats[step] || 0;

      if (kVel >= 0.18 && (!halfTime || step % 4 === 0)) {
        scheduleDrumHit(offline, masterBus, noiseBuf, 'kick', t, Math.min(1, (0.55 + 0.45 * kVel) * drumGain));
      }
      if (sVel >= 0.18 && (!halfTime || step === 8)) {
        scheduleDrumHit(offline, masterBus, noiseBuf, 'snare', t, Math.min(1, (0.45 + 0.5 * sVel) * drumGain));
      }
      if (hVel >= 0.16 && !halfTime) {
        scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', t, Math.min(1, (0.28 + 0.5 * hVel) * drumGain));
      }
    }
  }

  async function generateStyleMatchedSample({
    styleProfile = {},
    styleMode = 'lofi_clone',
    bpmOverride = null,
    keyOverride = null,
    scaleOverride = null,
    bars = 4,
    referenceLabel = 'Reference Lo-Fi',
    sampleRate = 44100
  } = {}) {
    const rawBpm = bpmOverride || styleProfile.bpm || 82;
    const targetBpm = styleMode === 'deep_chill_house'
      ? Math.max(106, Math.min(126, rawBpm < 95 ? Math.round(rawBpm * 1.35) : Math.round(rawBpm)))
      : Math.max(58, Math.min(134, Math.round(rawBpm)));
    const keyIndex = Number.isInteger(keyOverride) ? keyOverride : (Number(styleProfile.keyIndex) || 5);
    const scale = scaleOverride || styleProfile.scale || 'mohanam';
    const safeBars = Math.max(2, Math.min(8, Number(bars) || 4));
    const beatDur = 60 / targetBpm;
    const barDur = beatDur * 4;
    const totalDur = barDur * safeBars;

    const offline = new OfflineAudioContext(2, Math.floor(totalDur * sampleRate), sampleRate);
    const masterBus = offline.createGain();
    masterBus.gain.value = 0.86;

    const tapeLpf = offline.createBiquadFilter();
    tapeLpf.type = 'lowpass';
    tapeLpf.frequency.value = styleMode === 'deep_chill_house'
      ? 6500
      : Math.max(1800, Math.min(5200, (Number(styleProfile.warmthCutoffHz) || 2400) * 1.35));
    tapeLpf.Q.value = 0.65;

    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = -13;
    comp.ratio.value = 3.2;

    masterBus.connect(tapeLpf);
    tapeLpf.connect(comp);
    comp.connect(offline.destination);

    const noiseBuf = createNoiseBuffer(offline, 0.35);
    const chords = getChordProgression(keyIndex, scale);
    const isCarnaticScale = ['mohanam', 'kalyani', 'mayamalavagowla', 'charukesi'].includes(scale);

    if (styleMode === 'pure_drums_bass') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        schedulePatternBar(offline, masterBus, noiseBuf, bStart, beatDur, styleProfile, { drumScale: 1.05 });
        scheduleSubBassLine(offline, masterBus, chords, bar, bStart, beatDur, styleProfile.bassDensity || 0.7);
      }
    } else if (styleMode === 'carnatic_lofi_flip') {
      scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.11);
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        schedulePatternBar(offline, masterBus, noiseBuf, bStart, beatDur, styleProfile, { drumScale: 0.9 });
        scheduleMridangamBar(offline, masterBus, noiseBuf, bStart, beatDur, keyIndex);
        scheduleSubBassLine(offline, masterBus, chords, bar, bStart, beatDur, 0.6);
        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 3.6, 0.58);
      }
    } else if (styleMode === 'deep_chill_house') {
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        for (let beat = 0; beat < 4; beat += 1) {
          scheduleDrumHit(offline, masterBus, noiseBuf, 'house_kick', bStart + beat * beatDur, 0.92);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'open_hat', bStart + (beat + 0.5) * beatDur, 0.52);
          scheduleDrumHit(offline, masterBus, noiseBuf, 'hat', bStart + (beat + 0.75) * beatDur, 0.38);
        }
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 1, 0.78);
        scheduleDrumHit(offline, masterBus, noiseBuf, 'clap', bStart + beatDur * 3, 0.8);
        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 1.4, 0.78);
        scheduleDeepHouseStab(offline, masterBus, chord, bStart + beatDur * 2.5, beatDur * 1.0);
        scheduleHouseBassGroove(offline, masterBus, chords, bar, bStart, beatDur);
      }
    } else if (styleMode === 'halftime_ambient') {
      if (isCarnaticScale) {
        scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.09);
      }
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        schedulePatternBar(offline, masterBus, noiseBuf, bStart, beatDur, styleProfile, { halfTime: true, drumScale: 0.75 });
        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 3.85, 0.75);
        scheduleSubBassLine(offline, masterBus, chords, bar, bStart, beatDur, 0.4);
      }
    } else {
      // lofi_clone: full groove + warm chords + sub matched to reference track
      if (isCarnaticScale) {
        scheduleTanpuraDrone(offline, masterBus, keyIndex, totalDur, 0.08);
      }
      for (let bar = 0; bar < safeBars; bar += 1) {
        const bStart = bar * barDur;
        const chord = chords[bar % chords.length];
        schedulePatternBar(offline, masterBus, noiseBuf, bStart, beatDur, styleProfile, { drumScale: 1.0 });
        scheduleSubBassLine(offline, masterBus, chords, bar, bStart, beatDur, styleProfile.bassDensity || 0.7);
        scheduleRhodesChord(offline, masterBus, chord, bStart, beatDur * 2.2, 0.74);
        scheduleRhodesChord(offline, masterBus, chord, bStart + beatDur * 2.5, beatDur * 1.4, 0.56);
      }
    }

    const rendered = await offline.startRendering();
    addVinylDustToBuffer(rendered, styleMode === 'deep_chill_house' ? 0.03 : 0.09);

    const keyLabel = NOTE_NAMES[keyIndex] || 'C';
    const modeNames = {
      lofi_clone: 'Style Lo-Fi Pocket',
      carnatic_lofi_flip: 'Carnatic Lo-Fi Flip',
      pure_drums_bass: 'Style Drums & Sub',
      deep_chill_house: 'Deep Chill House',
      halftime_ambient: 'Half-Time Ambient'
    };
    const shortRef = String(referenceLabel || 'Ref').replace(/\s*\[.*?\]/g, '').slice(0, 22).trim();

    return {
      buffer: rendered,
      bpm: targetBpm,
      keyIndex,
      scale,
      title: `${modeNames[styleMode] || 'AI Style Beat'} (${shortRef} • ${keyLabel} ${scale} • ${targetBpm} BPM) [AI BEAT]`
    };
  }

  return {
    NOTE_NAMES,
    generateSample,
    generateStyleMatchedSample
  };
})();
