(() => {
  'use strict';

  const TRACK_COUNT = 4;
  const LOFI_CUTOFF_HZ = 2000;
  const LOFI_Q = 1.1;
  const NOTE_LABELS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Shared Web Audio Engine State
  let audioCtx = null;
  let workletReady = false;
  let masterGain = null;
  let masterAnalyser = null;
  let impulseResponseBuffer = null;
  let freqData = null;
  let timeData = null;
  let peakCaps = [];

  // Sample Generator Preview State
  let selectedPreset = 'rhodes';
  let previewSource = null;
  let remixTimers = [];

  const tracks = [];

  // DOM Elements
  const extractForm = document.getElementById('extract-form');
  const youtubeUrlInput = document.getElementById('youtube-url');
  const extractBtn = document.getElementById('extract-btn');
  const statusStrip = document.getElementById('status-strip');
  const statusText = document.getElementById('status-text');
  const audioCtxStatus = document.getElementById('audio-ctx-status');
  const masterVolumeSlider = document.getElementById('master-volume');
  const masterVolVal = document.getElementById('master-vol-val');
  const masterPlayAllBtn = document.getElementById('master-play-all');
  const masterStopAllBtn = document.getElementById('master-stop-all');
  const masterBounceBtn = document.getElementById('master-bounce-btn');
  const visualizerCanvas = document.getElementById('master-visualizer');
  const peakReadout = document.getElementById('peak-readout');
  const tracksGrid = document.getElementById('tracks-grid');

  // Generator DOM Elements
  const genPresetButtons = document.querySelectorAll('#gen-presets .preset-pill');
  const genKeySelect = document.getElementById('gen-key');
  const genScaleSelect = document.getElementById('gen-scale');
  const genBpmInput = document.getElementById('gen-bpm');
  const genBarsSelect = document.getElementById('gen-bars');
  const genTargetSelect = document.getElementById('gen-target-track');
  const genPreviewBtn = document.getElementById('gen-preview-btn');
  const genLoadBtn = document.getElementById('gen-load-btn');
  const ytSampleForm = document.getElementById('yt-sample-form');
  const ytSampleDropzone = document.getElementById('yt-sample-dropzone');
  const ytSampleUrlInput = document.getElementById('yt-sample-url');
  const ytSampleModeSelect = document.getElementById('yt-sample-mode');
  const ytSampleStyleModeSelect = document.getElementById('yt-sample-style-mode');
  const ytSampleBtn = document.getElementById('yt-sample-btn');

  // Component Mix Studio & Variations DOM Elements
  const studioDnaBadge = document.getElementById('studio-dna-badge');
  const studioAnalyzeBtn = document.getElementById('studio-analyze-btn');
  const studioGenBeatBtn = document.getElementById('studio-gen-beat-btn');
  const studioAiVarsBtn = document.getElementById('studio-ai-vars-btn');
  const studioLeadSelect = document.getElementById('studio-lead-select');
  const studioChorusSelect = document.getElementById('studio-chorus-select');
  const studioRefSelect = document.getElementById('studio-ref-select');
  const studioLeadPitchSelect = document.getElementById('studio-lead-pitch');
  const mixVariationsGrid = document.getElementById('mix-variations-grid');

  // Gemini Remix Director DOM Elements
  const remixInputsRow = document.querySelector('.remix-inputs-row');
  const geminiKeyBadge = document.getElementById('gemini-key-badge');
  const geminiKeyWrap = document.getElementById('gemini-key-wrap');
  const geminiApiKeyInput = document.getElementById('gemini-api-key');
  const remixGlobalPromptInput = document.getElementById('remix-global-prompt');
  const geminiSendAudioCheckbox = document.getElementById('gemini-send-audio');
  const remixBuildBtn = document.getElementById('remix-build-btn');
  const remixPlayBtn = document.getElementById('remix-play-btn');
  const remixRevertBtn = document.getElementById('remix-revert-btn');
  const remixSummaryBar = document.getElementById('remix-summary-bar');
  const remixSummaryText = document.getElementById('remix-summary-text');

  // Local Project Library DOM Elements & State
  const libraryCountBadge = document.getElementById('library-count-badge');
  const libraryBody = document.getElementById('library-body');
  const libraryEmpty = document.getElementById('library-empty');
  const libraryListEl = document.getElementById('library-list');
  const libraryFilterBtns = document.querySelectorAll('.lib-filter-btn');
  const libraryTargetSelect = document.getElementById('library-target-track');
  const libraryRefreshBtn = document.getElementById('library-refresh-btn');
  const libraryToggleBtn = document.getElementById('library-toggle-btn');

  let libraryItems = [];
  let libraryFilter = 'all';
  let libraryPreviewAudio = null;
  let libraryPreviewId = null;
  let neuralEngineReady = false;
  let neuralMultiStemReady = false;
  let neuralModelLabel = 'BS-RoFormer';
  let currentStyleProfile = null;
  let currentStyleRefTitle = '';
  let aiMixVariations = [];
  let activeVariationKey = '';

  function setStatus(message, type = 'info') {
    statusStrip.className = `status-strip ${type}`;
    statusText.textContent = message;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatTimeTenths(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0';
    const rounded = Math.round(seconds * 10) / 10;
    const mins = Math.floor(rounded / 60);
    const rem = rounded - mins * 60;
    const secsWhole = Math.floor(rem);
    const tenths = Math.min(9, Math.max(0, Math.round((rem - secsWhole) * 10)));
    return `${String(mins).padStart(2, '0')}:${String(secsWhole).padStart(2, '0')}.${tenths}`;
  }

  function parseTimeInput(raw) {
    const str = String(raw || '').trim();
    if (!str) return null;
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length !== 2) return null;
      const mins = Number(parts[0]);
      const secs = Number(parts[1]);
      if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0) return null;
      return mins * 60 + secs;
    }
    const secs = Number(str);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }

  function midiToNoteLabel(midi) {
    if (!Number.isFinite(midi)) return '--';
    const name = NOTE_LABELS[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
  }

  /**
   * Generate a warm stereo lo-fi room/spring impulse response for ConvolverNode.
   */
  function createImpulseResponse(ctx, durationSec = 2.1, decay = 2.8) {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const impulse = ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch += 1) {
      const channelData = impulse.getChannelData(ch);
      let lpState = 0;
      const preDelaySamples = Math.floor(sampleRate * 0.015);

      for (let i = 0; i < length; i += 1) {
        if (i < preDelaySamples) {
          channelData[i] = 0;
          continue;
        }
        const t = (i - preDelaySamples) / (length - preDelaySamples);
        const envelope = Math.pow(1 - t, decay);
        const white = Math.random() * 2 - 1;
        lpState = lpState + 0.22 * (white - lpState);
        channelData[i] = lpState * envelope;
      }
    }

    return impulse;
  }

  async function ensureAudioEngine() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();

      masterGain = audioCtx.createGain();
      masterGain.gain.value = parseFloat(masterVolumeSlider.value);

      masterAnalyser = audioCtx.createAnalyser();
      masterAnalyser.fftSize = 256;
      masterAnalyser.smoothingTimeConstant = 0.82;

      freqData = new Uint8Array(masterAnalyser.frequencyBinCount);
      timeData = new Uint8Array(masterAnalyser.fftSize);
      peakCaps = new Array(64).fill(0);

      masterGain.connect(masterAnalyser);
      masterAnalyser.connect(audioCtx.destination);

      impulseResponseBuffer = createImpulseResponse(audioCtx);

      if (audioCtx.audioWorklet) {
        try {
          await audioCtx.audioWorklet.addModule('pitch-worklet.js');
          workletReady = true;
        } catch (err) {
          console.warn('AudioWorklet failed to load; pitch tuner will use fallback:', err);
          workletReady = false;
        }
      }

      tracks.forEach((track) => initTrackAudioNodes(track));
    }

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    audioCtxStatus.textContent = `AUDIO ENGINE: ${audioCtx.sampleRate} Hz`;
    audioCtxStatus.classList.add('active');
  }

  function initTrackAudioNodes(track) {
    if (!audioCtx || track.nodes) return;

    const inputNode = audioCtx.createGain();

    // 1. Voice Tuner Stage (AudioWorkletNode for speed-independent Pitch & Auto-Tune)
    let tunerNode = null;
    if (workletReady) {
      try {
        tunerNode = new AudioWorkletNode(audioCtx, 'vocal-tuner-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
        tunerNode.parameters.get('pitchSemitones').value = track.pitchSemitones;
        tunerNode.parameters.get('fineCents').value = track.fineCents;
        tunerNode.parameters.get('autoTuneMode').value = track.autoTuneMode;
        tunerNode.parameters.get('keyRoot').value = track.tunerKey;

        tunerNode.port.onmessage = (event) => {
          const { detectedMidi, targetMidi } = event.data || {};
          if (track.autoTuneMode === 0) {
            track.ui.tunerNotePill.textContent = 'NOTE: --';
            return;
          }
          if (detectedMidi != null && targetMidi != null) {
            const detLabel = midiToNoteLabel(detectedMidi);
            const tgtLabel = midiToNoteLabel(targetMidi);
            track.ui.tunerNotePill.textContent = detLabel === tgtLabel ? `NOTE: ${tgtLabel}` : `${detLabel} → ${tgtLabel}`;
          } else {
            track.ui.tunerNotePill.textContent = 'NOTE: --';
          }
        };
      } catch (err) {
        console.warn('Could not instantiate vocal-tuner-processor:', err);
        tunerNode = null;
      }
    }

    // 2. Vocal Presence / Tone EQ (2.8 kHz peaking EQ)
    const vocalToneEq = audioCtx.createBiquadFilter();
    vocalToneEq.type = 'peaking';
    vocalToneEq.frequency.value = 2800;
    vocalToneEq.Q.value = 0.9;
    vocalToneEq.gain.value = track.vocalToneDb;

    // 3. Stereo Vocal Doubler (modulated 16ms delay mixed in parallel)
    const doublerSum = audioCtx.createGain();
    const doublerDelay = audioCtx.createDelay(0.1);
    doublerDelay.delayTime.value = 0.016;
    const doublerLfo = audioCtx.createOscillator();
    doublerLfo.type = 'sine';
    doublerLfo.frequency.value = 1.6;
    const doublerLfoDepth = audioCtx.createGain();
    doublerLfoDepth.gain.value = 0.0028;
    doublerLfo.connect(doublerLfoDepth);
    doublerLfoDepth.connect(doublerDelay.delayTime);
    doublerLfo.start();

    const doublerWetGain = audioCtx.createGain();
    doublerWetGain.gain.value = track.doublerEnabled ? 0.45 : 0;

    // 4. Lo-Fi Low-Pass Filter (2000Hz) with click-free dry/wet bypass
    const postFilterNode = audioCtx.createGain();
    const lofiFilter = audioCtx.createBiquadFilter();
    lofiFilter.type = 'lowpass';
    lofiFilter.frequency.value = LOFI_CUTOFF_HZ;
    lofiFilter.Q.value = LOFI_Q;

    const filterDryGain = audioCtx.createGain();
    const filterWetGain = audioCtx.createGain();
    filterDryGain.gain.value = track.lofiEnabled ? 0 : 1;
    filterWetGain.gain.value = track.lofiEnabled ? 1 : 0;

    // 5. Custom ConvolverNode Reverb with equal-power wet/dry mix
    const convolver = audioCtx.createConvolver();
    convolver.buffer = impulseResponseBuffer;

    const reverbDryGain = audioCtx.createGain();
    const reverbWetGain = audioCtx.createGain();

    const mix = track.reverbMix;
    reverbDryGain.gain.value = Math.cos(mix * Math.PI * 0.5);
    reverbWetGain.gain.value = Math.sin(mix * Math.PI * 0.5);

    const trackGain = audioCtx.createGain();
    trackGain.gain.value = track.volume;

    // Connect Graph
    if (tunerNode) {
      inputNode.connect(tunerNode);
      tunerNode.connect(vocalToneEq);
    } else {
      inputNode.connect(vocalToneEq);
    }

    vocalToneEq.connect(doublerSum);
    vocalToneEq.connect(doublerDelay);
    doublerDelay.connect(doublerWetGain);
    doublerWetGain.connect(doublerSum);

    doublerSum.connect(filterDryGain);
    filterDryGain.connect(postFilterNode);

    doublerSum.connect(lofiFilter);
    lofiFilter.connect(filterWetGain);
    filterWetGain.connect(postFilterNode);

    postFilterNode.connect(reverbDryGain);
    reverbDryGain.connect(trackGain);

    postFilterNode.connect(convolver);
    convolver.connect(reverbWetGain);
    reverbWetGain.connect(trackGain);

    trackGain.connect(masterGain);

    track.nodes = {
      inputNode,
      tunerNode,
      vocalToneEq,
      doublerWetGain,
      lofiFilter,
      filterDryGain,
      filterWetGain,
      postFilterNode,
      convolver,
      reverbDryGain,
      reverbWetGain,
      trackGain
    };
  }

  function updateTrackTuner(track) {
    if (!audioCtx || !track.nodes) return;
    const now = audioCtx.currentTime;
    const { tunerNode, vocalToneEq, doublerWetGain } = track.nodes;

    if (tunerNode) {
      tunerNode.parameters.get('pitchSemitones').setValueAtTime(track.pitchSemitones, now);
      tunerNode.parameters.get('fineCents').setValueAtTime(track.fineCents, now);
      tunerNode.parameters.get('autoTuneMode').setValueAtTime(track.autoTuneMode, now);
      tunerNode.parameters.get('keyRoot').setValueAtTime(track.tunerKey, now);
    } else if (track.sourceNode) {
      // Fallback if AudioWorklet unavailable
      const totalSt = track.pitchSemitones + track.fineCents / 100;
      track.sourceNode.playbackRate.setTargetAtTime(Math.pow(2, totalSt / 12), now, 0.02);
    }

    vocalToneEq.gain.setTargetAtTime(track.vocalToneDb, now, 0.02);
    doublerWetGain.gain.setTargetAtTime(track.doublerEnabled ? 0.45 : 0, now, 0.02);
  }

  function updateTrackFilter(track) {
    if (!audioCtx || !track.nodes) return;
    const now = audioCtx.currentTime;
    const dry = track.lofiEnabled ? 0 : 1;
    const wet = track.lofiEnabled ? 1 : 0;
    track.nodes.filterDryGain.gain.setTargetAtTime(dry, now, 0.015);
    track.nodes.filterWetGain.gain.setTargetAtTime(wet, now, 0.015);
  }

  function updateTrackReverb(track) {
    if (!audioCtx || !track.nodes) return;
    const now = audioCtx.currentTime;
    const dry = Math.cos(track.reverbMix * Math.PI * 0.5);
    const wet = Math.sin(track.reverbMix * Math.PI * 0.5);
    track.nodes.reverbDryGain.gain.setTargetAtTime(dry, now, 0.015);
    track.nodes.reverbWetGain.gain.setTargetAtTime(wet, now, 0.015);
  }

  function updateTrackVolume(track) {
    if (!audioCtx || !track.nodes) return;
    track.nodes.trackGain.gain.setTargetAtTime(track.volume, audioCtx.currentTime, 0.015);
  }

  function stopSourceNode(track) {
    if (!track.sourceNode) return;
    const oldSource = track.sourceNode;
    track.sourceNode = null;
    oldSource.onended = null;
    try {
      oldSource.stop();
    } catch {
      // Ignore if already stopped
    }
    try {
      oldSource.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  function getRegionBoundsSec(track) {
    if (!track.buffer) {
      return { startSec: 0, endSec: 0, hasSelection: false };
    }
    const dur = track.buffer.duration;
    const startSec = Math.max(0, Math.min(dur, track.regionStartRatio * dur));
    const endSec = Math.max(startSec + 0.05, Math.min(dur, track.regionEndRatio * dur));
    const hasSelection = track.regionStartRatio > 0.001 || track.regionEndRatio < 0.999;
    return { startSec, endSec, hasSelection };
  }

  function getTrackPosition(track) {
    if (!track.buffer) return 0;
    const duration = track.buffer.duration;
    const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
    const useRegion = track.regionLoopEnabled && hasSelection && (endSec - startSec >= 0.05);

    if (track.state === 'playing' && audioCtx) {
      const elapsed = audioCtx.currentTime - track.startedAt;
      if (track.loop && useRegion) {
        if (elapsed < endSec) return Math.max(0, elapsed);
        return startSec + ((elapsed - startSec) % (endSec - startSec));
      }
      if (track.loop && duration > 0) {
        return elapsed % duration;
      }
      if (!track.loop && useRegion) {
        return Math.min(elapsed, endSec);
      }
      return Math.min(elapsed, duration);
    }
    return Math.min(track.offset, duration);
  }

  async function playTrack(track) {
    if (!track.buffer) return;
    await ensureAudioEngine();
    initTrackAudioNodes(track);

    if (track.state === 'playing') return;

    stopSourceNode(track);

    const duration = track.buffer.duration;
    const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
    const useRegion = track.regionLoopEnabled && hasSelection && (endSec - startSec >= 0.05);

    if (useRegion) {
      if (track.offset < startSec || track.offset >= endSec - 0.01) {
        track.offset = startSec;
      }
    } else if (track.offset >= duration) {
      track.offset = 0;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = track.loop;
    if (track.loop && useRegion) {
      source.loopStart = startSec;
      source.loopEnd = endSec;
    }

    if (!track.nodes.tunerNode) {
      const totalSt = track.pitchSemitones + track.fineCents / 100;
      source.playbackRate.value = Math.pow(2, totalSt / 12);
    }
    source.connect(track.nodes.inputNode);

    source.onended = () => {
      if (track.sourceNode !== source) return;
      track.sourceNode = null;
      track.state = 'stopped';
      track.offset = useRegion ? startSec : 0;
      renderTrackUI(track);
      drawTrackWaveform(track);
    };

    track.sourceNode = source;
    track.startedAt = audioCtx.currentTime - track.offset;
    track.state = 'playing';

    if (!track.loop && useRegion) {
      source.start(0, track.offset, Math.max(0.05, endSec - track.offset));
    } else {
      source.start(0, track.offset);
    }
    renderTrackUI(track);
  }

  function pauseTrack(track) {
    if (track.state !== 'playing' || !track.buffer) return;
    track.offset = getTrackPosition(track);
    stopSourceNode(track);
    track.state = 'paused';
    renderTrackUI(track);
  }

  function stopTrack(track) {
    if (!track.buffer) return;
    stopSourceNode(track);
    const { startSec, hasSelection } = getRegionBoundsSec(track);
    track.offset = (track.regionLoopEnabled && hasSelection) ? startSec : 0;
    track.state = 'stopped';
    renderTrackUI(track);
    drawTrackWaveform(track);
  }

  function clearTrack(track) {
    stopSourceNode(track);
    track.buffer = null;
    track.originalBuffer = null;
    track.preStemBuffer = null;
    track.pairedStemCache = null;
    track.waveformPeaks = null;
    track.sourceUrl = '';
    track.stemMode = 'mix';
    track.voiceExtracted = false;
    track.musicExtracted = false;
    track.silenceTrimmed = false;
    track.croppedRegion = false;
    track.regionStartRatio = 0;
    track.regionEndRatio = 1;
    track.regionLoopEnabled = true;
    track.waveZoom = 1;
    track.processProgress = '';
    track.remixIncluded = true;
    track.startDelaySec = 0;
    track.remixReason = '';
    track.title = '';
    track.offset = 0;
    track.state = 'empty';
    renderTrackUI(track);
    drawTrackWaveform(track);
  }

  function computeWaveformPeaks(buffer, bins = 768) {
    if (!buffer) return null;
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / bins));
    const peaks = new Float32Array(bins);
    for (let i = 0; i < bins; i += 1) {
      const start = i * step;
      const end = Math.min(data.length, start + step);
      let max = 0;
      for (let j = start; j < end; j += 1) {
        const val = Math.abs(data[j]);
        if (val > max) max = val;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  function getWaveformViewport(track) {
    const zoom = Math.max(1, track.waveZoom || 1);
    if (!track.buffer || zoom <= 1 || track.buffer.duration <= 0) {
      return { startRatio: 0, endRatio: 1 };
    }
    const span = 1 / zoom;
    const posRatio = getTrackPosition(track) / track.buffer.duration;
    let startRatio = posRatio - span * 0.5;
    if (startRatio < 0) startRatio = 0;
    if (startRatio + span > 1) startRatio = Math.max(0, 1 - span);
    return { startRatio, endRatio: Math.min(1, startRatio + span) };
  }

  function drawTrackWaveform(track) {
    const canvas = track.ui.waveformCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!track.buffer || !track.waveformPeaks) return;

    const peaks = track.waveformPeaks;
    const { startRatio: viewStart, endRatio: viewEnd } = getWaveformViewport(track);
    const viewSpan = Math.max(1e-4, viewEnd - viewStart);
    const startBin = Math.max(0, Math.floor(viewStart * peaks.length));
    const endBin = Math.min(peaks.length, Math.ceil(viewEnd * peaks.length));
    const visibleBins = Math.max(1, endBin - startBin);
    const barW = w / visibleBins;

    const ratioToX = (r) => ((r - viewStart) / viewSpan) * w;
    const posRatio = track.buffer.duration > 0 ? getTrackPosition(track) / track.buffer.duration : 0;
    const playheadX = ratioToX(posRatio);
    const selStartX = ratioToX(track.regionStartRatio);
    const selEndX = ratioToX(track.regionEndRatio);

    for (let b = 0; b < visibleBins; b += 1) {
      const binRatio = (startBin + b + 0.5) / peaks.length;
      const x = b * barW;
      const amp = Math.max(0.06, peaks[startBin + b]);
      const barH = amp * (h - 6);
      const y = (h - barH) / 2;
      const inRegion = binRatio >= track.regionStartRatio && binRatio <= track.regionEndRatio;

      if (track.stemMode === 'voice' || track.stemMode === 'lead') {
        ctx.fillStyle = (x <= playheadX && track.state === 'playing')
          ? '#38bdf8'
          : (inRegion ? 'rgba(56, 189, 248, 0.58)' : 'rgba(56, 189, 248, 0.16)');
      } else if (track.stemMode === 'chorus') {
        ctx.fillStyle = (x <= playheadX && track.state === 'playing')
          ? '#f472b6'
          : (inRegion ? 'rgba(244, 114, 182, 0.58)' : 'rgba(244, 114, 182, 0.16)');
      } else if (track.stemMode === 'music') {
        ctx.fillStyle = (x <= playheadX && track.state === 'playing')
          ? '#a78bfa'
          : (inRegion ? 'rgba(167, 139, 250, 0.58)' : 'rgba(167, 139, 250, 0.16)');
      } else if (track.stemMode === 'beat') {
        ctx.fillStyle = (x <= playheadX && track.state === 'playing')
          ? '#34d399'
          : (inRegion ? 'rgba(16, 185, 129, 0.58)' : 'rgba(16, 185, 129, 0.16)');
      } else {
        ctx.fillStyle = (x <= playheadX && track.state === 'playing')
          ? '#10b981'
          : (inRegion ? 'rgba(245, 158, 11, 0.55)' : 'rgba(245, 158, 11, 0.16)');
      }
      ctx.fillRect(x + 0.5, y, Math.max(1, barW - 0.8), barH);
    }

    // Highlight region boundaries if narrowed
    if (track.regionStartRatio > 0.001 || track.regionEndRatio < 0.999) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      if (selStartX > 0) ctx.fillRect(0, 0, Math.min(w, selStartX), h);
      if (selEndX < w) ctx.fillRect(Math.max(0, selEndX), 0, w - Math.max(0, selEndX), h);

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (selStartX >= 0 && selStartX <= w) {
        ctx.moveTo(selStartX, 0);
        ctx.lineTo(selStartX, h);
      }
      if (selEndX >= 0 && selEndX <= w) {
        ctx.moveTo(selEndX, 0);
        ctx.lineTo(selEndX, h);
      }
      ctx.stroke();
    }

    if ((track.state === 'playing' || track.state === 'paused' || track.offset > 0) && playheadX >= 0 && playheadX <= w) {
      ctx.strokeStyle = '#fef3c7';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.stroke();
    }
  }

  function loadBufferIntoTrack(track, audioBuffer, title, { preserveOriginal = false, sourceUrl = null, libraryId = undefined } = {}) {
    stopSourceNode(track);
    track.buffer = audioBuffer;
    if (sourceUrl !== null) {
      track.sourceUrl = sourceUrl;
    }
    if (libraryId !== undefined) {
      track.libraryId = libraryId || null;
    } else if (!preserveOriginal) {
      track.libraryId = null;
    }
    if (!preserveOriginal) {
      track.originalBuffer = audioBuffer;
      track.originalLibraryId = track.libraryId || null;
      track.preStemBuffer = audioBuffer;
      track.pairedStemCache = null;
      track.stemMode = 'mix';
      track.voiceExtracted = false;
      track.musicExtracted = false;
      track.silenceTrimmed = false;
      track.croppedRegion = false;
      track.waveZoom = 1;
      if (sourceUrl === null) track.sourceUrl = '';
    }
    track.regionStartRatio = 0;
    track.regionEndRatio = 1;
    track.waveformPeaks = computeWaveformPeaks(audioBuffer, 768);
    track.title = title || 'Untitled Audio';
    track.offset = 0;
    track.state = 'stopped';
    renderTrackUI(track);
    drawTrackWaveform(track);
  }

  async function saveBufferToLibrary(audioBuffer, { title, stemType = 'mix', sourceUrl = '', silent = false } = {}) {
    if (!audioBuffer) return null;
    try {
      const wavBuffer = window.VocalDSP.encodeWavArrayBuffer(audioBuffer);
      const res = await fetch('/api/library/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'X-Track-Title': encodeURIComponent(title || 'Saved Track'),
          'X-Stem-Type': stemType,
          'X-Source-Url': encodeURIComponent(sourceUrl || ''),
          'X-Duration-Sec': String(audioBuffer.duration.toFixed(2)),
          'X-Format': 'wav'
        },
        body: wavBuffer
      });
      if (!res.ok) return null;
      const data = await res.json();
      await fetchLibrary({ silent: true });
      if (!silent && data?.item) {
        setStatus(`Saved "${data.item.title}" to Local Project Library (./library).`, 'success');
      }
      return data?.item || null;
    } catch (err) {
      console.warn('Could not save stem to library:', err);
      return null;
    }
  }

  async function seekTrackTo(track, targetSeconds) {
    if (!track.buffer) return;
    const dur = track.buffer.duration;
    const clamped = Math.max(0, Math.min(Math.max(0, dur - 0.01), targetSeconds));
    const wasPlaying = track.state === 'playing';
    stopSourceNode(track);
    track.offset = clamped;
    track.state = wasPlaying ? 'stopped' : track.state;
    if (wasPlaying) {
      await playTrack(track);
    } else {
      renderTrackUI(track);
      drawTrackWaveform(track);
    }
  }

  async function loadLocalFileIntoTrack(track, file) {
    try {
      setStatus(`Decoding "${file.name}" into Track ${track.index + 1}...`, 'info');
      await ensureAudioEngine();
      const arrayBuffer = await file.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      const cleanName = file.name.replace(/\.[^/.]+$/, '');
      loadBufferIntoTrack(track, decoded, cleanName);
      setStatus(`Loaded "${cleanName}" into Track ${track.index + 1}.`, 'success');
    } catch (err) {
      console.error('Local file decode error:', err);
      setStatus(`Could not decode "${file.name}". Please use MP3, WAV, OGG, or M4A.`, 'error');
    }
  }

  function findFirstEmptyTrack() {
    return tracks.find((t) => !t.buffer) || null;
  }

  function getStemSourceBuffer(track) {
    if (!track.preStemBuffer || track.stemMode === 'mix') {
      track.preStemBuffer = track.buffer;
    }
    return track.preStemBuffer;
  }

  function prepareSeparationSource(track) {
    if (!track.originalBuffer) track.originalBuffer = track.buffer;
    const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
    const canUseServerLibrary = Boolean(track.libraryId && !track.silenceTrimmed && !track.croppedRegion);
    const slicedLabel = hasSelection && endSec - startSec >= 0.1
      ? ` [${formatTimeTenths(startSec)}-${formatTimeTenths(endSec)}]`
      : '';
    if (canUseServerLibrary) {
      return {
        sourceBuf: null,
        libraryId: track.libraryId,
        startSec: hasSelection ? startSec : null,
        endSec: hasSelection ? endSec : null,
        durationSec: hasSelection ? (endSec - startSec) : track.buffer.duration,
        slicedLabel
      };
    }
    if (hasSelection && endSec - startSec >= 0.1) {
      const sliced = window.VocalDSP.sliceAudioBuffer(audioCtx, track.buffer, startSec, endSec);
      track.preStemBuffer = sliced;
      track.croppedRegion = true;
      return {
        sourceBuf: sliced,
        libraryId: null,
        startSec: null,
        endSec: null,
        durationSec: sliced.duration,
        slicedLabel
      };
    }
    const baseBuf = getStemSourceBuffer(track);
    return {
      sourceBuf: baseBuf,
      libraryId: null,
      startSec: null,
      endSec: null,
      durationSec: baseBuf.duration,
      slicedLabel: ''
    };
  }

  async function separateStemsWithBestEngine(track, prep, { needVoice, needMusic, baseTitle }) {
    if (!neuralEngineReady) {
      await checkStemEngineStatus();
    }

    const sourceKey = prep.libraryId
      ? `lib_${prep.libraryId}_${(prep.startSec ?? 0).toFixed(2)}_${(prep.endSec ?? prep.durationSec).toFixed(2)}`
      : `${prep.sourceBuf.length}_${prep.sourceBuf.duration.toFixed(3)}_${prep.sourceBuf.sampleRate}`;

    // Reuse cached neural pair if BS-RoFormer already ran on this exact source slice
    if (track.pairedStemCache && track.pairedStemCache.sourceKey === sourceKey) {
      const decodeUrl = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return audioCtx.decodeAudioData(await res.arrayBuffer());
      };
      return {
        voiceBuffer: needVoice ? await decodeUrl(track.pairedStemCache.voiceUrl) : null,
        musicBuffer: needMusic ? await decodeUrl(track.pairedStemCache.musicUrl) : null,
        engine: `${neuralModelLabel} (cached)`,
        savedAlready: true
      };
    }

    if (neuralEngineReady) {
      if (track.ui.prepProgressEl) track.ui.prepProgressEl.textContent = 'BS-ROFORMER...';
      let res;
      if (prep.libraryId) {
        res = await fetch('/api/separate-stems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            libraryId: prep.libraryId,
            startSec: prep.startSec,
            endSec: prep.endSec,
            stemMode: '2stem',
            title: baseTitle,
            sourceUrl: track.sourceUrl || '',
            durationSec: Number((prep.durationSec || 0).toFixed(2))
          })
        });
      } else {
        const wavBuffer = window.VocalDSP.encodeWavArrayBuffer(prep.sourceBuf);
        res = await fetch('/api/separate-stems', {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'X-Track-Title': encodeURIComponent(baseTitle),
            'X-Source-Url': encodeURIComponent(track.sourceUrl || ''),
            'X-Duration-Sec': String(prep.sourceBuf.duration.toFixed(2))
          },
          body: wavBuffer
        });
      }

      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload.details || errPayload.error || `Neural separation failed (HTTP ${res.status})`);
      }

      const payload = await res.json();
      const voiceUrl = payload?.stems?.voice?.audioUrl;
      const musicUrl = payload?.stems?.music?.audioUrl;
      if (!voiceUrl || !musicUrl) {
        throw new Error('Neural stem worker returned incomplete stems.');
      }

      track.pairedStemCache = { sourceKey, voiceUrl, musicUrl };
      const decodeUrl = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return audioCtx.decodeAudioData(await r.arrayBuffer());
      };
      const [voiceBuffer, musicBuffer] = await Promise.all([
        needVoice ? decodeUrl(voiceUrl) : Promise.resolve(null),
        needMusic ? decodeUrl(musicUrl) : Promise.resolve(null)
      ]);
      fetchLibrary({ silent: true });
      return {
        voiceBuffer,
        musicBuffer,
        voiceId: payload?.stems?.voice?.id || null,
        musicId: payload?.stems?.music?.id || null,
        stemFolder: payload?.stemFolder || null,
        rmsStats: payload?.rmsStats || null,
        engine: `${payload.model || neuralModelLabel} (${payload.separateSec || '?'}s)`,
        savedAlready: true
      };
    }

    // Fallback to in-browser STFT DSP ONLY when neural worker is not installed/configured on server
    const fallbackBuf = prep.sourceBuf || track.buffer;
    if (needVoice && needMusic) {
      const split = await window.VocalDSP.splitStemsFromBuffer(audioCtx, fallbackBuf, (pct) => {
        track.processProgress = `${pct}%`;
        if (track.ui.prepProgressEl) track.ui.prepProgressEl.textContent = `DSP ${pct}%`;
      });
      return { ...split, engine: 'Browser STFT Fallback', savedAlready: false };
    }
    if (needVoice) {
      const vb = await window.VocalDSP.extractVocalsFromBuffer(audioCtx, fallbackBuf, (pct) => {
        track.processProgress = `${pct}%`;
        if (track.ui.prepProgressEl) track.ui.prepProgressEl.textContent = `VOICE ${pct}%`;
      });
      return { voiceBuffer: vb, musicBuffer: null, engine: 'Browser STFT Fallback', savedAlready: false };
    }
    const mb = await window.VocalDSP.extractMusicOnlyFromBuffer(audioCtx, fallbackBuf, (pct) => {
      track.processProgress = `${pct}%`;
      if (track.ui.prepProgressEl) track.ui.prepProgressEl.textContent = `MUSIC ${pct}%`;
    });
    return { voiceBuffer: null, musicBuffer: mb, engine: 'Browser STFT Fallback', savedAlready: false };
  }

  async function handleExtractVoice(track) {
    if (!track.buffer || track.isProcessing) return;
    track.isProcessing = true;
    if (!neuralEngineReady) await checkStemEngineStatus();
    track.processProgress = neuralEngineReady ? 'NEURAL AI...' : '0%';
    const wasPlaying = track.state === 'playing';
    stopTrack(track);
    renderTrackUI(track);

    try {
      await ensureAudioEngine();
      const prep = prepareSeparationSource(track);
      const { slicedLabel, durationSec } = prep;
      const baseTitle = track.title.replace(/\s*\[(VOICE ONLY|MUSIC ONLY|VOCAL|LEAD VOCAL|CHORUS|INSTRUMENTS|TRIMMED|CROPPED.*?)\]/g, '');
      const longNote = durationSec > 180 ? ` (~${Math.ceil(durationSec / 60)}m track; or set IN–OUT for fast 20s slice)` : '';
      setStatus(
        neuralEngineReady
          ? `Running ${neuralModelLabel} neural voice separation on Track 0${track.index + 1}${slicedLabel}${longNote}...`
          : `Extracting VOICE ONLY on Track 0${track.index + 1}...`,
        'info'
      );

      const { voiceBuffer, voiceId, engine, savedAlready, rmsStats } = await separateStemsWithBestEngine(track, prep, {
        needVoice: true,
        needMusic: false,
        baseTitle
      });

      track.stemMode = 'voice';
      track.voiceExtracted = true;
      track.musicExtracted = false;
      const nextTitle = `${baseTitle} [VOICE ONLY]${slicedLabel}`;
      loadBufferIntoTrack(track, voiceBuffer, nextTitle, { preserveOriginal: true, libraryId: voiceId || undefined });
      const rmsNote = rmsStats ? ` (RMS Voc ${rmsStats.vocals ?? '?'} / Inst ${rmsStats.instruments ?? '?'})` : '';
      setStatus(`Clean Voice loaded on Track 0${track.index + 1} via ${engine}${rmsNote} & saved to Library!`, 'success');
      if (!savedAlready) {
        saveBufferToLibrary(voiceBuffer, { title: nextTitle, stemType: 'voice', sourceUrl: track.sourceUrl, silent: true });
      }
      if (wasPlaying) await playTrack(track);
    } catch (err) {
      console.error('Vocal extraction failed:', err);
      setStatus(`Vocal extraction failed on Track 0${track.index + 1}: ${err.message}`, 'error');
    } finally {
      track.isProcessing = false;
      track.processProgress = '';
      renderTrackUI(track);
    }
  }

  async function handleExtractMusicOnly(track) {
    if (!track.buffer || track.isProcessing) return;
    track.isProcessing = true;
    if (!neuralEngineReady) await checkStemEngineStatus();
    track.processProgress = neuralEngineReady ? 'NEURAL AI...' : '0%';
    const wasPlaying = track.state === 'playing';
    stopTrack(track);
    renderTrackUI(track);

    try {
      await ensureAudioEngine();
      const prep = prepareSeparationSource(track);
      const { slicedLabel, durationSec } = prep;
      const baseTitle = track.title.replace(/\s*\[(VOICE ONLY|MUSIC ONLY|VOCAL|LEAD VOCAL|CHORUS|INSTRUMENTS|TRIMMED|CROPPED.*?)\]/g, '');
      const longNote = durationSec > 180 ? ` (~${Math.ceil(durationSec / 60)}m track; or set IN–OUT for fast 20s slice)` : '';
      setStatus(
        neuralEngineReady
          ? `Running ${neuralModelLabel} neural vocal removal on Track 0${track.index + 1}${slicedLabel}${longNote}...`
          : `Extracting MUSIC ONLY on Track 0${track.index + 1}...`,
        'info'
      );

      const { musicBuffer, musicId, engine, savedAlready, rmsStats } = await separateStemsWithBestEngine(track, prep, {
        needVoice: false,
        needMusic: true,
        baseTitle
      });

      track.stemMode = 'music';
      track.voiceExtracted = false;
      track.musicExtracted = true;
      const nextTitle = `${baseTitle} [MUSIC ONLY]${slicedLabel}`;
      loadBufferIntoTrack(track, musicBuffer, nextTitle, { preserveOriginal: true, libraryId: musicId || undefined });
      const rmsNote = rmsStats ? ` (RMS Inst ${rmsStats.instruments ?? '?'} vs Orig ${rmsStats.orig ?? '?'})` : '';
      setStatus(`Clean Music Only loaded on Track 0${track.index + 1} via ${engine}${rmsNote} & saved to Library!`, 'success');
      if (!savedAlready) {
        saveBufferToLibrary(musicBuffer, { title: nextTitle, stemType: 'music', sourceUrl: track.sourceUrl, silent: true });
      }
      if (wasPlaying) await playTrack(track);
    } catch (err) {
      console.error('Music extraction failed:', err);
      setStatus(`Music extraction failed on Track 0${track.index + 1}: ${err.message}`, 'error');
    } finally {
      track.isProcessing = false;
      track.processProgress = '';
      renderTrackUI(track);
    }
  }

  async function handleSplitStems(track) {
    if (!track.buffer || track.isProcessing) return;
    const emptySlot = tracks.find((t) => !t.buffer && t.index !== track.index);

    track.isProcessing = true;
    if (!neuralEngineReady) await checkStemEngineStatus();
    track.processProgress = neuralEngineReady ? 'NEURAL AI...' : '0%';
    stopTrack(track);
    renderTrackUI(track);

    try {
      await ensureAudioEngine();
      const prep = prepareSeparationSource(track);
      const { slicedLabel, durationSec } = prep;
      const baseTitle = track.title.replace(/\s*\[(VOICE ONLY|VOCALS|MUSIC ONLY|VOCAL|LEAD VOCAL|CHORUS|INSTRUMENTS|TRIMMED|CROPPED.*?)\]/g, '');
      const longNote = durationSec > 180 ? ` (~${Math.ceil(durationSec / 60)}m track; or set IN–OUT for fast 20s slice)` : '';
      setStatus(
        neuralEngineReady
          ? `Running ${neuralModelLabel} stem split for Track 0${track.index + 1}${slicedLabel}${longNote}...`
          : `Splitting Track 0${track.index + 1} into Vocals + Instruments...`,
        'info'
      );

      const { voiceBuffer, musicBuffer, voiceId, musicId, stemFolder, engine, savedAlready } = await separateStemsWithBestEngine(track, prep, {
        needVoice: true,
        needMusic: true,
        baseTitle
      });

      const voiceTitle = `${baseTitle} [VOCALS]${slicedLabel}`;
      const musicTitle = `${baseTitle} [INSTRUMENTS]${slicedLabel}`;

      track.stemMode = 'voice';
      track.voiceExtracted = true;
      track.musicExtracted = false;
      loadBufferIntoTrack(track, voiceBuffer, voiceTitle, { preserveOriginal: true, libraryId: voiceId || undefined });

      if (emptySlot) {
        emptySlot.stemMode = 'music';
        emptySlot.voiceExtracted = false;
        emptySlot.musicExtracted = true;
        loadBufferIntoTrack(emptySlot, musicBuffer, musicTitle, {
          preserveOriginal: false,
          sourceUrl: track.sourceUrl,
          libraryId: musicId || null
        });
        emptySlot.stemMode = 'music';
        emptySlot.musicExtracted = true;
        renderTrackUI(emptySlot);
        drawTrackWaveform(emptySlot);
      }

      if (!savedAlready) {
        await saveBufferToLibrary(voiceBuffer, { title: voiceTitle, stemType: 'voice', sourceUrl: track.sourceUrl, silent: true });
        await saveBufferToLibrary(musicBuffer, { title: musicTitle, stemType: 'music', sourceUrl: track.sourceUrl, silent: true });
      }

      const destNote = stemFolder ? ` (${stemFolder}: __vocals.wav & __instruments.wav)` : ' to Library';
      setStatus(
        emptySlot
          ? `Split complete via ${engine}! Vocals on Track 0${track.index + 1}, Instruments on Track 0${emptySlot.index + 1}${destNote}.`
          : `Split complete via ${engine}! Vocals on Track 0${track.index + 1}; both Vocals & Instruments saved${destNote}.`,
        'success'
      );
    } catch (err) {
      console.error('Split stems failed:', err);
      setStatus(`Failed to split stems on Track 0${track.index + 1}: ${err.message}`, 'error');
    } finally {
      track.isProcessing = false;
      track.processProgress = '';
      renderTrackUI(track);
    }
  }

  async function handleMultiStemSplit(track) {
    if (!track.buffer || track.isProcessing) return;
    if (!neuralEngineReady) await checkStemEngineStatus();
    if (!neuralEngineReady) {
      setStatus('3-Stem (Lead + Chorus + Instruments) requires the local Python neural worker.', 'error');
      return;
    }

    track.isProcessing = true;
    track.processProgress = '3-STEM AI...';
    stopTrack(track);
    renderTrackUI(track);

    try {
      await ensureAudioEngine();
      const prep = prepareSeparationSource(track);
      const { slicedLabel, durationSec } = prep;
      const baseTitle = track.title
        .replace(/\s*\[(VOICE ONLY|MUSIC ONLY|VOCAL|LEAD VOCAL|CHORUS|INSTRUMENTS|AI BEAT|TRIMMED|CROPPED.*?)\]/g, '')
        .trim() || 'Track';

      const longNote = durationSec > 180
        ? ` (Full ${Math.ceil(durationSec / 60)}m track runs 3 models & takes ~5–10m; or highlight a 20–45s IN–OUT range for ~20s!)`
        : '';
      setStatus(
        `Extracting Lead Vocal, Chorus/Backing, Instruments & Groove DNA from Track 0${track.index + 1}${slicedLabel}${longNote}...`,
        'info'
      );

      let res;
      if (prep.libraryId) {
        res = await fetch('/api/separate-stems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            libraryId: prep.libraryId,
            startSec: prep.startSec,
            endSec: prep.endSec,
            stemMode: 'multistem',
            splitInstruments: true,
            title: baseTitle,
            sourceUrl: track.sourceUrl || '',
            durationSec: Number((prep.durationSec || 0).toFixed(2))
          })
        });
      } else {
        const wavBuffer = window.VocalDSP.encodeWavArrayBuffer(prep.sourceBuf);
        res = await fetch('/api/separate-stems', {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'X-Track-Title': encodeURIComponent(baseTitle),
            'X-Source-Url': encodeURIComponent(track.sourceUrl || ''),
            'X-Duration-Sec': String(prep.sourceBuf.duration.toFixed(2)),
            'X-Stem-Mode': 'multistem',
            'X-Split-Instruments': 'true'
          },
          body: wavBuffer
        });
      }

      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload.details || errPayload.error || `HTTP ${res.status}`);
      }

      const payload = await res.json();
      const stems = payload.stems || {};
      const decodeUrl = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return audioCtx.decodeAudioData(await r.arrayBuffer());
      };

      const leadStem = stems.lead;
      const chorusStem = stems.chorus;
      const musicStem = stems.music;

      if (leadStem?.audioUrl) {
        const leadBuf = await decodeUrl(leadStem.audioUrl);
        loadBufferIntoTrack(track, leadBuf, leadStem.title, {
          preserveOriginal: true,
          libraryId: leadStem.id || null
        });
        track.stemMode = 'lead';
        track.voiceExtracted = true;
        renderTrackUI(track);
        drawTrackWaveform(track);
      }

      const chorusRms = Number(payload?.rmsStats?.chorus || 0);
      if (chorusStem?.audioUrl && chorusRms >= 0.002) {
        const slot2 = tracks.find((t) => !t.buffer && t.index !== track.index);
        if (slot2) {
          const chorusBuf = await decodeUrl(chorusStem.audioUrl);
          loadBufferIntoTrack(slot2, chorusBuf, chorusStem.title, {
            preserveOriginal: false,
            sourceUrl: track.sourceUrl,
            libraryId: chorusStem.id || null
          });
          slot2.stemMode = 'chorus';
          renderTrackUI(slot2);
          drawTrackWaveform(slot2);
        }
      }

      if (musicStem?.audioUrl) {
        const slot3 = tracks.find((t) => !t.buffer && t.index !== track.index);
        if (slot3) {
          const musicBuf = await decodeUrl(musicStem.audioUrl);
          loadBufferIntoTrack(slot3, musicBuf, musicStem.title, {
            preserveOriginal: false,
            sourceUrl: track.sourceUrl,
            libraryId: musicStem.id || null
          });
          slot3.stemMode = 'music';
          slot3.musicExtracted = true;
          renderTrackUI(slot3);
          drawTrackWaveform(slot3);
        }
      }

      if (payload.styleProfile) {
        currentStyleProfile = payload.styleProfile;
        currentStyleRefTitle = baseTitle;
        renderStyleDnaBadge();
      }

      await fetchLibrary({ silent: true });
      autoSelectStudioComponents({ leadId: leadStem?.id, chorusId: chorusStem?.id, refId: musicStem?.id });

      const sp = payload.styleProfile;
      const st = payload.rmsStats;
      const dnaNote = sp ? ` • Style DNA: ${sp.bpm} BPM, ${sp.keyName} ${sp.scale}` : '';
      const rmsNote = st ? ` (RMS Lead:${st.leadVocal} / Chorus:${st.chorus} / Inst:${st.instruments})` : '';
      const chorusNote = chorusRms < 0.002 ? ' — solo verse section (low chorus energy, saved to Library)' : '';
      setStatus(
        `3-Stem split complete (${payload.separateSec}s)!${rmsNote} Saved to Library & Component Studio${dnaNote}${chorusNote}.`,
        'success'
      );
    } catch (err) {
      console.error('3-Stem split failed:', err);
      setStatus(`3-Stem split failed on Track 0${track.index + 1}: ${err.message}`, 'error');
    } finally {
      track.isProcessing = false;
      track.processProgress = '';
      renderTrackUI(track);
    }
  }

  async function handleCropRegion(track) {
    if (!track.buffer || track.isProcessing) return;
    const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
    if (!hasSelection) {
      setStatus('Select a portion first using IN / OUT sliders or SET IN / SET OUT while scrolling.', 'info');
      return;
    }
    if (endSec - startSec < 0.1) {
      setStatus('Selected region must be at least 0.1s long.', 'error');
      return;
    }

    const wasPlaying = track.state === 'playing';
    stopTrack(track);
    await ensureAudioEngine();
    if (!track.originalBuffer) track.originalBuffer = track.buffer;

    const sliced = window.VocalDSP.sliceAudioBuffer(audioCtx, track.buffer, startSec, endSec);
    track.preStemBuffer = sliced;
    track.croppedRegion = true;
    track.loop = true;
    const baseTitle = track.title.replace(/\s*\[CROPPED.*?\]/g, '');
    loadBufferIntoTrack(track, sliced, `${baseTitle} [CROPPED ${formatTime(startSec)}-${formatTime(endSec)}]`, { preserveOriginal: true });
    setStatus(`Trimmed Track 0${track.index + 1} to ${formatTime(startSec)} – ${formatTime(endSec)} (${formatTime(sliced.duration)}) with Loop ON.`, 'success');
    if (wasPlaying) await playTrack(track);
  }

  async function handleSaveTrackToLibrary(track) {
    if (!track.buffer || track.isProcessing) return;
    const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
    let targetBuffer = track.buffer;
    let stemType = track.croppedRegion ? 'crop' : (track.stemMode !== 'mix' ? track.stemMode : (track.silenceTrimmed ? 'trimmed' : 'mix'));
    let title = track.title;

    // If user currently highlighted an IN–OUT portion without trimming yet, save that selected portion cleanly
    if (hasSelection) {
      await ensureAudioEngine();
      targetBuffer = window.VocalDSP.sliceAudioBuffer(audioCtx, track.buffer, startSec, endSec);
      stemType = 'crop';
      const baseTitle = track.title.replace(/\s*\[CROPPED.*?\]/g, '');
      title = `${baseTitle} [CROPPED ${formatTime(startSec)}-${formatTime(endSec)}]`;
    }

    setStatus(`Saving "${title}" to Local Project Library...`, 'info');
    await saveBufferToLibrary(targetBuffer, { title, stemType, sourceUrl: track.sourceUrl, silent: false });
  }

  async function handleTrimSilence(track) {
    if (!track.buffer || track.isProcessing) return;
    track.isProcessing = true;
    const wasPlaying = track.state === 'playing';
    stopTrack(track);
    renderTrackUI(track);

    try {
      await ensureAudioEngine();
      if (!track.originalBuffer) {
        track.originalBuffer = track.buffer;
      }
      const { buffer: trimmed, removedSeconds, wasAllSilent } = window.VocalDSP.trimSilenceFromBuffer(
        audioCtx,
        track.buffer
      );

      if (wasAllSilent) {
        setStatus(`Track ${track.index + 1} appears silent below -38 dB; nothing trimmed.`, 'info');
      } else if (removedSeconds < 0.05) {
        setStatus(`Track ${track.index + 1} already has tight silence boundaries.`, 'info');
      } else {
        track.silenceTrimmed = true;
        track.preStemBuffer = trimmed;
        const baseTitle = track.title.replace(/\s*\[TRIMMED\]/g, '');
        loadBufferIntoTrack(track, trimmed, `${baseTitle} [TRIMMED]`, { preserveOriginal: true });
        setStatus(`Trimmed ${removedSeconds.toFixed(2)}s of silence from Track ${track.index + 1}.`, 'success');
      }
      if (wasPlaying) await playTrack(track);
    } catch (err) {
      console.error('Trim silence failed:', err);
      setStatus(`Failed to trim silence on Track ${track.index + 1}.`, 'error');
    } finally {
      track.isProcessing = false;
      renderTrackUI(track);
    }
  }

  async function handleRestoreOriginal(track) {
    if (!track.originalBuffer || track.isProcessing) return;
    const wasPlaying = track.state === 'playing';
    const cleanTitle = track.title.replace(/\s*\[(VOICE ONLY|MUSIC ONLY|VOCAL|TRIMMED|CROPPED.*?)\]/g, '');
    track.stemMode = 'mix';
    track.voiceExtracted = false;
    track.musicExtracted = false;
    track.silenceTrimmed = false;
    track.croppedRegion = false;
    track.preStemBuffer = track.originalBuffer;
    loadBufferIntoTrack(track, track.originalBuffer, cleanTitle, {
      preserveOriginal: true,
      libraryId: track.originalLibraryId || null
    });
    setStatus(`Restored original audio on Track ${track.index + 1}.`, 'info');
    if (wasPlaying) await playTrack(track);
  }

  function renderTrackUI(track) {
    const { ui } = track;
    const isLoaded = Boolean(track.buffer);
    const isPlaying = track.state === 'playing';
    const isPaused = track.state === 'paused';
    const hasModifiedBuffer = Boolean(track.originalBuffer && track.buffer && track.buffer !== track.originalBuffer);
    const { hasSelection } = getRegionBoundsSec(track);

    ui.card.classList.toggle('is-loaded', isLoaded);
    ui.card.classList.toggle('is-playing', isPlaying);
    ui.card.classList.toggle('is-excluded', isLoaded && track.remixIncluded === false);

    ui.titleEl.textContent = isLoaded ? track.title : 'EMPTY SLOT — DROP AUDIO OR YT LINK';
    ui.titleEl.title = isLoaded ? track.title : '';

    if (ui.stemBadge) {
      ui.stemBadge.className = 'stem-badge';
      if (!isLoaded) {
        ui.stemBadge.textContent = 'EMPTY';
      } else if (track.stemMode === 'lead') {
        ui.stemBadge.textContent = 'LEAD VOCAL';
        ui.stemBadge.classList.add('lead');
      } else if (track.stemMode === 'chorus') {
        ui.stemBadge.textContent = 'CHORUS';
        ui.stemBadge.classList.add('chorus');
      } else if (track.stemMode === 'voice') {
        ui.stemBadge.textContent = 'VOICE ONLY';
        ui.stemBadge.classList.add('voice');
      } else if (track.stemMode === 'music') {
        ui.stemBadge.textContent = 'INSTRUMENTS';
        ui.stemBadge.classList.add('music');
      } else if (track.stemMode === 'beat') {
        ui.stemBadge.textContent = 'AI STYLE BEAT';
        ui.stemBadge.classList.add('beat');
      } else {
        ui.stemBadge.textContent = 'FULL MIX';
      }
    }

    if (ui.prepProgressEl) {
      ui.prepProgressEl.textContent = track.isProcessing ? (track.processProgress || 'WORKING...') : '';
    }

    ui.playBtn.disabled = !isLoaded || isPlaying || track.isProcessing;
    ui.pauseBtn.disabled = !isLoaded || !isPlaying || track.isProcessing;
    ui.stopBtn.disabled = !isLoaded || track.state === 'stopped' || track.isProcessing;
    ui.clearBtn.disabled = !isLoaded || track.isProcessing;
    ui.scrubInput.disabled = !isLoaded || track.isProcessing;
    ui.jumpBackBtn.disabled = !isLoaded || track.isProcessing;
    ui.jumpFwdBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.zoomBtn) {
      const z = track.waveZoom || 1;
      ui.zoomBtn.disabled = !isLoaded || track.isProcessing;
      ui.zoomBtn.textContent = `${z}x`;
      ui.zoomBtn.classList.toggle('active', z > 1);
      ui.zoomBtn.setAttribute('aria-pressed', String(z > 1));
    }
    ui.regionStartSlider.disabled = !isLoaded || track.isProcessing;
    ui.regionEndSlider.disabled = !isLoaded || track.isProcessing;
    if (ui.inMinusBtn) ui.inMinusBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.inPlusBtn) ui.inPlusBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.outMinusBtn) ui.outMinusBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.outPlusBtn) ui.outPlusBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.regionInVal) ui.regionInVal.disabled = !isLoaded || track.isProcessing;
    if (ui.regionOutVal) ui.regionOutVal.disabled = !isLoaded || track.isProcessing;
    ui.regionPinInBtn.disabled = !isLoaded || track.isProcessing;
    ui.regionPinOutBtn.disabled = !isLoaded || track.isProcessing;
    ui.regionLoopBtn.disabled = !isLoaded || track.isProcessing;
    ui.regionLoopBtn.classList.toggle('active', track.regionLoopEnabled);
    ui.regionLoopBtn.setAttribute('aria-pressed', String(track.regionLoopEnabled));
    ui.cropRegionBtn.disabled = !isLoaded || track.isProcessing || !hasSelection;
    ui.regionResetBtn.disabled = !isLoaded || track.isProcessing || !hasSelection;
    ui.saveLibBtn.disabled = !isLoaded || track.isProcessing;

    ui.extractVoiceBtn.disabled = !isLoaded || track.isProcessing;
    ui.extractMusicBtn.disabled = !isLoaded || track.isProcessing;
    ui.splitStemsBtn.disabled = !isLoaded || track.isProcessing;
    if (ui.split3StemBtn) ui.split3StemBtn.disabled = !isLoaded || track.isProcessing;
    ui.trimSilenceBtn.disabled = !isLoaded || track.isProcessing;
    ui.restoreOrigBtn.disabled = !hasModifiedBuffer || track.isProcessing;
    ui.extractVoiceBtn.classList.toggle('active', track.stemMode === 'voice');
    ui.extractMusicBtn.classList.toggle('active', track.stemMode === 'music');
    ui.trimSilenceBtn.classList.toggle('active', track.silenceTrimmed);

    ui.playBtn.classList.toggle('active', isPlaying);
    ui.pauseBtn.classList.toggle('active', isPaused);

    ui.loopBtn.classList.toggle('active', track.loop);
    ui.loopBtn.setAttribute('aria-pressed', String(track.loop));

    // Voice Tuner readouts
    const stPrefix = track.pitchSemitones > 0 ? '+' : '';
    ui.pitchValEl.textContent = `${stPrefix}${track.pitchSemitones} st`;
    ui.pitchSlider.value = String(track.pitchSemitones);

    const centPrefix = track.fineCents > 0 ? '+' : '';
    ui.fineValEl.textContent = `${centPrefix}${track.fineCents} ¢`;
    ui.fineSlider.value = String(track.fineCents);

    const tonePrefix = track.vocalToneDb > 0 ? '+' : '';
    ui.toneValEl.textContent = `${tonePrefix}${track.vocalToneDb} dB`;
    ui.toneSlider.value = String(track.vocalToneDb);

    ui.doublerBtn.classList.toggle('active', track.doublerEnabled);
    ui.doublerBtn.setAttribute('aria-pressed', String(track.doublerEnabled));
    ui.autoTuneSelect.value = String(track.autoTuneMode);
    ui.tunerKeySelect.value = String(track.tunerKey);
    ui.tunerKeySelect.disabled = track.autoTuneMode === 0;
    if (track.autoTuneMode === 0) {
      ui.tunerNotePill.textContent = 'NOTE: --';
    }

    // Remix Director per-track reason & entry delay
    if (ui.remixDelayEl) {
      ui.remixDelayEl.textContent = track.startDelaySec > 0 ? `+${track.startDelaySec.toFixed(1)}s ENTRY` : '';
    }
    if (ui.remixReasonEl) {
      ui.remixReasonEl.textContent = track.remixReason || '';
      ui.remixReasonEl.hidden = !track.remixReason;
    }

    // Lo-Fi Filter & Reverb
    ui.lofiBtn.setAttribute('aria-pressed', String(track.lofiEnabled));
    ui.lofiStateEl.textContent = track.lofiEnabled ? 'ON' : 'BYPASS';

    const pct = Math.round(track.reverbMix * 100);
    const angle = -135 + track.reverbMix * 270;
    ui.reverbIndicator.style.transform = `rotate(${angle}deg)`;
    ui.reverbValEl.textContent = `${pct}%`;
    ui.reverbDial.setAttribute('aria-valuenow', String(pct));

    ui.volumeSlider.value = String(track.volume);
    ui.volumeValEl.textContent = `${Math.round(track.volume * 100)}%`;

    if (isLoaded) {
      const pos = getTrackPosition(track);
      const dur = track.buffer.duration;
      ui.durationEl.textContent = formatTimeTenths(dur);
      ui.elapsedEl.textContent = formatTimeTenths(pos);
      if (!track.isScrubbing) {
        ui.scrubInput.value = dur > 0 ? String((pos / dur) * 1000) : '0';
      }
      ui.regionStartSlider.value = String(Math.round(track.regionStartRatio * 10000));
      ui.regionEndSlider.value = String(Math.round(track.regionEndRatio * 10000));
      ui.regionInVal.textContent = formatTimeTenths(track.regionStartRatio * dur);
      ui.regionOutVal.textContent = formatTimeTenths(track.regionEndRatio * dur);
    } else {
      ui.durationEl.textContent = '00:00.0';
      ui.elapsedEl.textContent = '00:00.0';
      ui.scrubInput.value = '0';
      ui.regionStartSlider.value = '0';
      ui.regionEndSlider.value = '10000';
      ui.regionInVal.textContent = '00:00.0';
      ui.regionOutVal.textContent = '00:00.0';
    }
  }

  function buildTrackCard(index) {
    const track = {
      index,
      buffer: null,
      originalBuffer: null,
      preStemBuffer: null,
      waveformPeaks: null,
      sourceUrl: '',
      stemMode: 'mix',
      voiceExtracted: false,
      musicExtracted: false,
      silenceTrimmed: false,
      croppedRegion: false,
      regionStartRatio: 0,
      regionEndRatio: 1,
      regionLoopEnabled: true,
      waveZoom: 1,
      isScrubbing: false,
      isProcessing: false,
      processProgress: '',
      remixPrompt: '',
      remixIncluded: true,
      startDelaySec: 0,
      remixReason: '',
      sourceNode: null,
      title: '',
      state: 'empty',
      offset: 0,
      startedAt: 0,
      loop: true,
      volume: 0.85,
      pitchSemitones: 0,
      fineCents: 0,
      autoTuneMode: 0,
      tunerKey: 0,
      vocalToneDb: 0,
      doublerEnabled: false,
      lofiEnabled: false,
      reverbMix: 0.25,
      nodes: null,
      ui: {}
    };

    const card = document.createElement('article');
    card.className = 'track-card';
    card.dataset.track = String(index);

    card.innerHTML = `
      <div class="track-header">
        <div class="track-id-wrap">
          <span class="track-led" aria-hidden="true"></span>
          <span class="track-ch">TRACK 0${index + 1}</span>
        </div>
        <div class="track-header-actions">
          <button type="button" class="btn-icon btn-loop active" aria-pressed="true" title="Toggle Loop">LOOP</button>
          <label class="btn-icon btn-file-label" title="Load local audio file">
            FILE
            <input type="file" accept="audio/*" class="sr-only file-input" />
          </label>
          <button type="button" class="btn-icon btn-clear" title="Clear track slot" disabled>✕</button>
        </div>
      </div>

      <div class="track-lcd">
        <div class="track-title-row">
          <div class="track-title">EMPTY SLOT — DROP AUDIO OR YT LINK</div>
          <span class="stem-badge">EMPTY</span>
        </div>
        <canvas class="track-waveform" width="280" height="48" title="Click or drag anywhere on the waveform to scroll to that spot" aria-label="Track ${index + 1} Waveform"></canvas>
        <div class="track-progress-row">
          <input type="range" class="track-scrub" min="0" max="1000" value="0" disabled aria-label="Track ${index + 1} Playback Position" />
          <div class="track-time">
            <span class="time-elapsed">00:00.0</span>
            <div class="jump-controls">
              <button type="button" class="btn-jump btn-jump-back" disabled title="Scroll back 5 seconds">-5s</button>
              <button type="button" class="btn-jump btn-jump-fwd" disabled title="Scroll forward 5 seconds">+5s</button>
              <button type="button" class="btn-jump btn-zoom" aria-pressed="false" disabled title="Cycle waveform zoom (1x -> 4x -> 12x) for surgical precision">1x</button>
            </div>
            <span class="time-duration">00:00.0</span>
          </div>
        </div>

        <div class="region-bar">
          <div class="region-sliders">
            <div class="region-field">
              <div class="region-field-top">
                <span>IN</span>
                <span class="region-nudge-group">
                  <button type="button" class="btn-nudge btn-in-minus" disabled title="Nudge IN earlier by 0.1s">-0.1s</button>
                  <button type="button" class="region-val region-in-val" disabled title="Click to enter exact IN timestamp (MM:SS.t or seconds)">00:00.0</button>
                  <button type="button" class="btn-nudge btn-in-plus" disabled title="Nudge IN later by 0.1s">+0.1s</button>
                </span>
              </div>
              <input type="range" class="region-range region-start-slider" min="0" max="9999" step="1" value="0" disabled aria-label="Track ${index + 1} Region Start" />
            </div>
            <div class="region-field">
              <div class="region-field-top">
                <span>OUT</span>
                <span class="region-nudge-group">
                  <button type="button" class="btn-nudge btn-out-minus" disabled title="Nudge OUT earlier by 0.1s">-0.1s</button>
                  <button type="button" class="region-val region-out-val" disabled title="Click to enter exact OUT timestamp (MM:SS.t or seconds)">00:00.0</button>
                  <button type="button" class="btn-nudge btn-out-plus" disabled title="Nudge OUT later by 0.1s">+0.1s</button>
                </span>
              </div>
              <input type="range" class="region-range region-end-slider" min="1" max="10000" step="1" value="10000" disabled aria-label="Track ${index + 1} Region End" />
            </div>
          </div>
          <div class="region-actions">
            <div class="region-actions-left">
              <button type="button" class="btn-region-pin btn-region-pin-in" disabled title="Set IN at current scroll position">[ IN</button>
              <button type="button" class="btn-region-pin btn-region-pin-out" disabled title="Set OUT at current scroll position">OUT ]</button>
              <button type="button" class="btn-region-loop active" aria-pressed="true" disabled title="Loop only the selected IN – OUT portion">🔁 LOOP SEL</button>
            </div>
            <div class="region-actions-right">
              <button type="button" class="btn-region-crop" disabled title="Trim/crop track to the selected IN – OUT portion">✂ TRIM</button>
              <button type="button" class="btn-region-reset" disabled title="Reset IN / OUT selection">↺ SEL</button>
              <button type="button" class="btn-save-lib" disabled title="Save track (or selected portion) into Local Project Library">💾 SAVE</button>
            </div>
          </div>
        </div>
      </div>

      <div class="transport-row">
        <button type="button" class="btn-transport btn-play" disabled>▶ PLAY</button>
        <button type="button" class="btn-transport btn-pause" disabled>❚❚ PAUSE</button>
        <button type="button" class="btn-transport btn-stop" disabled>■ STOP</button>
      </div>

      <!-- Stem Extraction & Silence Edit -->
      <div class="vocal-prep-box">
        <div class="section-bar-header">
          <span class="section-tag stem-engine-tag">STEM EXTRACT // EDIT</span>
          <span class="prep-progress"></span>
        </div>
        <div class="vocal-prep-actions">
          <button type="button" class="btn-prep btn-extract-voice" disabled title="Isolate center vocals only">
            🎙 VOICE ONLY
          </button>
          <button type="button" class="btn-prep btn-prep-music btn-extract-music" disabled title="Remove vocals and keep stereo music only">
            🎵 MUSIC ONLY
          </button>
        </div>
        <div class="vocal-prep-actions-row2">
          <button type="button" class="btn-prep btn-prep-split btn-split-stems" disabled title="Keep Voice on this track and load Music Only into the next empty track">
            ⚡ 2-STEM
          </button>
          <button type="button" class="btn-prep btn-prep-multi btn-split-3stem" disabled title="Separate into Lead Vocal, Chorus/Backing, Instruments, Drums & Bass + analyze Lo-Fi Style DNA">
            🎭 3-STEM SPLIT
          </button>
          <button type="button" class="btn-prep btn-trim-silence" disabled title="Trim dead air at start/end and collapse long silent pauses">
            ✂ SILENCE
          </button>
          <button type="button" class="btn-prep btn-prep-undo btn-restore-orig" disabled title="Restore original untouched audio">
            ↺ ORIG
          </button>
        </div>
      </div>

      <!-- Per-Track Gemini Remix Prompt -->
      <div class="track-remix-box">
        <div class="section-bar-header">
          <span class="track-remix-tag">GEMINI // WHAT TO TAKE</span>
          <span class="track-remix-delay"></span>
        </div>
        <textarea
          class="track-remix-prompt"
          rows="2"
          placeholder="e.g. Take chorus vocals 0:20-0:42, trim silence, pitch -2 st, warm reverb"
          aria-label="Track ${index + 1} Gemini Remix Prompt"
        ></textarea>
        <div class="track-remix-reason" hidden></div>
      </div>

      <!-- Voice Tuner: Pitch, Fine Tune, Auto-Tune Scale Snap, Presence & Doubler -->
      <div class="voice-tuner-box">
        <div class="section-bar-header">
          <span class="section-tag tuner-tag">VOICE TUNER</span>
          <span class="tuner-note-pill">NOTE: --</span>
        </div>

        <div class="tuner-slider-row">
          <div class="tuner-row-top">
            <span>PITCH SHIFT</span>
            <span class="tuner-val pitch-val" title="Click to reset pitch to 0 st">0 st</span>
          </div>
          <input type="range" class="tuner-range pitch-slider" min="-12" max="12" step="1" value="0" aria-label="Track ${index + 1} Pitch Shift Semitones" />
        </div>

        <div class="tuner-slider-row">
          <div class="tuner-row-top">
            <span>FINE TUNE</span>
            <span class="tuner-val fine-val" title="Click to reset fine tune to 0 cents">0 ¢</span>
          </div>
          <input type="range" class="tuner-range fine-slider" min="-50" max="50" step="1" value="0" aria-label="Track ${index + 1} Fine Tune Cents" />
        </div>

        <div class="tuner-slider-row">
          <div class="tuner-row-top">
            <span>VOICE TONE (2.8kHz)</span>
            <span class="tuner-val tone-val" title="Click to reset tone to 0 dB">0 dB</span>
          </div>
          <input type="range" class="tuner-range tone-slider" min="-6" max="9" step="0.5" value="0" aria-label="Track ${index + 1} Vocal Tone Presence" />
        </div>

        <div class="tuner-select-grid">
          <select class="tuner-select autotune-mode" aria-label="Track ${index + 1} Auto-Tune Mode">
            <option value="0" selected>Auto-Tune: OFF</option>
            <option value="1">Snap: Chromatic</option>
            <option value="2">Snap: Major</option>
            <option value="3">Snap: Minor</option>
            <option value="4">Snap: Pentatonic</option>
          </select>
          <select class="tuner-select tuner-key" aria-label="Track ${index + 1} Auto-Tune Key" disabled>
            ${NOTE_LABELS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}
          </select>
          <button type="button" class="btn-doubler" aria-pressed="false" title="Toggle Stereo Vocal Doubler">DOUBLE</button>
        </div>
      </div>

      <div class="fx-bay">
        <div class="fx-module">
          <span class="fx-label">LO-FI FILTER</span>
          <button type="button" class="lofi-toggle" aria-pressed="false" title="Low-Pass Filter (2000Hz)">
            <span class="lofi-toggle-led" aria-hidden="true"></span>
            <span class="lofi-toggle-state">BYPASS</span>
          </button>
          <span class="fx-sub">LPF 2000Hz</span>
        </div>

        <div class="fx-module">
          <span class="fx-label">REVERB MIX</span>
          <div class="dial-wrap">
            <div
              class="reverb-dial"
              role="slider"
              tabindex="0"
              aria-label="Track ${index + 1} Reverb Wet/Dry Mix"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="25"
              title="Drag vertically or scroll to adjust reverb wet/dry mix"
            >
              <span class="dial-indicator" aria-hidden="true"></span>
            </div>
          </div>
          <span class="fx-sub reverb-val">25%</span>
        </div>
      </div>

      <div class="volume-section">
        <div class="volume-header">
          <span class="fx-label">VOLUME</span>
          <span class="volume-val">85%</span>
        </div>
        <input
          type="range"
          class="fader volume-slider"
          min="0"
          max="1"
          step="0.01"
          value="0.85"
          aria-label="Track ${index + 1} Volume"
        />
      </div>
    `;

    track.ui = {
      card,
      titleEl: card.querySelector('.track-title'),
      stemBadge: card.querySelector('.stem-badge'),
      waveformCanvas: card.querySelector('.track-waveform'),
      scrubInput: card.querySelector('.track-scrub'),
      elapsedEl: card.querySelector('.time-elapsed'),
      durationEl: card.querySelector('.time-duration'),
      jumpBackBtn: card.querySelector('.btn-jump-back'),
      jumpFwdBtn: card.querySelector('.btn-jump-fwd'),
      zoomBtn: card.querySelector('.btn-zoom'),
      regionStartSlider: card.querySelector('.region-start-slider'),
      regionEndSlider: card.querySelector('.region-end-slider'),
      inMinusBtn: card.querySelector('.btn-in-minus'),
      inPlusBtn: card.querySelector('.btn-in-plus'),
      outMinusBtn: card.querySelector('.btn-out-minus'),
      outPlusBtn: card.querySelector('.btn-out-plus'),
      regionInVal: card.querySelector('.region-in-val'),
      regionOutVal: card.querySelector('.region-out-val'),
      stemEngineTag: card.querySelector('.stem-engine-tag'),
      regionPinInBtn: card.querySelector('.btn-region-pin-in'),
      regionPinOutBtn: card.querySelector('.btn-region-pin-out'),
      regionLoopBtn: card.querySelector('.btn-region-loop'),
      cropRegionBtn: card.querySelector('.btn-region-crop'),
      regionResetBtn: card.querySelector('.btn-region-reset'),
      saveLibBtn: card.querySelector('.btn-save-lib'),
      playBtn: card.querySelector('.btn-play'),
      pauseBtn: card.querySelector('.btn-pause'),
      stopBtn: card.querySelector('.btn-stop'),
      loopBtn: card.querySelector('.btn-loop'),
      fileInput: card.querySelector('.file-input'),
      clearBtn: card.querySelector('.btn-clear'),
      prepProgressEl: card.querySelector('.prep-progress'),
      extractVoiceBtn: card.querySelector('.btn-extract-voice'),
      extractMusicBtn: card.querySelector('.btn-extract-music'),
      splitStemsBtn: card.querySelector('.btn-split-stems'),
      split3StemBtn: card.querySelector('.btn-split-3stem'),
      trimSilenceBtn: card.querySelector('.btn-trim-silence'),
      restoreOrigBtn: card.querySelector('.btn-restore-orig'),
      remixPromptInput: card.querySelector('.track-remix-prompt'),
      remixDelayEl: card.querySelector('.track-remix-delay'),
      remixReasonEl: card.querySelector('.track-remix-reason'),
      tunerNotePill: card.querySelector('.tuner-note-pill'),
      pitchSlider: card.querySelector('.pitch-slider'),
      pitchValEl: card.querySelector('.pitch-val'),
      fineSlider: card.querySelector('.fine-slider'),
      fineValEl: card.querySelector('.fine-val'),
      toneSlider: card.querySelector('.tone-slider'),
      toneValEl: card.querySelector('.tone-val'),
      autoTuneSelect: card.querySelector('.autotune-mode'),
      tunerKeySelect: card.querySelector('.tuner-key'),
      doublerBtn: card.querySelector('.btn-doubler'),
      lofiBtn: card.querySelector('.lofi-toggle'),
      lofiStateEl: card.querySelector('.lofi-toggle-state'),
      reverbDial: card.querySelector('.reverb-dial'),
      reverbIndicator: card.querySelector('.dial-indicator'),
      reverbValEl: card.querySelector('.reverb-val'),
      volumeSlider: card.querySelector('.volume-slider'),
      volumeValEl: card.querySelector('.volume-val')
    };

    // Transport Events
    track.ui.playBtn.addEventListener('click', () => playTrack(track));
    track.ui.pauseBtn.addEventListener('click', () => pauseTrack(track));
    track.ui.stopBtn.addEventListener('click', () => stopTrack(track));
    track.ui.clearBtn.addEventListener('click', () => {
      clearTrack(track);
      setStatus(`Cleared Track ${index + 1}.`, 'info');
    });

    track.ui.loopBtn.addEventListener('click', async () => {
      track.loop = !track.loop;
      if (track.state === 'playing' && track.buffer) {
        await seekTrackTo(track, getTrackPosition(track));
      } else {
        renderTrackUI(track);
      }
    });

    // Vocal Prep / Stem Events
    track.ui.extractVoiceBtn.addEventListener('click', () => handleExtractVoice(track));
    track.ui.extractMusicBtn.addEventListener('click', () => handleExtractMusicOnly(track));
    track.ui.splitStemsBtn.addEventListener('click', () => handleSplitStems(track));
    if (track.ui.split3StemBtn) {
      track.ui.split3StemBtn.addEventListener('click', () => handleMultiStemSplit(track));
    }
    track.ui.trimSilenceBtn.addEventListener('click', () => handleTrimSilence(track));
    track.ui.restoreOrigBtn.addEventListener('click', () => handleRestoreOriginal(track));

    // Jump Scroll (-5s / +5s) & Region Selection / Loop / Trim / Save
    const applyRegionUpdate = async (seekSec = null) => {
      if (!track.buffer) return;
      renderTrackUI(track);
      drawTrackWaveform(track);
      if (track.state === 'playing') {
        const { startSec, endSec, hasSelection } = getRegionBoundsSec(track);
        let nextPos = seekSec !== null ? seekSec : getTrackPosition(track);
        if (hasSelection && track.regionLoopEnabled) {
          nextPos = Math.max(startSec, Math.min(endSec - 0.02, nextPos));
        }
        await seekTrackTo(track, nextPos);
      } else if (seekSec !== null) {
        await seekTrackTo(track, seekSec);
      }
    };

    track.ui.jumpBackBtn.addEventListener('click', () => {
      if (!track.buffer) return;
      seekTrackTo(track, getTrackPosition(track) - 5);
    });
    track.ui.jumpFwdBtn.addEventListener('click', () => {
      if (!track.buffer) return;
      seekTrackTo(track, getTrackPosition(track) + 5);
    });

    if (track.ui.zoomBtn) {
      track.ui.zoomBtn.addEventListener('click', () => {
        if (!track.buffer) return;
        const levels = [1, 4, 12];
        const nextIdx = (levels.indexOf(track.waveZoom || 1) + 1) % levels.length;
        track.waveZoom = levels[nextIdx];
        renderTrackUI(track);
        drawTrackWaveform(track);
        setStatus(`Track 0${track.index + 1} waveform zoom: ${track.waveZoom}x.`, 'info');
      });
    }

    const getMinGapRatio = () => {
      const dur = track.buffer ? Math.max(0.1, track.buffer.duration) : 1;
      return Math.min(0.01, 0.05 / dur);
    };

    const setRegionBoundSec = async (bound, targetSec, commitSeek = false) => {
      if (!track.buffer || track.buffer.duration <= 0) return;
      const dur = track.buffer.duration;
      const minGap = getMinGapRatio();
      const clampedRatio = Math.max(0, Math.min(1, targetSec / dur));
      if (bound === 'start') {
        track.regionStartRatio = Math.min(clampedRatio, Math.max(0, track.regionEndRatio - minGap));
      } else {
        track.regionEndRatio = Math.max(clampedRatio, Math.min(1, track.regionStartRatio + minGap));
      }
      await applyRegionUpdate(commitSeek ? track.regionStartRatio * dur : null);
    };

    const promptEditRegionBound = async (bound) => {
      if (!track.buffer || track.buffer.duration <= 0) return;
      const dur = track.buffer.duration;
      const currentRatio = bound === 'start' ? track.regionStartRatio : track.regionEndRatio;
      const label = bound === 'start' ? 'IN' : 'OUT';
      const entered = window.prompt(
        `Enter Track 0${track.index + 1} ${label} timestamp (MM:SS.t or seconds, max ${formatTimeTenths(dur)}):`,
        formatTimeTenths(currentRatio * dur)
      );
      if (entered === null) return;
      const parsedSec = parseTimeInput(entered);
      if (parsedSec === null) {
        setStatus(`Invalid timestamp "${entered}". Use MM:SS.t (e.g. 01:24.5) or seconds.`, 'error');
        return;
      }
      await setRegionBoundSec(bound, Math.max(0, Math.min(dur, parsedSec)), bound === 'start');
    };

    if (track.ui.inMinusBtn) {
      track.ui.inMinusBtn.addEventListener('click', () => {
        if (!track.buffer) return;
        setRegionBoundSec('start', track.regionStartRatio * track.buffer.duration - 0.1, true);
      });
    }
    if (track.ui.inPlusBtn) {
      track.ui.inPlusBtn.addEventListener('click', () => {
        if (!track.buffer) return;
        setRegionBoundSec('start', track.regionStartRatio * track.buffer.duration + 0.1, true);
      });
    }
    if (track.ui.outMinusBtn) {
      track.ui.outMinusBtn.addEventListener('click', () => {
        if (!track.buffer) return;
        setRegionBoundSec('end', track.regionEndRatio * track.buffer.duration - 0.1, false);
      });
    }
    if (track.ui.outPlusBtn) {
      track.ui.outPlusBtn.addEventListener('click', () => {
        if (!track.buffer) return;
        setRegionBoundSec('end', track.regionEndRatio * track.buffer.duration + 0.1, false);
      });
    }
    if (track.ui.regionInVal) {
      track.ui.regionInVal.addEventListener('click', () => promptEditRegionBound('start'));
    }
    if (track.ui.regionOutVal) {
      track.ui.regionOutVal.addEventListener('click', () => promptEditRegionBound('end'));
    }

    track.ui.regionStartSlider.addEventListener('input', () => {
      if (!track.buffer) return;
      const startVal = parseInt(track.ui.regionStartSlider.value, 10) / 10000;
      track.regionStartRatio = Math.min(startVal, Math.max(0, track.regionEndRatio - getMinGapRatio()));
      track.ui.regionInVal.textContent = formatTimeTenths(track.regionStartRatio * track.buffer.duration);
      const { hasSelection } = getRegionBoundsSec(track);
      track.ui.cropRegionBtn.disabled = !hasSelection;
      track.ui.regionResetBtn.disabled = !hasSelection;
      drawTrackWaveform(track);
    });
    track.ui.regionStartSlider.addEventListener('change', () => {
      if (!track.buffer) return;
      applyRegionUpdate(track.regionStartRatio * track.buffer.duration);
    });

    track.ui.regionEndSlider.addEventListener('input', () => {
      if (!track.buffer) return;
      const endVal = parseInt(track.ui.regionEndSlider.value, 10) / 10000;
      track.regionEndRatio = Math.max(endVal, Math.min(1, track.regionStartRatio + getMinGapRatio()));
      track.ui.regionOutVal.textContent = formatTimeTenths(track.regionEndRatio * track.buffer.duration);
      const { hasSelection } = getRegionBoundsSec(track);
      track.ui.cropRegionBtn.disabled = !hasSelection;
      track.ui.regionResetBtn.disabled = !hasSelection;
      drawTrackWaveform(track);
    });
    track.ui.regionEndSlider.addEventListener('change', () => {
      if (!track.buffer) return;
      applyRegionUpdate(null);
    });

    track.ui.regionPinInBtn.addEventListener('click', () => {
      if (!track.buffer || track.buffer.duration <= 0) return;
      const ratio = getTrackPosition(track) / track.buffer.duration;
      track.regionStartRatio = Math.max(0, Math.min(ratio, Math.max(0, track.regionEndRatio - getMinGapRatio())));
      applyRegionUpdate(track.regionStartRatio * track.buffer.duration);
      setStatus(`Track 0${track.index + 1} IN pinned at ${formatTimeTenths(track.regionStartRatio * track.buffer.duration)}.`, 'info');
    });

    track.ui.regionPinOutBtn.addEventListener('click', () => {
      if (!track.buffer || track.buffer.duration <= 0) return;
      const ratio = getTrackPosition(track) / track.buffer.duration;
      track.regionEndRatio = Math.min(1, Math.max(ratio, Math.min(1, track.regionStartRatio + getMinGapRatio())));
      if (!track.loop) track.loop = true;
      track.regionLoopEnabled = true;
      applyRegionUpdate(track.regionStartRatio * track.buffer.duration);
      setStatus(`Looping Track 0${track.index + 1} portion ${formatTimeTenths(track.regionStartRatio * track.buffer.duration)} – ${formatTimeTenths(track.regionEndRatio * track.buffer.duration)}.`, 'success');
    });

    track.ui.regionLoopBtn.addEventListener('click', () => {
      track.regionLoopEnabled = !track.regionLoopEnabled;
      if (track.regionLoopEnabled && !track.loop) {
        track.loop = true;
      }
      applyRegionUpdate(null);
      setStatus(
        track.regionLoopEnabled
          ? `Selected portion loop ON for Track 0${track.index + 1}.`
          : `Full-track loop mode for Track 0${track.index + 1}.`,
        'info'
      );
    });

    track.ui.cropRegionBtn.addEventListener('click', () => handleCropRegion(track));

    track.ui.regionResetBtn.addEventListener('click', () => {
      if (!track.buffer) return;
      track.regionStartRatio = 0;
      track.regionEndRatio = 1;
      applyRegionUpdate(null);
      setStatus(`Reset Track 0${track.index + 1} IN / OUT selection to full track.`, 'info');
    });

    track.ui.saveLibBtn.addEventListener('click', () => handleSaveTrackToLibrary(track));

    // Interactive Click & Drag Waveform Seeking
    let isDraggingWave = false;
    let dragViewport = null;
    const seekFromWavePointer = (clientX, commitPlay) => {
      if (!track.buffer) return;
      const rect = track.ui.waveformCanvas.getBoundingClientRect();
      const localRatio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const viewport = dragViewport || getWaveformViewport(track);
      const ratio = Math.max(0, Math.min(1, viewport.startRatio + localRatio * (viewport.endRatio - viewport.startRatio)));
      const sec = ratio * track.buffer.duration;
      if (commitPlay) {
        seekTrackTo(track, sec);
      } else {
        track.offset = sec;
        track.ui.elapsedEl.textContent = formatTimeTenths(sec);
        track.ui.scrubInput.value = String(ratio * 1000);
        drawTrackWaveform(track);
      }
    };

    track.ui.waveformCanvas.addEventListener('pointerdown', (e) => {
      if (!track.buffer) return;
      isDraggingWave = true;
      dragViewport = getWaveformViewport(track);
      track.isScrubbing = true;
      track.ui.waveformCanvas.setPointerCapture(e.pointerId);
      seekFromWavePointer(e.clientX, false);
    });
    track.ui.waveformCanvas.addEventListener('pointermove', (e) => {
      if (!isDraggingWave) return;
      seekFromWavePointer(e.clientX, false);
    });
    const endWaveDrag = (e) => {
      if (!isDraggingWave) return;
      isDraggingWave = false;
      track.isScrubbing = false;
      if (track.ui.waveformCanvas.hasPointerCapture(e.pointerId)) {
        track.ui.waveformCanvas.releasePointerCapture(e.pointerId);
      }
      seekFromWavePointer(e.clientX, true);
      dragViewport = null;
    };
    track.ui.waveformCanvas.addEventListener('pointerup', endWaveDrag);
    track.ui.waveformCanvas.addEventListener('pointercancel', endWaveDrag);

    track.ui.remixPromptInput.addEventListener('input', () => {
      track.remixPrompt = track.ui.remixPromptInput.value;
    });

    // Voice Tuner Events
    track.ui.pitchSlider.addEventListener('input', () => {
      track.pitchSemitones = parseInt(track.ui.pitchSlider.value, 10);
      updateTrackTuner(track);
      renderTrackUI(track);
    });
    track.ui.pitchValEl.addEventListener('click', () => {
      track.pitchSemitones = 0;
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    track.ui.fineSlider.addEventListener('input', () => {
      track.fineCents = parseInt(track.ui.fineSlider.value, 10);
      updateTrackTuner(track);
      renderTrackUI(track);
    });
    track.ui.fineValEl.addEventListener('click', () => {
      track.fineCents = 0;
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    track.ui.toneSlider.addEventListener('input', () => {
      track.vocalToneDb = parseFloat(track.ui.toneSlider.value);
      updateTrackTuner(track);
      renderTrackUI(track);
    });
    track.ui.toneValEl.addEventListener('click', () => {
      track.vocalToneDb = 0;
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    track.ui.autoTuneSelect.addEventListener('change', () => {
      track.autoTuneMode = parseInt(track.ui.autoTuneSelect.value, 10);
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    track.ui.tunerKeySelect.addEventListener('change', () => {
      track.tunerKey = parseInt(track.ui.tunerKeySelect.value, 10);
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    track.ui.doublerBtn.addEventListener('click', () => {
      track.doublerEnabled = !track.doublerEnabled;
      updateTrackTuner(track);
      renderTrackUI(track);
    });

    // Scrubbing / Seeking (with isScrubbing lock so rAF never fights drag)
    track.ui.scrubInput.addEventListener('pointerdown', () => {
      track.isScrubbing = true;
    });
    track.ui.scrubInput.addEventListener('pointerup', () => {
      track.isScrubbing = false;
    });
    track.ui.scrubInput.addEventListener('pointercancel', () => {
      track.isScrubbing = false;
    });
    track.ui.scrubInput.addEventListener('input', () => {
      if (!track.buffer) return;
      track.isScrubbing = true;
      const ratio = parseFloat(track.ui.scrubInput.value) / 1000;
      const newOffset = ratio * track.buffer.duration;
      track.ui.elapsedEl.textContent = formatTime(newOffset);
    });

    track.ui.scrubInput.addEventListener('change', async () => {
      track.isScrubbing = false;
      if (!track.buffer) return;
      const ratio = parseFloat(track.ui.scrubInput.value) / 1000;
      await seekTrackTo(track, ratio * track.buffer.duration);
    });

    // Volume Slider
    track.ui.volumeSlider.addEventListener('input', () => {
      track.volume = parseFloat(track.ui.volumeSlider.value);
      updateTrackVolume(track);
      renderTrackUI(track);
    });

    // Lo-Fi Filter Toggle
    track.ui.lofiBtn.addEventListener('click', () => {
      track.lofiEnabled = !track.lofiEnabled;
      updateTrackFilter(track);
      renderTrackUI(track);
    });

    // Rotary Reverb Dial (Pointer drag, wheel, keyboard, double-click reset)
    let isDraggingDial = false;
    let dragStartY = 0;
    let dragStartMix = 0;

    const setReverbMix = (nextMix) => {
      track.reverbMix = Math.max(0, Math.min(1, nextMix));
      updateTrackReverb(track);
      renderTrackUI(track);
    };

    track.ui.reverbDial.addEventListener('pointerdown', (e) => {
      isDraggingDial = true;
      dragStartY = e.clientY;
      dragStartMix = track.reverbMix;
      track.ui.reverbDial.setPointerCapture(e.pointerId);
      track.ui.reverbDial.focus();
    });

    track.ui.reverbDial.addEventListener('pointermove', (e) => {
      if (!isDraggingDial) return;
      const deltaY = dragStartY - e.clientY;
      setReverbMix(dragStartMix + deltaY / 140);
    });

    const endDialDrag = (e) => {
      if (!isDraggingDial) return;
      isDraggingDial = false;
      if (track.ui.reverbDial.hasPointerCapture(e.pointerId)) {
        track.ui.reverbDial.releasePointerCapture(e.pointerId);
      }
    };

    track.ui.reverbDial.addEventListener('pointerup', endDialDrag);
    track.ui.reverbDial.addEventListener('pointercancel', endDialDrag);

    track.ui.reverbDial.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.04 : -0.04;
      setReverbMix(track.reverbMix + step);
    }, { passive: false });

    track.ui.reverbDial.addEventListener('dblclick', () => setReverbMix(0));

    track.ui.reverbDial.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        setReverbMix(track.reverbMix + 0.05);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setReverbMix(track.reverbMix - 0.05);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setReverbMix(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setReverbMix(1);
      }
    });

    // Local File Input & Drag/Drop
    track.ui.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        loadLocalFileIntoTrack(track, file);
      }
      e.target.value = '';
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        loadLocalFileIntoTrack(track, file);
        return;
      }
      const droppedUrl = extractDroppedUrl(e.dataTransfer);
      if (droppedUrl) {
        extractYouTubeIntoTrack(droppedUrl, track, { enableLofi: false });
      }
    });

    tracks.push(track);
    tracksGrid.appendChild(card);
    renderTrackUI(track);
    drawTrackWaveform(track);
  }

  function extractDroppedUrl(dataTransfer) {
    if (!dataTransfer) return '';
    const raw = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') || '';
    const line = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    if (!line) return '';
    return /youtube\.com|youtu\.be/i.test(line) ? line : '';
  }

  // ---------------- Lo-Fi Sample Generator Controls ----------------
  genPresetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPreset = btn.dataset.preset;
      if (btn.dataset.defaultBpm) {
        genBpmInput.value = btn.dataset.defaultBpm;
      }
      genPresetButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', String(active));
      });
    });
  });

  function stopPreview() {
    if (!previewSource) return;
    const old = previewSource;
    previewSource = null;
    old.onended = null;
    try {
      old.stop();
    } catch {
      // Ignore
    }
    try {
      old.disconnect();
    } catch {
      // Ignore
    }
    genPreviewBtn.classList.remove('playing');
    genPreviewBtn.textContent = '▶ PREVIEW SAMPLE';
  }

  function getGeneratorConfig() {
    return {
      preset: selectedPreset,
      keyIndex: parseInt(genKeySelect.value, 10),
      scale: genScaleSelect.value,
      bpm: parseInt(genBpmInput.value, 10) || 78,
      bars: parseInt(genBarsSelect.value, 10) || 4
    };
  }

  genPreviewBtn.addEventListener('click', async () => {
    if (previewSource) {
      stopPreview();
      return;
    }

    genPreviewBtn.disabled = true;
    try {
      await ensureAudioEngine();
      const cfg = getGeneratorConfig();
      const { buffer, title } = await window.LofiGenerator.generateSample({
        ...cfg,
        sampleRate: audioCtx.sampleRate
      });

      stopPreview();
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(masterGain);
      src.onended = () => {
        if (previewSource === src) stopPreview();
      };
      previewSource = src;
      src.start(0);

      genPreviewBtn.classList.add('playing');
      genPreviewBtn.textContent = '■ STOP PREVIEW';
      setStatus(`Previewing "${title}" — click "Generate & Load Track" to drop it into the mixer.`, 'info');
    } catch (err) {
      console.error('Sample preview error:', err);
      setStatus('Failed to generate sample preview.', 'error');
    } finally {
      genPreviewBtn.disabled = false;
    }
  });

  genLoadBtn.addEventListener('click', async () => {
    stopPreview();
    const targetVal = genTargetSelect.value;
    let targetTrack = null;

    if (targetVal === 'auto') {
      targetTrack = findFirstEmptyTrack();
      if (!targetTrack) {
        setStatus('All 4 tracks are occupied. Select a specific Target Slot or clear (✕) a track.', 'error');
        return;
      }
    } else {
      targetTrack = tracks[parseInt(targetVal, 10)] || null;
    }

    if (!targetTrack) return;

    genLoadBtn.disabled = true;
    try {
      await ensureAudioEngine();
      const cfg = getGeneratorConfig();
      setStatus(`Synthesizing Lo-Fi "${cfg.preset}" loop for Track ${targetTrack.index + 1}...`, 'info');
      const { buffer, title } = await window.LofiGenerator.generateSample({
        ...cfg,
        sampleRate: audioCtx.sampleRate
      });

      loadBufferIntoTrack(targetTrack, buffer, title);
      setStatus(`Generated "${title}" into Track ${targetTrack.index + 1} (${formatTime(buffer.duration)} loop).`, 'success');
    } catch (err) {
      console.error('Sample generation error:', err);
      setStatus('Failed to generate Lo-Fi sample.', 'error');
    } finally {
      genLoadBtn.disabled = false;
    }
  });

  // ---------------- Gemini AI Remix Director ----------------
  function clearRemixTimers() {
    remixTimers.forEach((id) => clearTimeout(id));
    remixTimers = [];
  }

  async function checkGeminiStatus() {
    try {
      const res = await fetch('/api/gemini-status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.configured) {
        geminiKeyBadge.textContent = 'GEMINI 3.5 FLASH • SERVER KEY READY';
        geminiKeyBadge.classList.add('ready');
        geminiKeyWrap.hidden = true;
        remixInputsRow.classList.add('no-key-input');
      }
    } catch {
      // Ignore if offline
    }
  }

  async function checkStemEngineStatus() {
    try {
      const res = await fetch('/api/stem-engine-status');
      if (!res.ok) return;
      const data = await res.json();
      neuralEngineReady = Boolean(data.neuralAvailable);
      neuralMultiStemReady = Boolean(data.multiStemAvailable);
      if (data.model) {
        neuralModelLabel = data.model;
      }
      tracks.forEach((track) => {
        if (track.ui.stemEngineTag) {
          track.ui.stemEngineTag.textContent = neuralEngineReady
            ? (neuralMultiStemReady ? 'STEM AI // ROFORMER + KARAOKE' : 'STEM EXTRACT // BS-ROFORMER (AI)')
            : 'STEM EXTRACT // EDIT';
          track.ui.stemEngineTag.classList.toggle('ai-ready', neuralEngineReady);
        }
      });
    } catch {
      // Ignore if offline
    }
  }

  const savedSessionKey = sessionStorage.getItem('tape4_gemini_key');
  if (savedSessionKey && geminiApiKeyInput) {
    geminiApiKeyInput.value = savedSessionKey;
  }
  if (geminiApiKeyInput) {
    geminiApiKeyInput.addEventListener('input', () => {
      sessionStorage.setItem('tape4_gemini_key', geminiApiKeyInput.value.trim());
    });
  }

  async function executeRemixPlan(plan) {
    await ensureAudioEngine();

    // Update master volume
    if (Number.isFinite(plan.masterVolume)) {
      masterVolumeSlider.value = String(plan.masterVolume);
      masterVolVal.textContent = `${Math.round(plan.masterVolume * 100)}%`;
      if (masterGain) {
        masterGain.gain.setTargetAtTime(plan.masterVolume, audioCtx.currentTime, 0.02);
      }
    }

    // Optional background generation requested by Gemini
    if (plan.generateBackground && plan.generateBackground.shouldGenerate) {
      const gb = plan.generateBackground;
      const targetIdx = Math.max(0, Math.min(3, gb.targetTrackIndex));
      const targetTrack = tracks[targetIdx];
      if (targetTrack && !targetTrack.buffer) {
        setStatus(`Gemini is generating a ${gb.preset} Lo-Fi loop for Track 0${targetIdx + 1}...`, 'info');
        const { buffer, title } = await window.LofiGenerator.generateSample({
          preset: gb.preset,
          keyIndex: gb.keyIndex,
          scale: gb.scale,
          bpm: gb.bpm,
          bars: gb.bars,
          sampleRate: audioCtx.sampleRate
        });
        loadBufferIntoTrack(targetTrack, buffer, title);
      }
    }

    // Apply per-track slices, DSP, tuner, and FX
    for (const item of plan.tracks || []) {
      const track = tracks[item.trackIndex];
      if (!track) continue;

      stopTrack(track);
      track.remixIncluded = Boolean(item.include);
      track.startDelaySec = Number(item.startDelaySec) || 0;
      track.remixReason = item.reason || '';

      const sourceBuf = track.originalBuffer || track.buffer;
      if (!sourceBuf) {
        renderTrackUI(track);
        continue;
      }

      if (!item.include) {
        renderTrackUI(track);
        continue;
      }

      let processed = sourceBuf;
      const isPartialSlice = item.sliceStartSec > 0.05 || (item.sliceEndSec > 0 && item.sliceEndSec < sourceBuf.duration - 0.05);
      if (isPartialSlice) {
        processed = window.VocalDSP.sliceAudioBuffer(audioCtx, processed, item.sliceStartSec, item.sliceEndSec);
      }

      if (item.extractVoice) {
        setStatus(`Gemini Remix: isolating vocals on Track 0${track.index + 1}...`, 'info');
        processed = await window.VocalDSP.extractVocalsFromBuffer(audioCtx, processed);
        track.stemMode = 'voice';
        track.voiceExtracted = true;
        track.musicExtracted = false;
      } else {
        track.stemMode = 'mix';
        track.voiceExtracted = false;
        track.musicExtracted = false;
      }

      if (item.trimSilence) {
        const trimmedRes = window.VocalDSP.trimSilenceFromBuffer(audioCtx, processed);
        if (!trimmedRes.wasAllSilent && trimmedRes.buffer) {
          processed = trimmedRes.buffer;
          track.silenceTrimmed = true;
        }
      } else {
        track.silenceTrimmed = false;
      }

      const baseTitle = track.title.replace(/\s*\[REMIX\]|\s*\[VOCAL\]|\s*\[TRIMMED\]/g, '');
      const tags = [
        isPartialSlice ? `${formatTime(item.sliceStartSec)}-${formatTime(item.sliceEndSec)}` : '',
        track.voiceExtracted ? 'VOCAL' : '',
        track.silenceTrimmed ? 'TRIMMED' : ''
      ].filter(Boolean).join(' • ');
      const nextTitle = tags ? `${baseTitle} [${tags}]` : baseTitle;

      loadBufferIntoTrack(track, processed, nextTitle, { preserveOriginal: true });

      track.loop = Boolean(item.loop);
      track.volume = Number(item.volume);
      track.lofiEnabled = Boolean(item.lofiEnabled);
      track.reverbMix = Number(item.reverbMix);
      track.pitchSemitones = Number(item.pitchSemitones);
      track.fineCents = Number(item.fineCents);
      track.autoTuneMode = Number(item.autoTuneMode);
      track.tunerKey = Number(item.tunerKey);
      track.vocalToneDb = Number(item.vocalToneDb);
      track.doublerEnabled = Boolean(item.doublerEnabled);

      initTrackAudioNodes(track);
      updateTrackVolume(track);
      updateTrackFilter(track);
      updateTrackReverb(track);
      updateTrackTuner(track);
      renderTrackUI(track);
    }

    if (plan.remixSummary) {
      remixSummaryText.textContent = plan.remixSummary;
      remixSummaryBar.hidden = false;
    }
  }

  async function playRemixWithStagger() {
    clearRemixTimers();
    stopPreview();
    await ensureAudioEngine();

    const activeTracks = tracks.filter((t) => Boolean(t.buffer) && t.remixIncluded !== false);
    if (!activeTracks.length) {
      setStatus('No included tracks ready to play. Load tracks or build a remix first.', 'info');
      return;
    }

    tracks.forEach((t) => {
      if (t.buffer) stopTrack(t);
    });

    activeTracks.forEach((t) => {
      const delayMs = Math.max(0, Math.round((t.startDelaySec || 0) * 1000));
      if (delayMs === 0) {
        playTrack(t);
      } else {
        const timerId = setTimeout(() => {
          playTrack(t);
        }, delayMs);
        remixTimers.push(timerId);
      }
    });

    setStatus(`Playing remix (${activeTracks.length} track${activeTracks.length > 1 ? 's' : ''} active).`, 'success');
  }

  remixBuildBtn.addEventListener('click', async () => {
    clearRemixTimers();
    stopPreview();

    const globalPrompt = remixGlobalPromptInput.value.trim();
    const anyTrackPrompt = tracks.some((t) => t.remixPrompt.trim().length > 0);
    if (!globalPrompt && !anyTrackPrompt) {
      setStatus('Enter a global remix prompt or tell Gemini what to take on at least one track.', 'error');
      remixGlobalPromptInput.focus();
      return;
    }

    remixBuildBtn.disabled = true;
    remixBuildBtn.classList.add('loading');
    setStatus('Analyzing tracks & sending remix instructions to Gemini...', 'info');

    try {
      await ensureAudioEngine();
      const sendAudio = Boolean(geminiSendAudioCheckbox && geminiSendAudioCheckbox.checked);

      const trackPayloads = tracks.map((t) => {
        const sourceBuf = t.originalBuffer || t.buffer;
        return {
          trackIndex: t.index,
          loaded: Boolean(sourceBuf),
          title: t.title.replace(/\s*\[.*?\]/g, '').trim(),
          durationSec: sourceBuf ? sourceBuf.duration : 0,
          prompt: t.remixPrompt.trim(),
          energyProfile: sourceBuf ? window.VocalDSP.computeEnergyProfile(sourceBuf, 1) : [],
          audioBase64: (sourceBuf && sendAudio)
            ? window.VocalDSP.encodeCompactWavBase64(sourceBuf, 90, 8000)
            : '',
          currentState: {
            volume: t.volume,
            lofiEnabled: t.lofiEnabled,
            reverbMix: t.reverbMix,
            pitchSemitones: t.pitchSemitones,
            fineCents: t.fineCents,
            autoTuneMode: t.autoTuneMode,
            tunerKey: t.tunerKey,
            vocalToneDb: t.vocalToneDb,
            doublerEnabled: t.doublerEnabled,
            loop: t.loop
          }
        };
      });

      const res = await fetch('/api/remix-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          globalPrompt,
          tracks: trackPayloads,
          apiKey: geminiApiKeyInput ? geminiApiKeyInput.value.trim() : ''
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.details ? `${data.error} (${data.details})` : (data.error || `HTTP ${res.status}`);
        throw new Error(msg);
      }

      await executeRemixPlan(data.plan);
      setStatus('Gemini remix plan applied! Click "▶ PLAY REMIX" to listen.', 'success');
    } catch (err) {
      console.error('Gemini remix build failed:', err);
      setStatus(err.message || 'Failed to build remix with Gemini.', 'error');
    } finally {
      remixBuildBtn.disabled = false;
      remixBuildBtn.classList.remove('loading');
    }
  });

  remixPlayBtn.addEventListener('click', playRemixWithStagger);

  remixRevertBtn.addEventListener('click', () => {
    clearRemixTimers();
    stopPreview();
    tracks.forEach((t) => {
      if (t.buffer) stopTrack(t);
      t.remixIncluded = true;
      t.startDelaySec = 0;
      t.remixReason = '';
      if (t.originalBuffer && t.buffer !== t.originalBuffer) {
        const cleanTitle = t.title.replace(/\s*\[.*?\]/g, '').trim();
        t.voiceExtracted = false;
        t.musicExtracted = false;
        t.stemMode = 'mix';
        t.croppedRegion = false;
        t.silenceTrimmed = false;
        t.preStemBuffer = t.originalBuffer;
        loadBufferIntoTrack(t, t.originalBuffer, cleanTitle, { preserveOriginal: true });
      } else {
        renderTrackUI(t);
      }
    });
    remixSummaryBar.hidden = true;
    remixSummaryText.textContent = '';
    setStatus('Reverted all tracks back to their original audio.', 'info');
  });

  // Master Controls
  masterVolumeSlider.addEventListener('input', () => {
    const val = parseFloat(masterVolumeSlider.value);
    masterVolVal.textContent = `${Math.round(val * 100)}%`;
    if (masterGain && audioCtx) {
      masterGain.gain.setTargetAtTime(val, audioCtx.currentTime, 0.015);
    }
  });

  masterPlayAllBtn.addEventListener('click', async () => {
    clearRemixTimers();
    stopPreview();
    const loadedTracks = tracks.filter((t) => Boolean(t.buffer));
    if (!loadedTracks.length) {
      setStatus('No tracks loaded yet. Extract a YouTube URL or generate a Lo-Fi sample first.', 'info');
      return;
    }
    await Promise.all(loadedTracks.map((t) => playTrack(t)));
  });

  masterStopAllBtn.addEventListener('click', () => {
    clearRemixTimers();
    stopPreview();
    tracks.forEach((t) => {
      if (t.buffer) stopTrack(t);
    });
  });

  async function bounceMasterMix() {
    const active = tracks.filter((t) => Boolean(t.buffer) && t.remixIncluded !== false && t.volume > 0.001);
    if (!active.length) {
      setStatus('Load at least one active track with volume > 0% before bouncing a mixdown.', 'error');
      return null;
    }

    await ensureAudioEngine();
    if (masterBounceBtn) masterBounceBtn.disabled = true;

    try {
      // Determine target mixdown duration: longest active non-looping deck (or longest deck capped cleanly at 180s)
      const trackPlans = active.map((t) => {
        const { startSec, endSec, hasSelection } = getRegionBoundsSec(t);
        const useRegion = t.regionLoopEnabled && hasSelection && (endSec - startSec >= 0.05);
        const clipStart = useRegion ? startSec : 0;
        const clipLen = useRegion ? Math.max(0.1, endSec - startSec) : t.buffer.duration;
        const rate = Math.pow(2, (t.pitchSemitones + t.fineCents / 100) / 12);
        const playDur = clipLen / rate;
        const delay = Math.max(0, Number(t.startDelaySec) || 0);
        return { t, clipStart, clipLen, rate, playDur, delay, isLoop: Boolean(t.loop) };
      });

      const nonLoopPlans = trackPlans.filter((p) => !p.isLoop);
      const rawDuration = nonLoopPlans.length
        ? Math.max(...nonLoopPlans.map((p) => p.delay + p.playDur))
        : Math.max(...trackPlans.map((p) => p.delay + p.playDur));
      const mixDuration = Math.min(240, Math.max(1, rawDuration));

      setStatus(`Rendering ${formatTime(mixDuration)} stereo mixdown across ${active.length} deck(s)...`, 'info');
      const sr = audioCtx.sampleRate || 44100;
      const offCtx = new OfflineAudioContext(2, Math.ceil(mixDuration * sr), sr);
      const offMaster = offCtx.createGain();
      offMaster.gain.value = parseFloat(masterVolumeSlider.value) || 0.85;
      offMaster.connect(offCtx.destination);
      const offImpulse = createImpulseResponse(offCtx);

      for (const p of trackPlans) {
        const { t, clipStart, clipLen, rate, playDur, delay, isLoop } = p;
        const voiceEq = offCtx.createBiquadFilter();
        voiceEq.type = 'peaking';
        voiceEq.frequency.value = 2800;
        voiceEq.Q.value = 0.9;
        voiceEq.gain.value = t.vocalToneDb || 0;

        const postFilter = offCtx.createGain();
        const lofiFilter = offCtx.createBiquadFilter();
        lofiFilter.type = 'lowpass';
        lofiFilter.frequency.value = LOFI_CUTOFF_HZ;
        lofiFilter.Q.value = LOFI_Q;
        const fDry = offCtx.createGain();
        const fWet = offCtx.createGain();
        fDry.gain.value = t.lofiEnabled ? 0 : 1;
        fWet.gain.value = t.lofiEnabled ? 1 : 0;

        const revDry = offCtx.createGain();
        const revWet = offCtx.createGain();
        const rMix = t.reverbMix || 0;
        revDry.gain.value = Math.cos(rMix * Math.PI * 0.5);
        revWet.gain.value = Math.sin(rMix * Math.PI * 0.5);
        const conv = offCtx.createConvolver();
        conv.buffer = offImpulse;

        const trGain = offCtx.createGain();
        trGain.gain.value = t.volume;

        voiceEq.connect(fDry);
        fDry.connect(postFilter);
        voiceEq.connect(lofiFilter);
        lofiFilter.connect(fWet);
        fWet.connect(postFilter);
        postFilter.connect(revDry);
        revDry.connect(trGain);
        postFilter.connect(conv);
        conv.connect(revWet);
        revWet.connect(trGain);
        trGain.connect(offMaster);

        if (isLoop) {
          let cursor = delay;
          while (cursor < mixDuration - 0.02) {
            const src = offCtx.createBufferSource();
            src.buffer = t.buffer;
            src.playbackRate.value = rate;
            src.connect(voiceEq);
            const segAvail = Math.min(clipLen, (mixDuration - cursor) * rate);
            src.start(cursor, clipStart, segAvail);
            cursor += playDur;
          }
        } else if (delay < mixDuration) {
          const src = offCtx.createBufferSource();
          src.buffer = t.buffer;
          src.playbackRate.value = rate;
          src.connect(voiceEq);
          src.start(delay, clipStart, Math.min(clipLen, (mixDuration - delay) * rate));
        }
      }

      const rendered = await offCtx.startRendering();
      // Peak guard to prevent harsh clipping when summing 3-4 decks
      let peak = 0;
      for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
        const data = rendered.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const a = Math.abs(data[i]);
          if (a > peak) peak = a;
        }
      }
      if (peak > 0.96) {
        const g = 0.94 / peak;
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
          const data = rendered.getChannelData(ch);
          for (let i = 0; i < data.length; i++) data[i] *= g;
        }
      }

      const leadTrack = active[0];
      const baseMixName = (leadTrack.title || 'TAPE4 Mix')
        .replace(/\s*\[(VOICE ONLY|VOCALS|MUSIC ONLY|LEAD VOCAL|CHORUS|INSTRUMENTS|AI BEAT|TRIMMED|CROPPED.*?)\]/g, '')
        .trim()
        .slice(0, 36) || 'TAPE4';
      const mixTitle = `${baseMixName} Mix (${active.length}T) [MIXDOWN]`;
      const savedItem = await saveBufferToLibrary(rendered, {
        title: mixTitle,
        stemType: 'mix',
        silent: true
      });

      if (savedItem?.id) {
        const dl = document.createElement('a');
        dl.href = `/api/library/${encodeURIComponent(savedItem.id)}/audio?download=1`;
        dl.download = savedItem.filename || `${baseMixName}_mix.wav`;
        document.body.appendChild(dl);
        dl.click();
        dl.remove();
        setStatus(`Bounced ${formatTime(mixDuration)} stereo mixdown to ./library/${savedItem.relPath || savedItem.filename} & started WAV download!`, 'success');
      } else {
        setStatus(`Rendered ${formatTime(mixDuration)} stereo mixdown.`, 'success');
      }
      return savedItem;
    } catch (err) {
      console.error('Bounce mixdown failed:', err);
      setStatus(`Mixdown failed: ${err.message}`, 'error');
      return null;
    } finally {
      if (masterBounceBtn) masterBounceBtn.disabled = false;
    }
  }

  if (masterBounceBtn) {
    masterBounceBtn.addEventListener('click', () => bounceMasterMix());
  }

  // Shared YouTube Extraction Helper
  async function extractYouTubeIntoTrack(url, preferredTrack = null, { enableLofi = false, buttonEl = null } = {}) {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) {
      setStatus('Please paste or drop a valid YouTube URL first.', 'error');
      return false;
    }

    const targetTrack = preferredTrack || findFirstEmptyTrack();
    if (!targetTrack) {
      setStatus('All 4 tracks are currently occupied. Clear (✕) a track or pick a specific Target Slot.', 'error');
      return false;
    }

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.classList.add('loading');
    }
    setStatus(`Extracting audio & converting to MP3 for Track ${targetTrack.index + 1}...`, 'info');

    try {
      await ensureAudioEngine();

      const response = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      });

      if (!response.ok) {
        let errorMsg = `Extraction failed (HTTP ${response.status}).`;
        try {
          const payload = await response.json();
          if (payload && payload.error) {
            errorMsg = payload.details ? `${payload.error} (${payload.details})` : payload.error;
          }
        } catch {
          // Keep fallback
        }
        throw new Error(errorMsg);
      }

      const rawHeaderTitle = response.headers.get('X-Track-Title');
      const trackTitle = rawHeaderTitle ? decodeURIComponent(rawHeaderTitle) : 'YouTube Sample';
      const extractLibId = response.headers.get('X-Library-Id') || null;
      const fromCache = response.headers.get('X-From-Cache') === 'true';

      const audioBlob = await response.blob();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const slot = preferredTrack || (!targetTrack.buffer ? targetTrack : findFirstEmptyTrack());
      if (!slot) {
        throw new Error('All 4 track slots filled while extraction was running.');
      }

      loadBufferIntoTrack(slot, audioBuffer, trackTitle, { sourceUrl: cleanUrl, libraryId: extractLibId });
      if (enableLofi) {
        slot.lofiEnabled = true;
        slot.loop = true;
        initTrackAudioNodes(slot);
        updateTrackFilter(slot);
        renderTrackUI(slot);
      }
      fetchLibrary({ silent: true });
      setStatus(
        `${fromCache ? 'Loaded cached' : 'Extracted & saved'} "${trackTitle}" into Track ${slot.index + 1}${enableLofi ? ' (Lo-Fi Filter + Loop ON)' : ''}.`,
        'success'
      );
      return true;
    } catch (err) {
      console.error('Extract & Load error:', err);
      setStatus(err.message || 'Failed to extract audio from YouTube.', 'error');
      return false;
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.classList.remove('loading');
      }
    }
  }

  // Global Top YouTube Extraction Form Submit
  extractForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = youtubeUrlInput.value.trim();
    if (!url) {
      setStatus('Please paste a valid YouTube URL first.', 'error');
      youtubeUrlInput.focus();
      return;
    }
    const ok = await extractYouTubeIntoTrack(url, null, { enableLofi: false, buttonEl: extractBtn });
    if (ok) {
      youtubeUrlInput.value = '';
    }
  });

  // YouTube Style Sampler: extracts instruments, analyzes BPM/Key/Groove, & generates fresh style-matched beats
  async function handleYouTubeStyleSample(url, preferredTrack = null) {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) {
      setStatus('Drop or paste a YouTube link into the YT STYLE box first.', 'error');
      return false;
    }

    const slot = preferredTrack || findFirstEmptyTrack();
    if (!slot) {
      setStatus('All 4 tracks are occupied. Clear (✕) a track or choose a specific Target Slot.', 'error');
      return false;
    }

    const mode = ytSampleModeSelect ? ytSampleModeSelect.value : 'generate_style_beat';
    const styleMode = ytSampleStyleModeSelect ? ytSampleStyleModeSelect.value : 'lofi_clone';
    const btn = ytSampleBtn;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('loading');
    }

    try {
      await ensureAudioEngine();
      setStatus('Fetching YouTube audio reference into project library...', 'info');
      const extractRes = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl })
      });
      if (!extractRes.ok) {
        const errP = await extractRes.json().catch(() => ({}));
        throw new Error(errP.details || errP.error || `Extract failed (HTTP ${extractRes.status})`);
      }

      const libraryId = extractRes.headers.get('X-Library-Id');
      const rawTitle = extractRes.headers.get('X-Track-Title');
      const trackTitle = rawTitle ? decodeURIComponent(rawTitle) : 'YouTube Reference';
      // Consume/discard stream if generating beats rather than loading raw audio
      await extractRes.arrayBuffer();

      if (!libraryId) {
        throw new Error('Could not resolve library ID for extracted reference track.');
      }

      if (!neuralEngineReady) {
        await checkStemEngineStatus();
      }
      if (!neuralEngineReady) {
        throw new Error('Neural stem/style engine is not active on server.');
      }

      setStatus(
        `Separating backing instruments & analyzing BPM / Key / Drum Groove from "${trackTitle}"...`,
        'info'
      );

      const styleRes = await fetch('/api/analyze-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libraryId,
          separateFirst: true,
          startSec: 20,
          clipDurationSec: 32
        })
      });
      if (!styleRes.ok) {
        const errS = await styleRes.json().catch(() => ({}));
        throw new Error(errS.details || errS.error || `Style analysis failed (HTTP ${styleRes.status})`);
      }

      const styleData = await styleRes.json();
      const sp = styleData.styleProfile;
      const stems = styleData.stems || {};
      if (sp) {
        currentStyleProfile = sp;
        currentStyleRefTitle = trackTitle;
        renderStyleDnaBadge();
      }

      if (mode === 'raw_instruments' && stems.music?.audioUrl) {
        const instFetch = await fetch(stems.music.audioUrl);
        if (!instFetch.ok) throw new Error(`HTTP ${instFetch.status}`);
        const instBuf = await audioCtx.decodeAudioData(await instFetch.arrayBuffer());
        loadBufferIntoTrack(slot, instBuf, stems.music.title, { sourceUrl: cleanUrl });
        slot.stemMode = 'music';
        slot.musicExtracted = true;
        renderTrackUI(slot);
        drawTrackWaveform(slot);
        await fetchLibrary({ silent: true });
        autoSelectStudioComponents({ refId: stems.music.id });
        setStatus(`Loaded clean BS-RoFormer Instruments stem ("${stems.music.title}") into Track 0${slot.index + 1}.`, 'success');
        return true;
      }

      const targetBars = Math.max(2, Math.min(8, parseInt(genBarsSelect.value, 10) || 4));
      const { buffer: beatBuf, title: beatTitle } = await window.LofiGenerator.generateStyleMatchedSample({
        styleProfile: sp || {},
        styleMode,
        bars: targetBars,
        referenceLabel: trackTitle
      });

      loadBufferIntoTrack(slot, beatBuf, beatTitle, { sourceUrl: cleanUrl });
      slot.stemMode = 'beat';
      slot.loop = true;
      renderTrackUI(slot);
      drawTrackWaveform(slot);

      await saveBufferToLibrary(beatBuf, { title: beatTitle, stemType: 'beat', sourceUrl: cleanUrl, silent: true });
      await fetchLibrary({ silent: true });
      autoSelectStudioComponents({
        leadId: mode === 'decompose_3stem' ? stems.lead?.id : null,
        chorusId: mode === 'decompose_3stem' ? stems.chorus?.id : null,
        refId: stems.music?.id || libraryId
      });

      setStatus(
        `Generated "${beatTitle}" in style of "${trackTitle}" (${sp?.bpm || 84} BPM, ${sp?.keyName || 'F'} ${sp?.scale || 'minor'}) -> Track 0${slot.index + 1}!`,
        'success'
      );
      return true;
    } catch (err) {
      console.error('YouTube style sampling failed:', err);
      setStatus(`Style sampling failed: ${err.message}`, 'error');
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }
  }

  // Lo-Fi Style Generator YouTube Link Form & Dropzone
  if (ytSampleForm) {
    ytSampleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = ytSampleUrlInput.value.trim();
      if (!url) {
        setStatus('Drop or paste a YouTube link into the YT STYLE box first.', 'error');
        ytSampleUrlInput.focus();
        return;
      }
      const targetVal = genTargetSelect.value;
      const targetTrack = targetVal === 'auto' ? null : (tracks[parseInt(targetVal, 10)] || null);
      const ok = await handleYouTubeStyleSample(url, targetTrack);
      if (ok) {
        ytSampleUrlInput.value = '';
      }
    });
  }

  if (ytSampleDropzone) {
    ytSampleDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      ytSampleDropzone.classList.add('drag-over');
    });
    ytSampleDropzone.addEventListener('dragleave', () => {
      ytSampleDropzone.classList.remove('drag-over');
    });
    ytSampleDropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      ytSampleDropzone.classList.remove('drag-over');
      const droppedUrl = extractDroppedUrl(e.dataTransfer);
      if (droppedUrl) {
        ytSampleUrlInput.value = droppedUrl;
        const targetVal = genTargetSelect.value;
        const targetTrack = targetVal === 'auto' ? null : (tracks[parseInt(targetVal, 10)] || null);
        const ok = await handleYouTubeStyleSample(droppedUrl, targetTrack);
        if (ok) ytSampleUrlInput.value = '';
      }
    });
  }

  // Real-Time Visualizer + Track Playhead Animation Loop
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = visualizerCanvas.getBoundingClientRect();
    const targetW = Math.max(300, Math.floor(rect.width * dpr));
    const targetH = Math.max(100, Math.floor(rect.height * dpr));
    if (visualizerCanvas.width !== targetW || visualizerCanvas.height !== targetH) {
      visualizerCanvas.width = targetW;
      visualizerCanvas.height = targetH;
    }
  }

  function drawVisualizer() {
    resizeCanvas();
    const ctx = visualizerCanvas.getContext('2d');
    const w = visualizerCanvas.width;
    const h = visualizerCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    const rows = 4;
    for (let r = 1; r < rows; r += 1) {
      const y = (h / rows) * r;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const barCount = 48;
    const gap = 3 * dpr;
    const barWidth = (w - gap * (barCount - 1)) / barCount;

    if (masterAnalyser && freqData && timeData) {
      masterAnalyser.getByteFrequencyData(freqData);
      masterAnalyser.getByteTimeDomainData(timeData);

      let maxAmp = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const norm = Math.abs((timeData[i] - 128) / 128);
        if (norm > maxAmp) maxAmp = norm;
      }
      if (maxAmp > 0.0005) {
        const db = 20 * Math.log10(maxAmp);
        peakReadout.textContent = `PEAK ${db.toFixed(1)} dB`;
      } else {
        peakReadout.textContent = 'PEAK -∞ dB';
      }

      const usableBins = Math.floor(freqData.length * 0.78);
      for (let i = 0; i < barCount; i += 1) {
        const binIndex = Math.min(
          usableBins - 1,
          Math.floor(Math.pow(i / barCount, 1.35) * usableBins)
        );
        const value = freqData[binIndex] / 255;
        const barHeight = Math.max(2 * dpr, value * (h - 14 * dpr));
        const x = i * (barWidth + gap);
        const y = h - barHeight;

        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, '#10b981');
        grad.addColorStop(0.62, '#f59e0b');
        grad.addColorStop(1, '#ef4444');

        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barWidth, barHeight);

        if (barHeight > (peakCaps[i] || 0)) {
          peakCaps[i] = barHeight;
        } else {
          peakCaps[i] = Math.max(2 * dpr, (peakCaps[i] || 0) - 0.85 * dpr);
        }
        ctx.fillStyle = '#fef3c7';
        ctx.fillRect(x, h - peakCaps[i] - 2 * dpr, barWidth, 2 * dpr);
      }
    } else {
      ctx.fillStyle = 'rgba(245, 158, 11, 0.22)';
      for (let i = 0; i < barCount; i += 1) {
        const x = i * (barWidth + gap);
        ctx.fillRect(x, h - 3 * dpr, barWidth, 3 * dpr);
      }
    }

    tracks.forEach((track) => {
      if (track.state === 'playing' && track.buffer) {
        const pos = getTrackPosition(track);
        const dur = track.buffer.duration;
        if (!track.isScrubbing) {
          track.ui.elapsedEl.textContent = formatTime(pos);
          if (dur > 0) {
            track.ui.scrubInput.value = String((pos / dur) * 1000);
          }
        }
        drawTrackWaveform(track);
      }
    });

    requestAnimationFrame(drawVisualizer);
  }

  // ---------------- Local Project Library ----------------
  function stopLibraryPreview() {
    if (libraryPreviewAudio) {
      try {
        libraryPreviewAudio.pause();
        libraryPreviewAudio.src = '';
      } catch {
        // Ignore
      }
      libraryPreviewAudio = null;
    }
    libraryPreviewId = null;
  }

  function formatBytesMB(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getStemTagLabel(stemType) {
    switch (stemType) {
      case 'lead': return 'LEAD VOCAL';
      case 'chorus': return 'CHORUS';
      case 'drums': return 'DRUMS';
      case 'bass': return 'BASS';
      case 'other': return 'MELODY';
      case 'beat': return 'AI BEAT';
      case 'voice': return 'VOCALS';
      case 'music': return 'INSTRUMENTS';
      case 'mix': return 'MIXDOWN';
      case 'crop': return 'CROPPED';
      case 'trimmed': return 'TRIMMED';
      case 'youtube': return 'YT AUDIO';
      default: return 'LOCAL';
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchLibrary({ silent = false } = {}) {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return;
      const data = await res.json();
      libraryItems = Array.isArray(data?.items) ? data.items : [];
      renderLibrary();
      populateStudioSelectors();
      renderMixVariations();
      if (!silent) {
        setStatus(`Rescanned local project library: ${libraryItems.length} file(s) ready.`, 'info');
      }
    } catch {
      // Ignore if server offline
    }
  }

  function renderLibrary() {
    if (!libraryListEl || !libraryCountBadge || !libraryEmpty) return;

    libraryCountBadge.textContent = `${libraryItems.length} SAVED IN PROJECT`;

    const filtered = libraryFilter === 'all'
      ? libraryItems
      : libraryItems.filter((item) => item.stemType === libraryFilter);

    libraryListEl.innerHTML = '';
    if (!filtered.length) {
      libraryEmpty.hidden = false;
      libraryEmpty.innerHTML = libraryItems.length
        ? `No <strong>${escapeHtml(libraryFilter.toUpperCase())}</strong> files in library yet.`
        : 'No extracted files in project yet — any YouTube URL, Voice Only, Music Only, or saved crop will stay stored locally in <code>./library/</code> across restarts.';
      return;
    }

    libraryEmpty.hidden = true;
    for (const item of filtered) {
      const row = document.createElement('div');
      row.className = 'library-item';

      const sizeText = formatBytesMB(item.sizeBytes);
      const durText = Number.isFinite(item.durationSec) && item.durationSec > 0 ? formatTime(item.durationSec) : '';
      const pathHint = item.stemFolder
        ? `./${item.stemFolder}`
        : (item.relPath && item.relPath.includes('/') ? `./library/${item.relPath.split('/').slice(0, -1).join('/')}` : (item.folder === 'downloads' ? './downloads' : './library'));
      const metaParts = [durText, sizeText, pathHint].filter(Boolean);
      const isPreviewing = libraryPreviewId === item.id;
      const dlUrl = `/api/library/${encodeURIComponent(item.id)}/audio?download=1`;

      row.innerHTML = `
        <div class="lib-item-main">
          <div class="lib-item-top">
            <span class="lib-stem-tag ${escapeHtml(item.stemType || 'local')}">${getStemTagLabel(item.stemType)}</span>
            <span class="lib-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
          </div>
          <div class="lib-item-meta">${escapeHtml(metaParts.join(' • '))}</div>
        </div>
        <div class="lib-item-actions">
          <button type="button" class="btn-lib-preview ${isPreviewing ? 'playing' : ''}" title="Preview file">${isPreviewing ? '■' : '▶'}</button>
          <button type="button" class="btn-lib-load" title="Load into selected track">⬇ LOAD</button>
          <a class="btn-lib-dl" href="${dlUrl}" download="${escapeHtml(item.filename || 'stem.wav')}" title="Download stem file (${escapeHtml(item.filename || '')})">⤓ WAV</a>
          <button type="button" class="btn-lib-del" title="Delete from project disk">✕</button>
        </div>
      `;

      row.querySelector('.btn-lib-preview').addEventListener('click', () => previewLibraryItem(item));
      row.querySelector('.btn-lib-load').addEventListener('click', () => loadLibraryItemIntoTrack(item));
      row.querySelector('.btn-lib-del').addEventListener('click', () => deleteLibraryItem(item));

      libraryListEl.appendChild(row);
    }
  }

  function previewLibraryItem(item) {
    if (libraryPreviewId === item.id) {
      stopLibraryPreview();
      renderLibrary();
      return;
    }
    stopPreview();
    stopLibraryPreview();

    const audio = new Audio(`/api/library/${encodeURIComponent(item.id)}/audio`);
    libraryPreviewAudio = audio;
    libraryPreviewId = item.id;
    audio.onended = () => {
      if (libraryPreviewId === item.id) {
        stopLibraryPreview();
        renderLibrary();
      }
    };
    audio.onerror = () => {
      stopLibraryPreview();
      renderLibrary();
      setStatus(`Failed to preview "${item.title}".`, 'error');
    };
    audio.play().catch(() => {});
    renderLibrary();
  }

  async function loadLibraryItemIntoTrack(item) {
    const targetVal = libraryTargetSelect ? libraryTargetSelect.value : 'auto';
    let slot = targetVal === 'auto' ? findFirstEmptyTrack() : (tracks[parseInt(targetVal, 10)] || null);
    if (!slot) {
      setStatus('All 4 tracks are full. Pick a specific Track 01–04 next to "LOAD TO" or clear (✕) a deck.', 'error');
      return;
    }

    stopLibraryPreview();
    setStatus(`Loading "${item.title}" from project library into Track 0${slot.index + 1}...`, 'info');
    try {
      await ensureAudioEngine();
      const res = await fetch(`/api/library/${encodeURIComponent(item.id)}/audio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arr);

      loadBufferIntoTrack(slot, decoded, item.title, {
        sourceUrl: item.sourceUrl || '',
        libraryId: item.id || null
      });
      if (item.stemType === 'lead') {
        slot.stemMode = 'lead';
        slot.voiceExtracted = true;
      } else if (item.stemType === 'chorus') {
        slot.stemMode = 'chorus';
      } else if (item.stemType === 'voice') {
        slot.stemMode = 'voice';
        slot.voiceExtracted = true;
      } else if (item.stemType === 'music') {
        slot.stemMode = 'music';
        slot.musicExtracted = true;
      } else if (item.stemType === 'beat') {
        slot.stemMode = 'beat';
      } else if (item.stemType === 'crop') {
        slot.croppedRegion = true;
      }
      if (item.styleProfile) {
        currentStyleProfile = item.styleProfile;
        currentStyleRefTitle = item.title;
        renderStyleDnaBadge();
        renderMixVariations();
      }
      renderTrackUI(slot);
      drawTrackWaveform(slot);
      setStatus(`Loaded "${item.title}" into Track 0${slot.index + 1} from project library.`, 'success');
    } catch (err) {
      console.error('Library load failed:', err);
      setStatus(`Could not load "${item.title}" from project library.`, 'error');
    }
  }

  async function deleteLibraryItem(item) {
    if (libraryPreviewId === item.id) {
      stopLibraryPreview();
    }
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchLibrary({ silent: true });
      setStatus(`Removed "${item.title}" from local project disk.`, 'info');
    } catch (err) {
      console.error('Delete library item failed:', err);
      setStatus(`Failed to remove "${item.title}".`, 'error');
    }
  }

  if (libraryFilterBtns.length) {
    libraryFilterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        libraryFilter = btn.dataset.filter || 'all';
        libraryFilterBtns.forEach((b) => b.classList.toggle('active', b === btn));
        renderLibrary();
      });
    });
  }

  if (libraryRefreshBtn) {
    libraryRefreshBtn.addEventListener('click', () => fetchLibrary({ silent: false }));
  }

  if (libraryToggleBtn && libraryBody) {
    libraryToggleBtn.addEventListener('click', () => {
      const isHidden = libraryBody.hidden;
      libraryBody.hidden = !isHidden;
      libraryToggleBtn.setAttribute('aria-expanded', String(isHidden));
      libraryToggleBtn.textContent = isHidden ? '▾ HIDE' : '▸ SHOW';
    });
  }

  // ---------------- Component Mix Studio & Variations ----------------
  const decodeLibraryAudioBuffer = async (libraryId) => {
    const res = await fetch(`/api/library/${encodeURIComponent(libraryId)}/audio`);
    if (!res.ok) throw new Error(`Failed loading stem ${libraryId} (HTTP ${res.status})`);
    return audioCtx.decodeAudioData(await res.arrayBuffer());
  };

  function renderStyleDnaBadge() {
    if (!studioDnaBadge) return;
    if (!currentStyleProfile) {
      studioDnaBadge.textContent = 'NO STYLE ANALYZED';
      return;
    }
    const sp = currentStyleProfile;
    const swingPct = Math.round((Number(sp.swingRatio) || 0.12) * 100);
    studioDnaBadge.textContent = `${sp.bpm || 84} BPM • ${sp.keyName || 'F'} ${sp.scale || 'minor'} • SWING ${swingPct}%`;
  }

  function fillComponentSelect(selectEl, items, emptyLabel, preferredTypes) {
    if (!selectEl) return;
    const prevVal = selectEl.value;
    const ranked = [...items].sort((a, b) => {
      const aRank = preferredTypes.indexOf(a.stemType);
      const bRank = preferredTypes.indexOf(b.stemType);
      const ra = aRank === -1 ? 99 : aRank;
      const rb = bRank === -1 ? 99 : bRank;
      return ra - rb;
    });

    selectEl.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>`;
    for (const it of ranked) {
      const opt = document.createElement('option');
      opt.value = it.id;
      const tag = getStemTagLabel(it.stemType);
      opt.textContent = `[${tag}] ${it.title}`;
      selectEl.appendChild(opt);
    }

    if (prevVal && ranked.some((it) => it.id === prevVal)) {
      selectEl.value = prevVal;
    } else if (!prevVal) {
      const firstPreferred = ranked.find((it) => preferredTypes.includes(it.stemType));
      if (firstPreferred) {
        selectEl.value = firstPreferred.id;
      }
    }
  }

  function populateStudioSelectors() {
    fillComponentSelect(studioLeadSelect, libraryItems, '(None — pick Lead / Voice stem)', ['lead', 'voice', 'crop']);
    fillComponentSelect(studioChorusSelect, libraryItems, '(None — pick Chorus / Backing stem)', ['chorus', 'voice', 'crop']);
    fillComponentSelect(studioRefSelect, libraryItems, '(Pick Ref Lo-Fi / Instruments)', ['music', 'drums', 'bass', 'beat', 'youtube', 'local']);

    if (!currentStyleProfile && studioRefSelect?.value) {
      const refItem = libraryItems.find((it) => it.id === studioRefSelect.value && it.styleProfile)
        || libraryItems.find((it) => it.styleProfile);
      if (refItem?.styleProfile) {
        currentStyleProfile = refItem.styleProfile;
        currentStyleRefTitle = refItem.title;
        renderStyleDnaBadge();
      }
    }
  }

  function autoSelectStudioComponents({ leadId = null, chorusId = null, refId = null } = {}) {
    if (leadId && studioLeadSelect && Array.from(studioLeadSelect.options).some((o) => o.value === leadId)) {
      studioLeadSelect.value = leadId;
    }
    if (chorusId && studioChorusSelect && Array.from(studioChorusSelect.options).some((o) => o.value === chorusId)) {
      studioChorusSelect.value = chorusId;
    }
    if (refId && studioRefSelect && Array.from(studioRefSelect.options).some((o) => o.value === refId)) {
      studioRefSelect.value = refId;
    }
    renderMixVariations();
  }

  function buildBuiltInMixVariations() {
    const leadId = studioLeadSelect?.value || '';
    const chorusId = studioChorusSelect?.value || '';
    const refId = studioRefSelect?.value || '';
    const pitchShift = parseInt(studioLeadPitchSelect?.value || '0', 10) || 0;
    const sp = currentStyleProfile || { bpm: 84, keyIndex: 5, scale: 'mohanam', warmthCutoffHz: 2200 };

    const refItem = libraryItems.find((it) => it.id === refId);
    const hasCleanInstStem = refItem && ['music', 'other', 'bass', 'drums'].includes(refItem.stemType);

    return [
      {
        id: 'var-style-pocket',
        name: '1. Lead + Ref Style Lo-Fi Pocket',
        vibe: 'STYLE CLONE',
        isAi: false,
        summary: 'Your Lead Vocal over freshly generated boom-bap groove, warm bass & Rhodes modeled from the reference BPM, key, and swing.',
        leadStemId: leadId,
        chorusStemId: '',
        instrumentsStemId: '',
        beatMode: 'lofi_clone',
        bpm: Math.round(sp.bpm || 84),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: sp.scale || 'mohanam',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.92,
        leadLofi: false,
        leadReverb: 0.28,
        chorusVolume: 0,
        chorusReverb: 0.45,
        instrumentsVolume: 0,
        instrumentsLofi: false,
        beatVolume: 0.8,
        beatLofi: false,
        beatReverb: 0.2
      },
      {
        id: 'var-lead-chorus-sub',
        name: '2. Lead + Chorus + Groove Drums & Sub',
        vibe: 'VOCAL FOCUS',
        isAi: false,
        summary: 'Layers extracted Lead Vocal + spacious Chorus harmonies over crisp style-matched Drums & Sub Bass (no competing chords).',
        leadStemId: leadId,
        chorusStemId: chorusId,
        instrumentsStemId: '',
        beatMode: 'pure_drums_bass',
        bpm: Math.round(sp.bpm || 84),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: sp.scale || 'mohanam',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.92,
        leadLofi: false,
        leadReverb: 0.24,
        chorusVolume: 0.65,
        chorusReverb: 0.5,
        instrumentsVolume: 0,
        instrumentsLofi: false,
        beatVolume: 0.82,
        beatLofi: false,
        beatReverb: 0.15
      },
      {
        id: 'var-vocal-swap-ref',
        name: '3. Cross-Track Vocal Swap + Ref Inst',
        vibe: hasCleanInstStem ? 'STEM SWAP' : 'AUTO SWAP',
        isAi: false,
        summary: 'Places selected Lead & Chorus cleanly atop the reference track\'s clean neural Instruments + subtle sub-groove reinforcement.',
        leadStemId: leadId,
        chorusStemId: chorusId,
        instrumentsStemId: refId,
        beatMode: 'pure_drums_bass',
        bpm: Math.round(sp.bpm || 84),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: sp.scale || 'mohanam',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.94,
        leadLofi: false,
        leadReverb: 0.3,
        chorusVolume: 0.58,
        chorusReverb: 0.48,
        instrumentsVolume: 0.72,
        instrumentsLofi: false,
        beatVolume: 0.42,
        beatLofi: true,
        beatReverb: 0.12
      },
      {
        id: 'var-carnatic-fusion',
        name: '4. Carnatic Mridangam & Tanpura Flip',
        vibe: 'CARNATIC LO-FI',
        isAi: false,
        summary: 'Fuses Lead & Chorus with synthesized Tanpura jawari drone, Mridangam patterns, dusty Rhodes, and reference-synced boom-bap.',
        leadStemId: leadId,
        chorusStemId: chorusId,
        instrumentsStemId: '',
        beatMode: 'carnatic_lofi_flip',
        bpm: Math.round(sp.bpm || 84),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: ['mohanam', 'kalyani', 'mayamalavagowla', 'charukesi'].includes(sp.scale) ? sp.scale : 'mohanam',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.92,
        leadLofi: false,
        leadReverb: 0.34,
        chorusVolume: 0.6,
        chorusReverb: 0.52,
        instrumentsVolume: 0,
        instrumentsLofi: false,
        beatVolume: 0.78,
        beatLofi: false,
        beatReverb: 0.25
      },
      {
        id: 'var-deep-house',
        name: '5. Deep Soulful Chill House Flip',
        vibe: 'SOUL HOUSE',
        isAi: false,
        summary: 'Lifts Lead & Chorus onto a warm 4-on-the-floor deep house bassline & electric piano chord groove tuned to the reference key.',
        leadStemId: leadId,
        chorusStemId: chorusId,
        instrumentsStemId: '',
        beatMode: 'deep_chill_house',
        bpm: Math.max(108, Math.min(124, (sp.bpm || 84) < 95 ? Math.round((sp.bpm || 84) * 1.35) : Math.round(sp.bpm || 118))),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: sp.scale || 'minor',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.92,
        leadLofi: false,
        leadReverb: 0.32,
        chorusVolume: 0.62,
        chorusReverb: 0.55,
        instrumentsVolume: 0,
        instrumentsLofi: false,
        beatVolume: 0.8,
        beatLofi: false,
        beatReverb: 0.22
      },
      {
        id: 'var-midnight-pad',
        name: '6. Midnight Acapella & Half-Time Pad',
        vibe: 'AMBIENT RAIN',
        isAi: false,
        summary: 'Intimate low-passed Lead vocal floats with wide reverb Chorus over sparse half-time pulse, warm pad & vinyl rain.',
        leadStemId: leadId,
        chorusStemId: chorusId,
        instrumentsStemId: '',
        beatMode: 'halftime_ambient',
        bpm: Math.round(sp.bpm || 78),
        keyIndex: Number.isInteger(sp.keyIndex) ? sp.keyIndex : 5,
        scale: sp.scale || 'minor',
        leadPitchSemitones: pitchShift,
        leadVolume: 0.9,
        leadLofi: true,
        leadReverb: 0.44,
        chorusVolume: 0.68,
        chorusReverb: 0.65,
        instrumentsVolume: 0,
        instrumentsLofi: false,
        beatVolume: 0.72,
        beatLofi: false,
        beatReverb: 0.35
      }
    ];
  }

  function renderMixVariations() {
    if (!mixVariationsGrid) return;
    const allRecipes = [...buildBuiltInMixVariations(), ...aiMixVariations];
    mixVariationsGrid.innerHTML = '';

    for (const recipe of allRecipes) {
      const card = document.createElement('div');
      card.className = `mix-card${recipe.isAi ? ' ai-card' : ''}${activeVariationKey === recipe.id ? ' active' : ''}`;
      const keyLabel = (window.LofiGenerator.NOTE_NAMES && window.LofiGenerator.NOTE_NAMES[recipe.keyIndex]) || 'F';
      const activeParts = [
        recipe.leadStemId ? 'Lead' : null,
        recipe.chorusStemId ? 'Chorus' : null,
        recipe.instrumentsStemId ? 'Ref Inst' : null,
        recipe.beatMode ? `${recipe.bpm} BPM ${keyLabel} ${recipe.scale}` : null
      ].filter(Boolean);

      card.innerHTML = `
        <div>
          <div class="mix-card-top">
            <span class="mix-card-title">${escapeHtml(recipe.name)}</span>
            <span class="mix-card-vibe">${escapeHtml(recipe.vibe)}</span>
          </div>
          <p class="mix-card-desc">${escapeHtml(recipe.summary)}</p>
        </div>
        <div>
          <div class="mix-card-meta">${escapeHtml(activeParts.join(' • ') || 'Pick components above')}</div>
          <button type="button" class="btn-mix-apply">▶ BUILD &amp; PLAY MIX</button>
        </div>
      `;

      card.querySelector('.btn-mix-apply').addEventListener('click', () => applyMixRecipe(recipe));
      mixVariationsGrid.appendChild(card);
    }
  }

  async function applyMixRecipe(recipe) {
    if (!recipe) return;
    try {
      await ensureAudioEngine();
      stopAllTracks();
      activeVariationKey = recipe.id || recipe.name;
      renderMixVariations();

      setStatus(`Building mix variation "${recipe.name}"...`, 'info');
      const getItem = (id) => libraryItems.find((it) => it.id === id);

      // Clear all 4 decks before building clean staged mix
      tracks.forEach((t) => clearTrack(t));

      let nextSlot = 0;

      // Track 01: Lead Vocal
      if (recipe.leadStemId) {
        const leadItem = getItem(recipe.leadStemId);
        if (leadItem) {
          const buf = await decodeLibraryAudioBuffer(leadItem.id);
          const t = tracks[nextSlot++];
          loadBufferIntoTrack(t, buf, leadItem.title, { sourceUrl: leadItem.sourceUrl || '' });
          t.stemMode = leadItem.stemType === 'lead' ? 'lead' : 'voice';
          t.voiceExtracted = true;
          t.volume = Number.isFinite(recipe.leadVolume) ? recipe.leadVolume : 0.92;
          t.pitchSemitones = Number.isFinite(recipe.leadPitchSemitones) ? recipe.leadPitchSemitones : 0;
          t.lofiEnabled = Boolean(recipe.leadLofi);
          t.reverbMix = Number.isFinite(recipe.leadReverb) ? recipe.leadReverb : 0.28;
          initTrackAudioNodes(t);
          updateTrackVolume(t);
          updateTrackPitchAndTuner(t);
          updateTrackFilter(t);
          updateTrackReverb(t);
          renderTrackUI(t);
          drawTrackWaveform(t);
        }
      }

      // Track 02: Chorus / Harmony
      if (recipe.chorusStemId && nextSlot < TRACK_COUNT) {
        const chItem = getItem(recipe.chorusStemId);
        if (chItem) {
          const buf = await decodeLibraryAudioBuffer(chItem.id);
          const t = tracks[nextSlot++];
          loadBufferIntoTrack(t, buf, chItem.title, { sourceUrl: chItem.sourceUrl || '' });
          t.stemMode = chItem.stemType === 'chorus' ? 'chorus' : 'voice';
          t.volume = Number.isFinite(recipe.chorusVolume) ? recipe.chorusVolume : 0.62;
          t.pitchSemitones = Number.isFinite(recipe.leadPitchSemitones) ? recipe.leadPitchSemitones : 0;
          t.doublerEnabled = true;
          t.reverbMix = Number.isFinite(recipe.chorusReverb) ? recipe.chorusReverb : 0.48;
          initTrackAudioNodes(t);
          updateTrackVolume(t);
          updateTrackPitchAndTuner(t);
          updateTrackReverb(t);
          renderTrackUI(t);
          drawTrackWaveform(t);
        }
      }

      // Optional: Extracted Reference Instruments Stem
      if (recipe.instrumentsStemId && nextSlot < TRACK_COUNT) {
        const instItem = getItem(recipe.instrumentsStemId);
        if (instItem) {
          const buf = await decodeLibraryAudioBuffer(instItem.id);
          const t = tracks[nextSlot++];
          loadBufferIntoTrack(t, buf, instItem.title, { sourceUrl: instItem.sourceUrl || '' });
          t.stemMode = 'music';
          t.musicExtracted = true;
          t.volume = Number.isFinite(recipe.instrumentsVolume) ? recipe.instrumentsVolume : 0.7;
          t.lofiEnabled = Boolean(recipe.instrumentsLofi);
          initTrackAudioNodes(t);
          updateTrackVolume(t);
          updateTrackFilter(t);
          renderTrackUI(t);
          drawTrackWaveform(t);
        }
      }

      // Synthesized Style-Matched Lo-Fi Beat / Backing
      if (recipe.beatMode && nextSlot < TRACK_COUNT) {
        const t = tracks[nextSlot++];
        const bars = Math.max(2, Math.min(8, parseInt(genBarsSelect?.value || '4', 10) || 4));
        const generated = await window.LofiGenerator.generateStyleMatchedSample({
          styleProfile: currentStyleProfile || {},
          styleMode: recipe.beatMode,
          bpmOverride: recipe.bpm,
          keyOverride: recipe.keyIndex,
          scaleOverride: recipe.scale,
          bars,
          referenceLabel: currentStyleRefTitle || 'Reference Lo-Fi'
        });
        loadBufferIntoTrack(t, generated.buffer, generated.title, {});
        t.stemMode = 'beat';
        t.loop = true;
        t.volume = Number.isFinite(recipe.beatVolume) ? recipe.beatVolume : 0.8;
        t.lofiEnabled = Boolean(recipe.beatLofi);
        t.reverbMix = Number.isFinite(recipe.beatReverb) ? recipe.beatReverb : 0.2;
        initTrackAudioNodes(t);
        updateTrackVolume(t);
        updateTrackFilter(t);
        updateTrackReverb(t);
        renderTrackUI(t);
        drawTrackWaveform(t);
      }

      // Start synchronized playback of all staged remix tracks
      for (const t of tracks) {
        if (t.buffer) {
          await playTrack(t);
        }
      }

      setStatus(`Playing "${recipe.name}" across active tracks! Tweak sliders or click another card to compare.`, 'success');
    } catch (err) {
      console.error('Failed building mix variation:', err);
      setStatus(`Could not build "${recipe.name}": ${err.message}`, 'error');
    }
  }

  async function analyzeSelectedStyle() {
    const refId = studioRefSelect?.value || '';
    if (!refId) {
      setStatus('Select a Reference Track / Instruments stem in the Component Studio first.', 'error');
      return;
    }
    const item = libraryItems.find((it) => it.id === refId);
    if (!item) return;

    if (studioAnalyzeBtn) studioAnalyzeBtn.disabled = true;
    setStatus(`Analyzing BPM, Key, Raga & Drum Groove from "${item.title}"...`, 'info');
    try {
      const needsSep = ['youtube', 'local', 'crop'].includes(item.stemType);
      const res = await fetch('/api/analyze-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libraryId: item.id,
          separateFirst: needsSep,
          startSec: 20,
          clipDurationSec: 32
        })
      });
      if (!res.ok) {
        const errP = await res.json().catch(() => ({}));
        throw new Error(errP.details || errP.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.styleProfile) {
        currentStyleProfile = data.styleProfile;
        currentStyleRefTitle = item.title;
        renderStyleDnaBadge();
      }
      await fetchLibrary({ silent: true });
      if (data.stems?.music?.id) {
        autoSelectStudioComponents({ refId: data.stems.music.id });
      } else {
        renderMixVariations();
      }
      setStatus(
        `Style DNA extracted: ${data.styleProfile?.bpm} BPM, ${data.styleProfile?.keyName} ${data.styleProfile?.scale}. Mix variations updated!`,
        'success'
      );
    } catch (err) {
      console.error('Analyze style error:', err);
      setStatus(`Style analysis failed: ${err.message}`, 'error');
    } finally {
      if (studioAnalyzeBtn) studioAnalyzeBtn.disabled = false;
    }
  }

  async function generateBeatFromStudio() {
    if (!currentStyleProfile) {
      await analyzeSelectedStyle();
      if (!currentStyleProfile) return;
    }
    try {
      await ensureAudioEngine();
      const slot = findFirstEmptyTrack() || tracks[3];
      const styleMode = ytSampleStyleModeSelect?.value || 'lofi_clone';
      const bars = Math.max(2, Math.min(8, parseInt(genBarsSelect?.value || '4', 10) || 4));
      const generated = await window.LofiGenerator.generateStyleMatchedSample({
        styleProfile: currentStyleProfile,
        styleMode,
        bars,
        referenceLabel: currentStyleRefTitle || 'Reference Lo-Fi'
      });
      loadBufferIntoTrack(slot, generated.buffer, generated.title, {});
      slot.stemMode = 'beat';
      slot.loop = true;
      renderTrackUI(slot);
      drawTrackWaveform(slot);
      await saveBufferToLibrary(generated.buffer, { title: generated.title, stemType: 'beat', silent: true });
      setStatus(`Generated style-matched beat "${generated.title}" -> Track 0${slot.index + 1}.`, 'success');
    } catch (err) {
      console.error('Studio beat generation failed:', err);
      setStatus(`Could not generate beat: ${err.message}`, 'error');
    }
  }

  async function askGeminiMixVariations() {
    if (!libraryItems.length) {
      setStatus('Extract or decompose tracks into components first so Gemini can build variations.', 'error');
      return;
    }
    const apiKey = geminiApiKeyInput ? geminiApiKeyInput.value.trim() : '';
    const prompt = remixGlobalPromptInput ? remixGlobalPromptInput.value.trim() : '';
    if (studioAiVarsBtn) {
      studioAiVarsBtn.disabled = true;
      studioAiVarsBtn.classList.add('loading');
    }
    setStatus('Asking Gemini to design 4 custom mix variations from your extracted Lead, Chorus & Instruments...', 'info');
    try {
      const components = libraryItems.slice(0, 24).map((it) => ({
        id: it.id,
        title: it.title,
        stemType: it.stemType,
        durationSec: it.durationSec,
        rms: it.rms || null
      }));
      const res = await fetch('/api/mix-variations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, prompt, components, styleProfile: currentStyleProfile })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || `HTTP ${res.status}`);
      }
      aiMixVariations = (data.variations || []).map((v, i) => ({
        ...v,
        id: `ai-var-${Date.now()}-${i}`,
        isAi: true
      }));
      renderMixVariations();
      setStatus(`Gemini (${data.model}) generated ${aiMixVariations.length} custom mix variations below!`, 'success');
    } catch (err) {
      console.error('Gemini variations error:', err);
      setStatus(`Gemini mix variations failed: ${err.message}`, 'error');
    } finally {
      if (studioAiVarsBtn) {
        studioAiVarsBtn.disabled = false;
        studioAiVarsBtn.classList.remove('loading');
      }
    }
  }

  if (studioLeadSelect) studioLeadSelect.addEventListener('change', renderMixVariations);
  if (studioChorusSelect) studioChorusSelect.addEventListener('change', renderMixVariations);
  if (studioRefSelect) studioRefSelect.addEventListener('change', () => {
    const it = libraryItems.find((x) => x.id === studioRefSelect.value);
    if (it?.styleProfile) {
      currentStyleProfile = it.styleProfile;
      currentStyleRefTitle = it.title;
      renderStyleDnaBadge();
    }
    renderMixVariations();
  });
  if (studioLeadPitchSelect) studioLeadPitchSelect.addEventListener('change', renderMixVariations);
  if (studioAnalyzeBtn) studioAnalyzeBtn.addEventListener('click', analyzeSelectedStyle);
  if (studioGenBeatBtn) studioGenBeatBtn.addEventListener('click', generateBeatFromStudio);
  if (studioAiVarsBtn) studioAiVarsBtn.addEventListener('click', askGeminiMixVariations);

  for (let i = 0; i < TRACK_COUNT; i += 1) {
    buildTrackCard(i);
  }

  renderStyleDnaBadge();
  renderMixVariations();
  checkGeminiStatus();
  checkStemEngineStatus();
  fetchLibrary({ silent: true });
  window.addEventListener('resize', resizeCanvas);
  requestAnimationFrame(drawVisualizer);
})();
