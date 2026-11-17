window.VocalDSP = (() => {
  'use strict';

  /**
   * In-place iterative radix-2 Cooley-Tukey FFT.
   * @param {Float32Array} re
   * @param {Float32Array} im
   * @param {boolean} inverse
   */
  function fft(re, im, inverse = false) {
    const n = re.length;
    let j = 0;

    for (let i = 1; i < n; i += 1) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        const ti = im[i];
        re[i] = re[j];
        im[i] = im[j];
        re[j] = tr;
        im[j] = ti;
      }
    }

    const dir = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = (dir * 2 * Math.PI) / len;
      const wStepRe = Math.cos(angle);
      const wStepIm = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let k = 0; k < half; k += 1) {
          const evenIdx = i + k;
          const oddIdx = evenIdx + half;
          const oddRe = re[oddIdx] * wRe - im[oddIdx] * wIm;
          const oddIm = re[oddIdx] * wIm + im[oddIdx] * wRe;

          re[oddIdx] = re[evenIdx] - oddRe;
          im[oddIdx] = im[evenIdx] - oddIm;
          re[evenIdx] += oddRe;
          im[evenIdx] += oddIm;

          const nextWRe = wRe * wStepRe - wIm * wStepIm;
          wIm = wRe * wStepIm + wIm * wStepRe;
          wRe = nextWRe;
        }
      }
    }

    if (inverse) {
      const invN = 1 / n;
      for (let i = 0; i < n; i += 1) {
        re[i] *= invN;
        im[i] *= invN;
      }
    }
  }

  function vocalBandWeight(freq) {
    if (freq < 95) return 0.03;
    if (freq < 220) {
      return 0.03 + 0.97 * ((freq - 95) / 125);
    }
    if (freq <= 5200) return 1.0;
    if (freq < 7800) {
      return Math.max(0.08, 1.0 - 0.92 * ((freq - 5200) / 2600));
    }
    return 0.08;
  }

  function normalizeStereoPeak(left, right, targetPeak = 0.89) {
    let peak = 0;
    for (let i = 0; i < left.length; i += 1) {
      const a = Math.abs(left[i]);
      const b = right ? Math.abs(right[i]) : 0;
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    if (peak > 1e-6) {
      const gain = targetPeak / peak;
      for (let i = 0; i < left.length; i += 1) {
        left[i] *= gain;
        if (right) right[i] *= gain;
      }
    }
  }

  function hasTrueStereoDifference(inputBuffer) {
    if (inputBuffer.numberOfChannels < 2) return false;
    const length = inputBuffer.length;
    const ch0 = inputBuffer.getChannelData(0);
    const ch1 = inputBuffer.getChannelData(1);
    const step = Math.max(1, Math.floor(length / 4096));
    let diffSum = 0;
    for (let i = 0; i < length; i += step) {
      diffSum += Math.abs(ch0[i] - ch1[i]);
    }
    return diffSum > 0.01;
  }

  async function renderMonoVocalFallback(inputBuffer) {
    const offline = new OfflineAudioContext(2, inputBuffer.length, inputBuffer.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = inputBuffer;

    const hpf = offline.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 170;
    hpf.Q.value = 0.8;

    const lpf = offline.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 5200;
    lpf.Q.value = 0.8;

    const presence = offline.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 1.1;
    presence.gain.value = 4.0;

    src.connect(hpf);
    hpf.connect(lpf);
    lpf.connect(presence);
    presence.connect(offline.destination);

    src.start(0);
    const rendered = await offline.startRendering();
    normalizeStereoPeak(rendered.getChannelData(0), rendered.getChannelData(1));
    return rendered;
  }

  async function renderMonoMusicFallback(inputBuffer) {
    const offline = new OfflineAudioContext(2, inputBuffer.length, inputBuffer.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = inputBuffer;

    const vocalDip = offline.createBiquadFilter();
    vocalDip.type = 'peaking';
    vocalDip.frequency.value = 1500;
    vocalDip.Q.value = 0.65;
    vocalDip.gain.value = -14.0;

    const airDip = offline.createBiquadFilter();
    airDip.type = 'peaking';
    airDip.frequency.value = 3200;
    airDip.Q.value = 0.9;
    airDip.gain.value = -8.0;

    src.connect(vocalDip);
    vocalDip.connect(airDip);
    airDip.connect(offline.destination);

    src.start(0);
    const rendered = await offline.startRendering();
    normalizeStereoPeak(rendered.getChannelData(0), rendered.getChannelData(1));
    return rendered;
  }

  /**
   * Non-blocking chunked STFT stem extractor.
   * Produces voice-only, music-only (karaoke/instrumental), or both in a single pass.
   */
  async function processStemsSTFT(audioCtx, inputBuffer, { wantVoice = true, wantMusic = false, onProgress = null } = {}) {
    const sampleRate = inputBuffer.sampleRate;
    const length = inputBuffer.length;
    const trueStereo = hasTrueStereoDifference(inputBuffer);

    if (!trueStereo) {
      if (onProgress) onProgress(30);
      const voiceBuffer = wantVoice ? await renderMonoVocalFallback(inputBuffer) : null;
      if (onProgress) onProgress(70);
      const musicBuffer = wantMusic ? await renderMonoMusicFallback(inputBuffer) : null;
      if (onProgress) onProgress(100);
      return { voiceBuffer, musicBuffer };
    }

    const chL = inputBuffer.getChannelData(0);
    const chR = inputBuffer.getChannelData(1);

    const N = 2048;
    const hop = 512;
    const halfN = N >> 1;

    const win = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    const bandWeights = new Float32Array(halfN + 1);
    for (let k = 0; k <= halfN; k += 1) {
      const freq = (k * sampleRate) / N;
      bandWeights[k] = vocalBandWeight(freq);
    }

    const outVoice = wantVoice ? new Float32Array(length) : null;
    const outMusicL = wantMusic ? new Float32Array(length) : null;
    const outMusicR = wantMusic ? new Float32Array(length) : null;
    const normAcc = new Float32Array(length);

    const lRe = new Float32Array(N);
    const lIm = new Float32Array(N);
    const rRe = new Float32Array(N);
    const rIm = new Float32Array(N);
    const vRe = new Float32Array(N);
    const vIm = new Float32Array(N);
    const mLRe = wantMusic ? new Float32Array(N) : null;
    const mLIm = wantMusic ? new Float32Array(N) : null;
    const mRRe = wantMusic ? new Float32Array(N) : null;
    const mRIm = wantMusic ? new Float32Array(N) : null;

    const totalFrames = Math.ceil(length / hop);
    let frameIndex = 0;
    let lastReportedPct = -1;

    for (let start = 0; start < length; start += hop) {
      lRe.fill(0);
      lIm.fill(0);
      rRe.fill(0);
      rIm.fill(0);

      const copyLen = Math.min(N, length - start);
      for (let i = 0; i < copyLen; i += 1) {
        const w = win[i];
        lRe[i] = chL[start + i] * w;
        rRe[i] = chR[start + i] * w;
      }

      fft(lRe, lIm, false);
      fft(rRe, rIm, false);

      for (let k = 0; k <= halfN; k += 1) {
        const lr = lRe[k];
        const li = lIm[k];
        const rr = rRe[k];
        const ri = rIm[k];

        const magL2 = lr * lr + li * li;
        const magR2 = rr * rr + ri * ri;
        const denom = magL2 + magR2 + 1e-10;

        const crossRe = lr * rr + li * ri;
        const crossIm = li * rr - lr * ri;
        const crossMag = Math.hypot(crossRe, crossIm);

        const similarity = (2 * crossMag) / denom;
        const phaseAlign = crossMag > 1e-10 ? Math.max(0, crossRe / crossMag) : 0;
        const mask = Math.pow(similarity * phaseAlign, 2.1) * bandWeights[k];

        const midRe = 0.5 * (lr + rr) * mask;
        const midIm = 0.5 * (li + ri) * mask;

        if (wantVoice) {
          vRe[k] = midRe;
          vIm[k] = midIm;
          if (k > 0 && k < halfN) {
            vRe[N - k] = midRe;
            vIm[N - k] = -midIm;
          }
        }

        if (wantMusic) {
          // Subtract center vocal estimate from both L and R to preserve stereo music
          const mlr = lr - midRe;
          const mli = li - midIm;
          const mrr = rr - midRe;
          const mri = ri - midIm;

          mLRe[k] = mlr;
          mLIm[k] = mli;
          mRRe[k] = mrr;
          mRIm[k] = mri;
          if (k > 0 && k < halfN) {
            mLRe[N - k] = mlr;
            mLIm[N - k] = -mli;
            mRRe[N - k] = mrr;
            mRIm[N - k] = -mri;
          }
        }
      }

      if (wantVoice) {
        fft(vRe, vIm, true);
      }
      if (wantMusic) {
        fft(mLRe, mLIm, true);
        fft(mRRe, mRIm, true);
      }

      for (let i = 0; i < copyLen; i += 1) {
        const w = win[i];
        if (wantVoice) {
          outVoice[start + i] += vRe[i] * w;
        }
        if (wantMusic) {
          outMusicL[start + i] += mLRe[i] * w;
          outMusicR[start + i] += mRRe[i] * w;
        }
        normAcc[start + i] += w * w;
      }

      frameIndex += 1;
      if (frameIndex % 160 === 0) {
        const pct = Math.min(99, Math.round((frameIndex / totalFrames) * 100));
        if (onProgress && pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress(pct);
        }
        // Yield to keep browser UI responsive on long tracks
        if (typeof window !== 'undefined' && typeof setTimeout === 'function') {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    for (let i = 0; i < length; i += 1) {
      const norm = normAcc[i];
      if (norm > 1e-6) {
        if (wantVoice) outVoice[i] /= norm;
        if (wantMusic) {
          outMusicL[i] /= norm;
          outMusicR[i] /= norm;
        }
      }
    }

    let voiceBuffer = null;
    if (wantVoice) {
      voiceBuffer = audioCtx.createBuffer(2, length, sampleRate);
      const vl = voiceBuffer.getChannelData(0);
      const vr = voiceBuffer.getChannelData(1);
      vl.set(outVoice);
      vr.set(outVoice);
      normalizeStereoPeak(vl, vr, 0.89);
    }

    let musicBuffer = null;
    if (wantMusic) {
      musicBuffer = audioCtx.createBuffer(2, length, sampleRate);
      const ml = musicBuffer.getChannelData(0);
      const mr = musicBuffer.getChannelData(1);
      ml.set(outMusicL);
      mr.set(outMusicR);
      normalizeStereoPeak(ml, mr, 0.89);
    }

    if (onProgress) onProgress(100);
    return { voiceBuffer, musicBuffer };
  }

  async function extractVocalsFromBuffer(audioCtx, inputBuffer, onProgress = null) {
    const { voiceBuffer } = await processStemsSTFT(audioCtx, inputBuffer, {
      wantVoice: true,
      wantMusic: false,
      onProgress
    });
    return voiceBuffer;
  }

  async function extractMusicOnlyFromBuffer(audioCtx, inputBuffer, onProgress = null) {
    const { musicBuffer } = await processStemsSTFT(audioCtx, inputBuffer, {
      wantVoice: false,
      wantMusic: true,
      onProgress
    });
    return musicBuffer;
  }

  async function splitStemsFromBuffer(audioCtx, inputBuffer, onProgress = null) {
    return processStemsSTFT(audioCtx, inputBuffer, {
      wantVoice: true,
      wantMusic: true,
      onProgress
    });
  }

  /**
   * Trim leading/trailing silence and collapse long internal silent pauses (> 320ms)
   * with smooth crossfades so vocals/samples stay tight without clicks.
   */
  function trimSilenceFromBuffer(audioCtx, inputBuffer, options = {}) {
    const sampleRate = inputBuffer.sampleRate;
    const length = inputBuffer.length;
    const numChannels = inputBuffer.numberOfChannels;

    const thresholdDb = options.thresholdDb ?? -38;
    const thresholdLin = Math.pow(10, thresholdDb / 20);
    const frameSamples = Math.max(1, Math.floor(sampleRate * 0.01));
    const minPauseSamples = Math.floor(sampleRate * 0.32);
    const keepGapSamples = Math.floor(sampleRate * 0.09);
    const padStartSamples = Math.floor(sampleRate * 0.015);
    const padEndSamples = Math.floor(sampleRate * 0.03);
    const fadeSamples = Math.floor(sampleRate * 0.012);

    const channels = [];
    for (let c = 0; c < numChannels; c += 1) {
      channels.push(inputBuffer.getChannelData(c));
    }

    const numFrames = Math.ceil(length / frameSamples);
    const activeFrames = new Uint8Array(numFrames);

    for (let f = 0; f < numFrames; f += 1) {
      const start = f * frameSamples;
      const end = Math.min(length, start + frameSamples);
      let sumSq = 0;
      for (let i = start; i < end; i += 1) {
        let mono = 0;
        for (let c = 0; c < numChannels; c += 1) {
          mono += channels[c][i];
        }
        mono /= numChannels;
        sumSq += mono * mono;
      }
      const rms = Math.sqrt(sumSq / (end - start));
      activeFrames[f] = rms >= thresholdLin ? 1 : 0;
    }

    let firstActiveFrame = -1;
    let lastActiveFrame = -1;
    for (let f = 0; f < numFrames; f += 1) {
      if (activeFrames[f]) {
        if (firstActiveFrame === -1) firstActiveFrame = f;
        lastActiveFrame = f;
      }
    }

    if (firstActiveFrame === -1) {
      return { buffer: inputBuffer, removedSeconds: 0, wasAllSilent: true };
    }

    const globalStart = Math.max(0, firstActiveFrame * frameSamples - padStartSamples);
    const globalEnd = Math.min(length, (lastActiveFrame + 1) * frameSamples + padEndSamples);

    const segments = [];
    let segStart = globalStart;
    let f = firstActiveFrame;

    while (f <= lastActiveFrame) {
      if (!activeFrames[f]) {
        const silentStartFrame = f;
        while (f <= lastActiveFrame && !activeFrames[f]) {
          f += 1;
        }
        const silentStartSample = silentStartFrame * frameSamples;
        const silentEndSample = f * frameSamples;
        const silentLen = silentEndSample - silentStartSample;

        if (silentLen > minPauseSamples) {
          const halfKeep = Math.floor(keepGapSamples / 2);
          const cutOutAt = Math.min(globalEnd, silentStartSample + halfKeep);
          const resumeAt = Math.max(cutOutAt, silentEndSample - halfKeep);
          if (cutOutAt > segStart) {
            segments.push({ start: segStart, end: cutOutAt });
          }
          segStart = resumeAt;
        }
      } else {
        f += 1;
      }
    }

    if (globalEnd > segStart) {
      segments.push({ start: segStart, end: globalEnd });
    }

    let totalSamples = 0;
    for (let s = 0; s < segments.length; s += 1) {
      totalSamples += segments[s].end - segments[s].start;
    }

    if (totalSamples <= 0 || totalSamples >= length - Math.floor(sampleRate * 0.02)) {
      return { buffer: inputBuffer, removedSeconds: 0, wasAllSilent: false };
    }

    const outBuffer = audioCtx.createBuffer(numChannels, totalSamples, sampleRate);
    let writePtr = 0;

    for (let s = 0; s < segments.length; s += 1) {
      const seg = segments[s];
      const segLen = seg.end - seg.start;
      const actualFade = Math.min(fadeSamples, Math.floor(segLen / 4));

      for (let c = 0; c < numChannels; c += 1) {
        const src = channels[c];
        const dst = outBuffer.getChannelData(c);

        for (let i = 0; i < segLen; i += 1) {
          let sample = src[seg.start + i];
          if (i < actualFade) {
            sample *= i / actualFade;
          } else if (i >= segLen - actualFade) {
            sample *= (segLen - 1 - i) / actualFade;
          }
          dst[writePtr + i] = sample;
        }
      }
      writePtr += segLen;
    }

    const removedSeconds = Math.max(0, (length - totalSamples) / sampleRate);
    return { buffer: outBuffer, removedSeconds, wasAllSilent: false };
  }

  /**
   * Snap sample index to nearest zero-crossing on channel 0 within ±windowSamples to avoid clicks.
   */
  function findNearestZeroCrossing(channelData, targetIdx, windowSamples) {
    const lo = Math.max(1, targetIdx - windowSamples);
    const hi = Math.min(channelData.length - 2, targetIdx + windowSamples);
    let bestIdx = targetIdx;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i += 1) {
      const a = channelData[i - 1];
      const b = channelData[i];
      if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) {
        const dist = Math.abs(i - targetIdx);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }

  /**
   * Surgical slice [startSec, endSec] with zero-crossing snap and raised-cosine edge fades.
   */
  function sliceAudioBuffer(audioCtx, inputBuffer, startSec, endSec) {
    const sr = inputBuffer.sampleRate;
    const totalDur = inputBuffer.duration;
    const safeStart = Math.max(0, Math.min(totalDur - 0.05, Number(startSec) || 0));
    const safeEnd = Math.max(safeStart + 0.05, Math.min(totalDur, Number(endSec) || totalDur));

    let startSample = Math.floor(safeStart * sr);
    let endSample = Math.min(inputBuffer.length, Math.floor(safeEnd * sr));

    if (startSample === 0 && endSample === inputBuffer.length) {
      return inputBuffer;
    }

    const ch0 = inputBuffer.getChannelData(0);
    const snapWin = Math.floor(sr * 0.008); // ±8ms surgical zero-crossing window
    if (startSample > 0) {
      startSample = findNearestZeroCrossing(ch0, startSample, snapWin);
    }
    if (endSample < inputBuffer.length) {
      endSample = Math.max(startSample + Math.floor(sr * 0.05), findNearestZeroCrossing(ch0, endSample, snapWin));
    }

    const outLen = Math.max(1, endSample - startSample);
    const outBuffer = audioCtx.createBuffer(inputBuffer.numberOfChannels, outLen, sr);
    const fadeSamples = Math.min(Math.floor(sr * 0.008), Math.floor(outLen / 4));

    for (let c = 0; c < inputBuffer.numberOfChannels; c += 1) {
      const src = inputBuffer.getChannelData(c);
      const dst = outBuffer.getChannelData(c);
      for (let i = 0; i < outLen; i += 1) {
        let s = src[startSample + i];
        if (fadeSamples > 0 && i < fadeSamples) {
          s *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
        } else if (fadeSamples > 0 && i >= outLen - fadeSamples) {
          const tail = outLen - 1 - i;
          s *= 0.5 * (1 - Math.cos((Math.PI * tail) / fadeSamples));
        }
        dst[i] = s;
      }
    }

    return outBuffer;
  }

  function computeEnergyProfile(inputBuffer, binSeconds = 1) {
    const sr = inputBuffer.sampleRate;
    const binSamples = Math.max(1, Math.floor(sr * binSeconds));
    const ch0 = inputBuffer.getChannelData(0);
    const profile = [];

    for (let start = 0; start < ch0.length; start += binSamples) {
      const end = Math.min(ch0.length, start + binSamples);
      let sumSq = 0;
      const step = Math.max(1, Math.floor((end - start) / 200));
      let count = 0;
      for (let i = start; i < end; i += step) {
        sumSq += ch0[i] * ch0[i];
        count += 1;
      }
      const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
      profile.push(Math.min(100, Math.round(rms * 250)));
    }
    return profile;
  }

  function encodeCompactWavBase64(inputBuffer, maxSeconds = 90, targetRate = 8000) {
    const srcRate = inputBuffer.sampleRate;
    const numCh = inputBuffer.numberOfChannels;
    const maxSrcSamples = Math.min(inputBuffer.length, Math.floor(maxSeconds * srcRate));
    const outSamples = Math.max(1, Math.floor((maxSrcSamples * targetRate) / srcRate));
    const ratio = srcRate / targetRate;

    const dataBytes = outSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    const ch0 = inputBuffer.getChannelData(0);
    const ch1 = numCh > 1 ? inputBuffer.getChannelData(1) : null;

    let offset = 44;
    for (let i = 0; i < outSamples; i += 1) {
      const srcIdx = Math.min(maxSrcSamples - 1, Math.floor(i * ratio));
      const mono = ch1 ? 0.5 * (ch0[srcIdx] + ch1[srcIdx]) : ch0[srcIdx];
      const clamped = Math.max(-1, Math.min(1, mono));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  /**
   * Encode full-fidelity AudioBuffer as a 16-bit PCM WAV ArrayBuffer for persistent library saving.
   */
  function encodeWavArrayBuffer(inputBuffer) {
    const numCh = Math.min(2, inputBuffer.numberOfChannels);
    const sampleRate = inputBuffer.sampleRate;
    const length = inputBuffer.length;
    const blockAlign = numCh * 2;
    const dataBytes = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    const ch0 = inputBuffer.getChannelData(0);
    const ch1 = numCh > 1 ? inputBuffer.getChannelData(1) : null;
    let offset = 44;

    for (let i = 0; i < length; i += 1) {
      const s0 = Math.max(-1, Math.min(1, ch0[i]));
      view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
      offset += 2;
      if (ch1) {
        const s1 = Math.max(-1, Math.min(1, ch1[i]));
        view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
        offset += 2;
      }
    }

    return buffer;
  }

  return {
    extractVocalsFromBuffer,
    extractMusicOnlyFromBuffer,
    splitStemsFromBuffer,
    trimSilenceFromBuffer,
    sliceAudioBuffer,
    computeEnergyProfile,
    encodeCompactWavBase64,
    encodeWavArrayBuffer
  };
})();
