/**
 * Real-time Vocal Tuner AudioWorkletProcessor
 * Combines a dual-head Hann-windowed granular pitch shifter (speed-independent)
 * with a lightweight NSDF pitch detector for optional Auto-Tune scale snapping.
 */

const SCALES = {
  1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // Chromatic
  2: [0, 2, 4, 5, 7, 9, 11],                 // Major
  3: [0, 2, 3, 5, 7, 8, 10],                 // Natural Minor
  4: [0, 3, 5, 7, 10]                        // Minor Pentatonic
};

function snapMidiToScale(midiFloat, keyRoot, scaleMode) {
  const intervals = SCALES[scaleMode] || SCALES[1];
  const baseOctave = Math.floor(midiFloat / 12) - 1;
  let bestMidi = Math.round(midiFloat);
  let bestDist = Infinity;

  for (let oct = baseOctave - 1; oct <= baseOctave + 1; oct += 1) {
    for (let i = 0; i < intervals.length; i += 1) {
      const candidate = (oct + 1) * 12 + ((keyRoot + intervals[i]) % 12);
      const dist = Math.abs(candidate - midiFloat);
      if (dist < bestDist) {
        bestDist = dist;
        bestMidi = candidate;
      }
    }
  }
  return bestMidi;
}

class VocalTunerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchSemitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
      { name: 'fineCents', defaultValue: 0, minValue: -50, maxValue: 50, automationRate: 'k-rate' },
      { name: 'autoTuneMode', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'keyRoot', defaultValue: 0, minValue: 0, maxValue: 11, automationRate: 'k-rate' },
      { name: 'retuneSpeed', defaultValue: 0.45, minValue: 0.05, maxValue: 1.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.ringSize = 4096;
    this.ringMask = this.ringSize - 1;
    this.ringL = new Float32Array(this.ringSize);
    this.ringR = new Float32Array(this.ringSize);
    this.writeIndex = 0;

    this.grainSize = 1536;
    this.phase = 0;
    this.bypassMix = 1.0;

    // Pitch analysis buffer (1024 samples, analyzed every 512 samples)
    this.analysisSize = 1024;
    this.analysisBuf = new Float32Array(this.analysisSize);
    this.orderedBuf = new Float32Array(this.analysisSize);
    this.analysisPos = 0;
    this.hopCounter = 0;
    this.autoRatio = 1.0;
    this.detectedMidi = null;
    this.targetMidi = null;
    this.framesSincePost = 0;
  }

  detectPitchRatio(keyRoot, scaleMode) {
    const N = this.analysisSize;
    const buf = this.orderedBuf;

    // Compute RMS energy
    let energy = 0;
    for (let i = 0; i < N; i += 1) {
      energy += buf[i] * buf[i];
    }
    const rms = Math.sqrt(energy / N);
    if (rms < 0.012) {
      this.detectedMidi = null;
      this.targetMidi = null;
      return 1.0;
    }

    const minLag = Math.max(24, Math.floor(sampleRate / 850));
    const maxLag = Math.min(N - 64, Math.floor(sampleRate / 75));

    // Normalized Square Difference Function (NSDF) with step-2 downsampling for low CPU
    let bestLag = -1;
    let bestNsdf = 0;

    for (let tau = minLag; tau <= maxLag; tau += 1) {
      let acf = 0;
      let m = 0;
      const limit = N - tau;
      for (let i = 0; i < limit; i += 2) {
        const a = buf[i];
        const b = buf[i + tau];
        acf += a * b;
        m += a * a + b * b;
      }
      const nsdf = m > 1e-8 ? (2 * acf) / m : 0;
      if (nsdf > bestNsdf) {
        bestNsdf = nsdf;
        bestLag = tau;
      }
    }

    if (bestLag <= 0 || bestNsdf < 0.72) {
      return 1.0;
    }

    // Refine lag with simple +/-1 parabolic interpolation on full samples
    const evalLag = (tau) => {
      if (tau < 1 || tau >= N - 1) return 0;
      let acf = 0;
      let m = 0;
      const limit = N - tau;
      for (let i = 0; i < limit; i += 1) {
        const a = buf[i];
        const b = buf[i + tau];
        acf += a * b;
        m += a * a + b * b;
      }
      return m > 1e-8 ? (2 * acf) / m : 0;
    };

    const y0 = evalLag(bestLag - 1);
    const y1 = evalLag(bestLag);
    const y2 = evalLag(bestLag + 1);
    const denom = 2 * (y0 - 2 * y1 + y2);
    const shift = Math.abs(denom) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom)) : 0;
    const refinedLag = bestLag + shift;

    const freq = sampleRate / refinedLag;
    const midiFloat = 69 + 12 * Math.log2(freq / 440);
    const snappedMidi = snapMidiToScale(midiFloat, keyRoot, scaleMode);

    this.detectedMidi = Math.round(midiFloat);
    this.targetMidi = snappedMidi;

    const semitoneCorrection = snappedMidi - midiFloat;
    const ratio = Math.pow(2, semitoneCorrection / 12);
    return Math.max(0.75, Math.min(1.33, ratio));
  }

  readInterpolated(ring, readPos) {
    const wrapped = ((readPos % this.ringSize) + this.ringSize) % this.ringSize;
    const idx0 = Math.floor(wrapped);
    const idx1 = (idx0 + 1) & this.ringMask;
    const frac = wrapped - idx0;
    return ring[idx0] * (1 - frac) + ring[idx1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output[1] || output[0];
    const frames = outL.length;

    if (!input || input.length === 0) {
      outL.fill(0);
      if (output[1]) outR.fill(0);
      return true;
    }

    const inL = input[0];
    const inR = input[1] || input[0];

    const pitchSemitones = parameters.pitchSemitones[0];
    const fineCents = parameters.fineCents[0];
    const autoTuneMode = Math.round(parameters.autoTuneMode[0]);
    const keyRoot = Math.round(parameters.keyRoot[0]);
    const retuneSpeed = parameters.retuneSpeed[0];

    const manualRatio = Math.pow(2, (pitchSemitones + fineCents / 100) / 12);
    const isNeutral = autoTuneMode === 0 && Math.abs(pitchSemitones) < 0.01 && Math.abs(fineCents) < 0.5;
    const targetBypass = isNeutral ? 1.0 : 0.0;

    for (let i = 0; i < frames; i += 1) {
      const sL = inL[i];
      const sR = inR[i];
      const mono = 0.5 * (sL + sR);

      this.ringL[this.writeIndex] = sL;
      this.ringR[this.writeIndex] = sR;

      if (autoTuneMode > 0) {
        this.analysisBuf[this.analysisPos] = mono;
        this.analysisPos = (this.analysisPos + 1) % this.analysisSize;
        this.hopCounter += 1;
        if (this.hopCounter >= 512) {
          this.hopCounter = 0;
          const firstLen = this.analysisSize - this.analysisPos;
          this.orderedBuf.set(this.analysisBuf.subarray(this.analysisPos), 0);
          this.orderedBuf.set(this.analysisBuf.subarray(0, this.analysisPos), firstLen);

          const nextAutoRatio = this.detectPitchRatio(keyRoot, autoTuneMode);
          this.autoRatio += (nextAutoRatio - this.autoRatio) * retuneSpeed;
        }
      } else {
        this.autoRatio = 1.0;
        this.detectedMidi = null;
        this.targetMidi = null;
      }

      const effectiveRatio = manualRatio * this.autoRatio;
      const phaseDelta = (1 - effectiveRatio) / this.grainSize;

      const phaseA = this.phase;
      const phaseB = (this.phase + 0.5) % 1.0;

      const delayA = phaseA * this.grainSize + 24;
      const delayB = phaseB * this.grainSize + 24;

      const winA = 0.5 * (1 - Math.cos(2 * Math.PI * phaseA));
      const winB = 0.5 * (1 - Math.cos(2 * Math.PI * phaseB));

      const readPosA = this.writeIndex - delayA;
      const readPosB = this.writeIndex - delayB;

      const wetL =
        this.readInterpolated(this.ringL, readPosA) * winA +
        this.readInterpolated(this.ringL, readPosB) * winB;
      const wetR =
        this.readInterpolated(this.ringR, readPosA) * winA +
        this.readInterpolated(this.ringR, readPosB) * winB;

      this.bypassMix += (targetBypass - this.bypassMix) * 0.04;
      const wetMix = 1 - this.bypassMix;

      outL[i] = sL * this.bypassMix + wetL * wetMix;
      if (output[1]) {
        outR[i] = sR * this.bypassMix + wetR * wetMix;
      }

      this.phase += phaseDelta;
      if (this.phase >= 1.0) this.phase -= 1.0;
      if (this.phase < 0.0) this.phase += 1.0;

      this.writeIndex = (this.writeIndex + 1) & this.ringMask;
    }

    this.framesSincePost += frames;
    if (autoTuneMode > 0 && this.framesSincePost >= sampleRate / 12) {
      this.framesSincePost = 0;
      this.port.postMessage({
        detectedMidi: this.detectedMidi,
        targetMidi: this.targetMidi
      });
    }

    return true;
  }
}

registerProcessor('vocal-tuner-processor', VocalTunerProcessor);
